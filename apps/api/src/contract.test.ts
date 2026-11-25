import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Controller, Get, Module } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiErrorSchema, healthRoute, routes } from '@swellwright/contracts';

import { AppModule } from './app.module.js';
import { createApp } from './bootstrap.js';
import { loadConfig } from './config.js';
import { API_PREFIX, ContractRoute, ROUTE_METADATA, toExpressPath } from './contract-route.js';
import { ApiExceptionFilter, ContractResponseInterceptor, requestContext } from './http.js';

const config = loadConfig({ SW_LOG_LEVEL: 'silent', NODE_ENV: 'test' }, '0.0.0-test');

describe('contract binding', () => {
  it('binds every handler of every controller to a route of the registry (no route is only served)', () => {
    const registered = new Set<unknown>(routes);
    const { controllers = [] } = AppModule.register(config);
    let handlers = 0;
    for (const controller of controllers) {
      const proto = (controller as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') {
          continue;
        }
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) {
          continue;
        }
        handlers += 1;
        assert.ok(
          registered.has(Reflect.getMetadata(ROUTE_METADATA, handler)),
          `${controller.name}.${name} is served without a route of the registry`,
        );
      }
    }
    assert.equal(handlers, routes.length);
  });

  it('refuses, before it runs, a handler that has no contract', async () => {
    let ran = false;
    @Controller()
    class RogueController {
      @Get('rogue')
      rogue(): unknown {
        ran = true;
        return { secret: 'nobody declared me' };
      }
    }
    @Module({
      imports: [AppModule.register(config, { readinessChecks: [] })],
      controllers: [RogueController],
    })
    class RogueModule {}
    const app = await NestFactory.create<NestExpressApplication>(
      RogueModule,
      // Nest declares its options as classes and documents a plain object as the way to pass them.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment
      { logger: false },
    );
    app.use(requestContext);
    app.setGlobalPrefix(API_PREFIX);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as { port: number };
    const base = `http://127.0.0.1:${String(port)}/${API_PREFIX}`;
    try {
      const res = await fetch(`${base}/rogue`);
      assert.equal(res.status, 500);
      const body = ApiErrorSchema.parse(await res.json());
      assert.equal(body.error.code, 'internal_error');
      assert.ok(!JSON.stringify(body).includes('nobody declared me'));
      assert.equal(ran, false, 'the handler never ran');
      // Declared routes still answer as before: a public probe, and the JSON 404 of an unknown path.
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/no-such-path`)).status, 404);
    } finally {
      await app.close();
    }
  });

  it('turns OpenAPI paths into Express paths', () => {
    assert.equal(toExpressPath('/runs/{id}/steps/{step}'), '/runs/:id/steps/:step');
  });

  it('serves every route of the registry (no route is only documented)', async () => {
    const app = await createApp(config, { readinessChecks: [] });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as { port: number };
    try {
      for (const route of routes) {
        const res = await fetch(`http://127.0.0.1:${String(port)}/${API_PREFIX}${route.path}`, {
          method: route.method.toUpperCase(),
        });
        assert.notEqual(
          res.status,
          404,
          `${route.method} ${route.path} is in the registry but not served`,
        );
        if (res.status >= 400) {
          // A bare call is refused (no body, no session, no database): that must be the error envelope.
          ApiErrorSchema.parse(await res.json());
          continue;
        }
        const listed: Readonly<Record<number, unknown>> = route.responses;
        assert.ok(
          listed[res.status],
          `${route.operationId} answered ${String(res.status)}, which its contract does not list`,
        );
      }
    } finally {
      await app.close();
    }
  });

  it('answers 500 internal_error, without leaking details, when a handler breaks its contract', async () => {
    @Controller()
    class BrokenController {
      @ContractRoute(healthRoute)
      health(): unknown {
        return { status: 'definitely-not-ok' };
      }
    }
    const app = await NestFactory.create<NestExpressApplication>(
      { module: class BrokenModule {}, controllers: [BrokenController] },
      // Nest declares its options as classes and documents a plain object as the way to pass them.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment
      { logger: false },
    );
    app.use(requestContext);
    app.setGlobalPrefix(API_PREFIX);
    app.useGlobalFilters(new ApiExceptionFilter());
    app.useGlobalInterceptors(new ContractResponseInterceptor());
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/${API_PREFIX}/health`);
      assert.equal(res.status, 500);
      const body = ApiErrorSchema.parse(await res.json());
      assert.equal(body.error.code, 'internal_error');
      assert.ok(!JSON.stringify(body).includes('definitely-not-ok'));
    } finally {
      await app.close();
    }
  });
});
