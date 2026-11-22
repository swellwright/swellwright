import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

import { buildConsoleFixtures, type ConsoleFixtures, consoleRoute } from './console-fixtures.js';
import { buildFixtures, FAKE_TOKEN, type FixtureOptions, type PanelFixtures } from './fixtures.js';

// A panel that lives in the process (ADR 0041). It answers the read endpoints of the Remnawave API 3.4 from synthetic
// fixtures, checks the Bearer token, and can be told to misbehave: refuse, throttle, fail with a 5xx, answer slowly,
// hang, hang up, answer with a page instead of JSON, redirect, send more than allowed, or answer in another shape.
// It speaks plain http on a loopback port: the client under test is configured to allow that explicitly.

export type Behaviour =
  | {
      readonly kind: 'status';
      readonly status: number;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'delay'; readonly ms: number }
  | { readonly kind: 'hang' }
  | { readonly kind: 'drop' }
  | {
      readonly kind: 'raw';
      readonly body: string;
      readonly contentType?: string;
      readonly status?: number;
    }
  | { readonly kind: 'redirect'; readonly location: string; readonly status?: number }
  | { readonly kind: 'large'; readonly bytes: number; readonly chunked?: boolean }
  | { readonly kind: 'replace'; readonly body: unknown };

export type Match = string | RegExp | ((path: string) => boolean);

interface Injection {
  readonly match: Match;
  readonly behaviour: Behaviour;
  remaining: number;
}

export interface RecordedRequest {
  readonly method: string;
  /** Path and query, as sent. */
  readonly path: string;
  readonly authorization: 'valid' | 'invalid' | 'missing';
  readonly at: number;
}

export interface FakePanelOptions extends FixtureOptions {
  /** The token that is accepted. A fixed fake one by default. */
  readonly token?: string;
  /** The port; 0 (the default) picks a free one. */
  readonly port?: number;
  /** Let `GET /api/tokens` through, as the panel does for an administrator session but not for an API token. */
  readonly adminSession?: boolean;
}

const matches = (match: Match, path: string): boolean =>
  typeof match === 'string'
    ? path === match
    : typeof match === 'function'
      ? match(path)
      : match.test(path);

const equalText = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export class FakePanel {
  readonly fixtures: PanelFixtures;
  /** The people, devices and requests the API console can read (`console-fixtures.ts`). */
  readonly consoleFixtures: ConsoleFixtures = buildConsoleFixtures();
  readonly requests: RecordedRequest[] = [];
  private readonly injections: Injection[] = [];
  private readonly sockets = new Set<Socket>();
  private currentToken: string;
  private readonly adminSession: boolean;
  private active = 0;
  /** The most requests that were being served at the same time. */
  peakConcurrency = 0;

  private constructor(
    private readonly server: Server,
    readonly url: string,
    options: FakePanelOptions,
  ) {
    this.fixtures = buildFixtures(options);
    this.currentToken = options.token ?? FAKE_TOKEN;
    this.adminSession = options.adminSession === true;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    server.on('request', (req, res) => {
      this.active += 1;
      this.peakConcurrency = Math.max(this.peakConcurrency, this.active);
      res.on('close', () => {
        this.active -= 1;
      });
      void this.handle(req, res);
    });
  }

  static async start(options: FakePanelOptions = {}): Promise<FakePanel> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The fake panel has no address.');
    }
    return new FakePanel(server, `http://127.0.0.1:${String(address.port)}`, options);
  }

  get token(): string {
    return this.currentToken;
  }

  /** From now on only this token is accepted: the old one is revoked. */
  setToken(token: string): void {
    this.currentToken = token;
  }

  setVersion(version: string): void {
    this.fixtures.metadata['version'] = version;
  }

  /** Makes matching requests behave in this way, `times` times (always when not given). */
  inject(match: Match, behaviour: Behaviour, times = Number.POSITIVE_INFINITY): void {
    this.injections.push({ match, behaviour, remaining: times });
  }

  /** The token has no scope for these paths: the panel answers 403. */
  forbid(...paths: string[]): void {
    for (const path of paths) {
      this.inject(path, {
        kind: 'status',
        status: 403,
        body: { message: 'Forbidden resource', error: 'Forbidden', statusCode: 403 },
      });
    }
  }

  clearInjections(): void {
    this.injections.length = 0;
  }

  /** Requests to a path (query included in the match) so far. */
  countRequests(path: string | RegExp): number {
    return this.requests.filter((r) => matches(path, r.path.split('?')[0] ?? '')).length;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  // ---- serving ---------------------------------------------------------------------------------------------------

  private authorization(req: IncomingMessage): RecordedRequest['authorization'] {
    const header = req.headers.authorization;
    if (header === undefined) {
      return 'missing';
    }
    return equalText(header, `Bearer ${this.currentToken}`) ? 'valid' : 'invalid';
  }

  private takeInjection(path: string): Behaviour | undefined {
    for (const injection of this.injections) {
      if (injection.remaining > 0 && matches(injection.match, path)) {
        injection.remaining -= 1;
        return injection.behaviour;
      }
    }
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '/';
    const [path = '/', query = ''] = raw.split('?');
    const authorization = this.authorization(req);
    this.requests.push({ method: req.method ?? '', path: raw, authorization, at: Date.now() });

    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        ...headers,
      });
      res.end(text);
    };

    if (req.method !== 'GET') {
      send(405, { message: 'Method Not Allowed', statusCode: 405 });
      return;
    }
    const behaviour = this.takeInjection(path);
    if (authorization !== 'valid' && behaviour?.kind !== 'raw') {
      send(401, { statusCode: 401, message: 'Unauthorized' });
      return;
    }
    let delayed = 0;
    if (behaviour) {
      switch (behaviour.kind) {
        case 'status':
          send(
            behaviour.status,
            behaviour.body ?? { message: 'injected', statusCode: behaviour.status },
            behaviour.headers,
          );
          return;
        case 'hang':
          return;
        case 'drop':
          req.socket.destroy();
          return;
        case 'raw':
          res.writeHead(behaviour.status ?? 200, {
            'content-type': behaviour.contentType ?? 'application/json',
          });
          res.end(behaviour.body);
          return;
        case 'redirect':
          res.writeHead(behaviour.status ?? 302, { location: behaviour.location });
          res.end();
          return;
        case 'large': {
          const head = '{"response":"';
          const tail = '"}';
          const filler = 'x'.repeat(Math.max(0, behaviour.bytes - head.length - tail.length));
          if (behaviour.chunked === true) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write(head);
            for (let i = 0; i < filler.length; i += 65_536) {
              res.write(filler.slice(i, i + 65_536));
            }
            res.end(tail);
          } else {
            const text = head + filler + tail;
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(text),
            });
            res.end(text);
          }
          return;
        }
        case 'replace':
          send(200, behaviour.body);
          return;
        case 'delay':
          delayed = behaviour.ms;
          break;
      }
    }
    if (delayed > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayed));
    }
    this.route(path, query, send, (text, contentType) => {
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    });
  }

  private route(
    path: string,
    query: string,
    send: (status: number, body: unknown) => void,
    sendText: (text: string, contentType: string) => void,
  ): void {
    const f = this.fixtures;
    const ok = (response: unknown): void => {
      send(200, { response });
    };
    switch (path) {
      case '/api/system/metadata': {
        ok(f.metadata);
        return;
      }
      case '/api/system/health': {
        ok(f.health);
        return;
      }
      case '/api/system/configuration': {
        ok(f.configuration);
        return;
      }
      case '/api/system/stats': {
        ok(f.stats);
        return;
      }
      case '/api/nodes': {
        ok(f.nodes);
        return;
      }
      case '/api/hosts': {
        ok(f.hosts);
        return;
      }
      case '/api/config-profiles': {
        ok({ total: f.configProfiles.length, configProfiles: f.configProfiles });
        return;
      }
      case '/api/internal-squads': {
        ok({ total: f.internalSquads.length, internalSquads: f.internalSquads });
        return;
      }
      case '/api/external-squads': {
        ok({ total: f.externalSquads.length, externalSquads: f.externalSquads });
        return;
      }
      case '/api/subscription-templates': {
        ok({ total: f.templates.length, templates: f.templates });
        return;
      }
      case '/api/subscription-settings': {
        ok(f.subscriptionSettings);
        return;
      }
      case '/api/snippets': {
        ok({ total: f.snippets.length, snippets: f.snippets });
        return;
      }
      case '/api/node-plugins': {
        ok({ total: f.nodePlugins.length, nodePlugins: f.nodePlugins });
        return;
      }
      case '/api/infra-billing/providers': {
        ok({ total: f.providers.length, providers: f.providers });
        return;
      }
      case '/api/infra-billing/nodes': {
        ok({
          totalBillingNodes: f.billingNodes.length,
          billingNodes: f.billingNodes,
          availableBillingNodes: [],
          totalAvailableBillingNodes: 0,
          stats: { upcomingNodesCount: 1, currentMonthPayments: 10, totalSpent: 120 },
        });
        return;
      }
      case '/api/infra-billing/history': {
        const params = new URLSearchParams(query);
        const start = Number(params.get('start') ?? '0');
        const size = Math.min(500, Number(params.get('size') ?? '50'));
        ok({
          records: f.billingRecords.slice(start, start + size),
          total: f.billingRecords.length,
        });
        return;
      }
      case '/api/tokens':
        if (!this.adminSession) {
          send(403, { message: 'Forbidden resource', error: 'Forbidden', statusCode: 403 });
          return;
        }
        {
          ok({ tokens: f.apiTokens });
          return;
        }
      default:
        break;
    }
    const profile = /^\/api\/config-profiles\/([0-9a-f-]{36})(\/computed-config)?$/u.exec(path);
    if (profile) {
      const found = f.configProfiles.find((p) => p['uuid'] === profile[1]);
      if (!found) {
        send(404, {
          timestamp: new Date().toISOString(),
          path,
          message: 'Config profile not found',
          errorCode: 'A001',
        });
        return;
      }
      ok(found);
      return;
    }
    const more = consoleRoute(path, f, this.consoleFixtures, this.adminSession);
    if (more?.text !== undefined) {
      sendText(more.text, more.contentType ?? 'text/plain');
      return;
    }
    if (more) {
      send(more.status, more.body);
      return;
    }
    send(404, { statusCode: 404, message: `Cannot GET ${path}` });
  }
}
