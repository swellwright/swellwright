import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { AppModule, type AppOptions } from './app.module.js';
import { type AppConfig } from './config.js';
import { API_PREFIX } from './contract-route.js';
import {
  ApiExceptionFilter,
  bodyParserErrors,
  ContractRequestInterceptor,
  ContractResponseInterceptor,
  requestContext,
} from './http.js';

/**
 * What the browser may load for the console: everything from this origin, styles may be inline (React sets
 * `style` attributes), no plugins, no framing, forms only to this origin.
 */
export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers for the files of the console: the page is never cached, the hashed assets always are. */
export function consoleHeaders(
  res: { setHeader(name: string, value: string): unknown },
  filePath: string,
): void {
  if (filePath.endsWith(`${sep}index.html`)) {
    res.setHeader('cache-control', 'no-cache');
  } else if (filePath.includes(`${sep}assets${sep}`)) {
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('cache-control', 'public, max-age=3600');
  }
  res.setHeader('content-security-policy', CONSOLE_CSP);
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
}

/**
 * Whether a request is a browser asking for a page of the console (a deep link such as
 * `/dashboard/security/users`) and so gets `index.html`, and the router in the browser takes it from there.
 * Only GET and HEAD, only what is not the API (`/api/...` keeps its JSON 404), not a file (a dot in the last
 * segment: a missing `/favicon.svg` is a 404, not a page) and not the folder of the hashed assets, and only
 * for clients that accept HTML (`Accept: application/json` gets the 404).
 */
export function isConsolePage(req: Pick<Request, 'method' | 'path' | 'accepts'>): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }
  let path: string;
  try {
    path = decodeURIComponent(req.path);
  } catch {
    return false;
  }
  if (
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/assets' ||
    path.startsWith('/assets/')
  ) {
    return false;
  }
  const segments = path.split('/');
  // `..` and `.` are never a page; a dot in the last segment means a file; a NUL or a backslash is no path.
  if (
    segments.includes('..') ||
    segments.includes('.') ||
    path.includes('\\') ||
    path.includes('\0')
  ) {
    return false;
  }
  if ((segments.at(-1) ?? '').includes('.')) {
    return false;
  }
  return req.accepts('html') !== false;
}

/** Builds the application with every cross-cutting piece wired. Used by `main` and by the tests. */
export async function createApp(
  config: AppConfig,
  options: AppOptions = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, options),
    // Nest declares its options as classes and documents a plain object as the way to pass them.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment
    {
      logger: config.silent ? false : ['log', 'warn', 'error'],
      // The JSON parser is registered below with a limit a plugin's request through the gateway fits in.
      bodyParser: false,
    },
  );
  app.disable('x-powered-by');
  // Behind a reverse proxy the address of the connection is the proxy's. Only the proxies named in the
  // configuration may say who the client is, or anyone could write any address into the audit chain.
  app.set('trust proxy', config.trustProxy);
  // The request id and the safe headers come first, so that even a body that cannot be read is answered with them.
  app.use(requestContext);
  app.useBodyParser('json', { limit: '3mb' });
  app.use(bodyParserErrors);
  if (config.webDir) {
    if (!existsSync(join(config.webDir, 'index.html'))) {
      throw new Error(`SW_WEB_DIR has no index.html: ${config.webDir}`);
    }
    // Before the API routes: a file that exists is served, everything else falls through to them.
    app.useStaticAssets(config.webDir, { index: 'index.html', setHeaders: consoleHeaders });
    // The console has real URLs, so a deep link must open the page, not a 404. No API route lives outside
    // `/api`, so this cannot take a request away from one.
    const webDir = config.webDir;
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!isConsolePage(req)) {
        next();
        return;
      }
      consoleHeaders(res, join(webDir, 'index.html'));
      res.sendFile('index.html', { root: webDir }, (error) => {
        if (error && !res.headersSent) {
          next(error);
        }
      });
    });
  }
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ApiExceptionFilter());
  // Requests are always checked against the contract; responses only where drift is cheap to catch.
  app.useGlobalInterceptors(
    new ContractRequestInterceptor(),
    ...(config.validateResponses ? [new ContractResponseInterceptor()] : []),
  );
  if (config.authKeyEphemeral && config.databaseUrl && !config.silent) {
    new Logger('Config').warn(
      'SW_AUTH_KEY is not set: a temporary key is used, so authenticator secrets stop working when the process restarts.',
    );
  }
  app.enableShutdownHooks();
  return app;
}
