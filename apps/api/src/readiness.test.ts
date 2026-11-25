import assert from 'node:assert/strict';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { describe, it } from 'node:test';

import { Database, DatabaseNotReadyError } from '@swellwright/db';

import { DatabaseCheck, reasonOf, ReadinessService, ValkeyCheck } from './readiness.js';

describe('readiness', () => {
  it('maps failures to short reasons without raw driver text', () => {
    assert.equal(reasonOf(new Error('timeout')), 'timeout');
    assert.equal(
      reasonOf(Object.assign(new Error('password=hunter2'), { code: 'ECONNREFUSED' })),
      'ECONNREFUSED',
    );
    assert.equal(reasonOf(new Error('password=hunter2')), 'error');
    assert.equal(reasonOf('weird'), 'error');
  });

  it('is ready with no configured dependencies', async () => {
    assert.deepEqual(await new ReadinessService([]).run(), { status: 'ready', checks: {} });
  });

  it('marks a hanging check as down with a timeout, without waiting forever', async () => {
    const hang = { name: 'hang', run: () => new Promise<void>(() => undefined) };
    const started = performance.now();
    const result = await new ReadinessService([hang]).run();
    assert.equal(result.status, 'not_ready');
    assert.equal(result.checks['hang']?.error, 'timeout');
    assert.ok(performance.now() - started < 4000);
  });

  it('reports pending migrations and a database ahead of the code as short reason codes', async () => {
    for (const code of ['MIGRATIONS_PENDING', 'SCHEMA_AHEAD'] as const) {
      const probe = {
        assertReady: () => Promise.reject(new DatabaseNotReadyError(code, 'detail')),
      };
      const result = await new ReadinessService([new DatabaseCheck(probe)]).run();
      assert.equal(result.status, 'not_ready');
      assert.deepEqual(result.checks['postgres']?.error, code);
    }
  });

  it('closes every check on shutdown', async () => {
    let closed = 0;
    const check = {
      name: 'c',
      run: () => Promise.resolve(),
      close: () => ((closed += 1), Promise.resolve()),
    };
    await new ReadinessService([check, check]).close();
    assert.equal(closed, 2);
  });
});

/**
 * A Valkey stand-in on the loopback address: `silent` accepts the socket and never answers (a hung peer); otherwise it
 * answers the ready check and `PING`. It counts connections and notices when the client closes one.
 */
async function fakeValkey(mode: { silent: boolean }): Promise<{
  url: string;
  opened: () => number;
  open: () => number;
  close: () => Promise<void>;
}> {
  let opened = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    opened += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      if (mode.silent) {
        return;
      }
      const text = chunk.toString('utf8');
      if (/info/iu.test(text)) {
        const info = 'loading:0\r\n';
        socket.write(`$${String(info.length)}\r\n${info}\r\n`);
      }
      if (/ping/iu.test(text)) {
        socket.write('+PONG\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `redis://127.0.0.1:${String(port)}`,
    opened: () => opened,
    open: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the Valkey probe against a peer that does not answer', () => {
  it('times out within its own deadline and closes the connection itself', async () => {
    const mode = { silent: true };
    const peer = await fakeValkey(mode);
    try {
      const check = new ValkeyCheck(peer.url, 300);
      const started = performance.now();
      // Two readiness calls at once share one probe and one connection.
      const results = await Promise.allSettled([check.run(), check.run()]);
      assert.ok(
        performance.now() - started < 1500,
        'bounded by the probe, not the readiness backstop',
      );
      for (const result of results) {
        assert.equal(result.status, 'rejected');
        assert.equal(reasonOf(result.reason), 'timeout');
      }
      assert.equal(peer.opened(), 1, 'one connection for overlapping calls');
      await settle(100);
      assert.equal(peer.open(), 0, 'the peer saw the probe hang up');

      // Through the service, the reason is the short one and the body the usual 503 shape.
      const ready = await new ReadinessService([check]).run();
      assert.equal(ready.status, 'not_ready');
      assert.equal(ready.checks['valkey']?.error, 'timeout');
      await settle(100);
      assert.equal(peer.open(), 0);

      // Shutting down while a probe hangs closes its client at once.
      // The expectation is attached at once: the probe fails while the test still waits below.
      const pending = assert.rejects(check.run());
      await settle(50);
      assert.equal(peer.open(), 1);
      await check.close();
      await settle(100);
      assert.equal(peer.open(), 0, 'shutdown closed the probe in flight');
      await pending;

      // When the peer answers again, the next probe works.
      mode.silent = false;
      await check.run();
      await settle(100);
      assert.equal(peer.open(), 0);
    } finally {
      await peer.close();
    }
  });
});

// Real dependencies: run in CI (service containers) or against `docker compose up`.
const databaseUrl = process.env['SW_TEST_DATABASE_URL'];
const valkeyUrl = process.env['SW_TEST_VALKEY_URL'];

describe('readiness against real dependencies', () => {
  it('reaches a migrated Postgres', { skip: !databaseUrl }, async () => {
    const database = new Database({ url: databaseUrl ?? '', poolSize: 1 });
    try {
      const result = await new ReadinessService([new DatabaseCheck(database)]).run();
      assert.deepEqual(
        { status: result.status, postgres: result.checks['postgres']?.status },
        { status: 'ready', postgres: 'up' },
      );
    } finally {
      await database.close();
    }
  });

  it('reports an unreachable Postgres as down quickly', async () => {
    const database = new Database({
      url: 'postgresql://sw:nope@127.0.0.1:1/swellwright',
      poolSize: 1,
      connectTimeoutMs: 500,
    });
    try {
      const started = performance.now();
      const result = await new ReadinessService([new DatabaseCheck(database)]).run();
      assert.equal(result.status, 'not_ready');
      assert.equal(result.checks['postgres']?.status, 'down');
      assert.ok(performance.now() - started < 4000);
    } finally {
      await database.close();
    }
  });

  it('reaches Valkey', { skip: !valkeyUrl }, async () => {
    await new ValkeyCheck(valkeyUrl ?? '').run();
  });

  it('reports a closed port as down quickly', async () => {
    const result = await new ReadinessService([new ValkeyCheck('redis://127.0.0.1:1')]).run();
    assert.equal(result.status, 'not_ready');
    assert.equal(result.checks['valkey']?.status, 'down');
  });
});
