import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { SshConnection } from './connection.js';
import {
  SshAuthError,
  SshConnectError,
  SshConnectionLostError,
  SshInputError,
  SshPoolClosedError,
  SshTimeoutError,
} from './errors.js';
import { SshPool } from './pool.js';
import { startSilentServer, TestSshServer } from './test-support/index.js';
import { TEST_PASSWORD, USERS, sleep, targetFor, until } from './test-util.js';

const answer = (channel: {
  write: (data: string) => unknown;
  exit: (code: number) => void;
  end: () => void;
}): void => {
  channel.write('ok');
  channel.exit(0);
  channel.end();
};

describe('SshPool', () => {
  let server: TestSshServer;
  before(async () => {
    server = await TestSshServer.start({
      users: { tester: { password: TEST_PASSWORD }, other: { password: TEST_PASSWORD } },
      exec: answer,
    });
  });
  after(async () => {
    await server.close();
  });

  it('reuses one connection for sequential work', async () => {
    const pool = new SshPool({ idleMs: 5000 });
    const before = server.connections;
    try {
      for (let index = 0; index < 4; index += 1) {
        const result = await pool.withConnection(targetFor(server), (connection) =>
          connection.exec('x'),
        );
        assert.equal(result.stdout, 'ok');
      }
      assert.equal(server.connections - before, 1);
      assert.deepEqual(pool.stats(), { entries: 1, idle: 1, leased: 0, connecting: 0, waiting: 0 });
    } finally {
      pool.closeAll();
    }
  });

  it('caps connections per host and makes the others wait their turn', async () => {
    const pool = new SshPool({ maxPerHost: 2, idleMs: 5000 });
    const before = server.connections;
    let inUse = 0;
    let peak = 0;
    const seen = new Set<SshConnection>();
    try {
      const work = async (connection: SshConnection): Promise<string> => {
        inUse += 1;
        peak = Math.max(peak, inUse);
        seen.add(connection);
        await sleep(120);
        const result = await connection.exec('x');
        inUse -= 1;
        return result.stdout;
      };
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() => pool.withConnection(targetFor(server), work)),
      );
      assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok']);
      assert.equal(peak, 2);
      assert.equal(seen.size, 2);
      assert.equal(server.connections - before, 2);
    } finally {
      pool.closeAll();
    }
  });

  it('never gives one connection to two callers at once', async () => {
    const pool = new SshPool({ maxPerHost: 1, idleMs: 5000 });
    const order: string[] = [];
    try {
      await Promise.all(
        ['a', 'b', 'c'].map((name) =>
          pool.withConnection(targetFor(server), async () => {
            order.push(`${name}:start`);
            await sleep(40);
            order.push(`${name}:end`);
          }),
        ),
      );
      assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    } finally {
      pool.closeAll();
    }
  });

  it('keeps separate connections for different users and different host key policies', async () => {
    const pool = new SshPool({ idleMs: 5000 });
    const before = server.connections;
    try {
      await pool.withConnection(targetFor(server), (connection) => connection.exec('x'));
      await pool.withConnection(targetFor(server, { username: 'other' }), (connection) =>
        connection.exec('x'),
      );
      await pool.withConnection(
        targetFor(server, { hostKey: { mode: 'discover' } }),
        (connection) => connection.exec('x'),
      );
      assert.equal(server.connections - before, 3);
      assert.equal(pool.stats().entries, 3);
      assert.ok(!JSON.stringify(pool.stats()).includes(TEST_PASSWORD));
    } finally {
      pool.closeAll();
    }
  });

  it('replaces a connection that died while idle without the caller noticing', async () => {
    const pool = new SshPool({ idleMs: 5000 });
    const before = server.connections;
    try {
      await pool.withConnection(targetFor(server), (connection) => connection.exec('x'));
      server.dropConnections();
      await until(
        () => pool.stats().idle === 0,
        3000,
        'the dead idle connection to leave the pool',
      );
      const result = await pool.withConnection(targetFor(server), (connection) =>
        connection.exec('x'),
      );
      assert.equal(result.stdout, 'ok');
      assert.equal(server.connections - before, 2);
    } finally {
      pool.closeAll();
    }
  });

  it('drops a connection that died during a lease and serves the next caller from a new one', async () => {
    const pool = new SshPool({ idleMs: 5000 });
    try {
      await assert.rejects(
        pool.withConnection(targetFor(server), async (connection) => {
          server.dropConnections();
          await until(() => connection.closed, 3000, 'the connection to die');
          return connection.exec('x');
        }),
        SshConnectionLostError,
      );
      assert.equal(pool.stats().idle, 0);
      assert.equal(
        (await pool.withConnection(targetFor(server), (connection) => connection.exec('x'))).stdout,
        'ok',
      );
    } finally {
      pool.closeAll();
    }
  });

  it('closes idle connections after the idle period', async () => {
    const pool = new SshPool({ idleMs: 100 });
    try {
      let leased: SshConnection | undefined;
      await pool.withConnection(targetFor(server), (connection) => {
        leased = connection;
        return Promise.resolve();
      });
      assert.equal(pool.stats().idle, 1);
      await until(() => pool.stats().entries === 0, 3000, 'the idle connection to be closed');
      await until(() => leased?.closed === true, 3000, 'the connection to close');
    } finally {
      pool.closeAll();
    }
  });

  it('gives up waiting for a free connection after the acquire timeout, and recovers', async () => {
    // acquireTimeoutMs bounds the whole acquire, including establishing the first connection (a real SSH
    // handshake to the test server): 150ms left no margin for that handshake under a loaded CI runner, so the
    // first withConnection call itself occasionally timed out instead of the second one. 1000ms keeps the test
    // fast while giving the handshake real headroom; the hold grows with it so the second call still times out
    // well before the first one releases.
    const pool = new SshPool({ maxPerHost: 1, acquireTimeoutMs: 1000, idleMs: 5000 });
    try {
      const holder = pool.withConnection(targetFor(server), async () => {
        await sleep(3000);
        return 'held';
      });
      await sleep(30);
      await assert.rejects(
        pool.withConnection(targetFor(server), () => Promise.resolve('never')),
        (error: unknown) => {
          assert.ok(error instanceof SshTimeoutError);
          assert.equal(error.phase, 'pool');
          return true;
        },
      );
      assert.equal(await holder, 'held');
      assert.equal(
        (await pool.withConnection(targetFor(server), (connection) => connection.exec('x'))).stdout,
        'ok',
      );
      assert.equal(pool.stats().waiting, 0);
    } finally {
      pool.closeAll();
    }
  });

  it('does not hang when the server never answers: every caller gets an error and the pool is empty again', async () => {
    const silent = await startSilentServer();
    const pool = new SshPool({ maxPerHost: 1, idleMs: 5000 });
    try {
      const target = {
        host: '127.0.0.1',
        port: silent.port,
        username: 'tester',
        auth: { kind: 'password', password: TEST_PASSWORD } as const,
        hostKey: { mode: 'discover' } as const,
        connectTimeoutMs: 300,
      };
      const started = Date.now();
      const outcomes = await Promise.allSettled(
        [1, 2, 3].map(() => pool.withConnection(target, () => Promise.resolve('x'))),
      );
      for (const outcome of outcomes) {
        assert.equal(outcome.status, 'rejected');
        assert.ok(outcome.reason instanceof SshTimeoutError);
      }
      assert.ok(Date.now() - started < 8000);
      assert.deepEqual(pool.stats(), { entries: 0, idle: 0, leased: 0, connecting: 0, waiting: 0 });
    } finally {
      pool.closeAll();
      await silent.close();
    }
  });

  it('is not wedged by a failed connect: a bad password fails, a good one works afterwards', async () => {
    const pool = new SshPool({ maxPerHost: 1, idleMs: 5000 });
    try {
      await assert.rejects(
        pool.withConnection(
          targetFor(server, { auth: { kind: 'password', password: 'wrong-password-1' } }),
          () => Promise.resolve(1),
        ),
        SshAuthError,
      );
      assert.equal(
        (await pool.withConnection(targetFor(server), (connection) => connection.exec('x'))).stdout,
        'ok',
      );
    } finally {
      pool.closeAll();
    }
  });

  it('reports a refused connection to the caller', async () => {
    const silent = await startSilentServer();
    const port = silent.port;
    await silent.close();
    const pool = new SshPool();
    try {
      await assert.rejects(
        pool.withConnection({ ...targetFor(server), port }, () => Promise.resolve(1)),
        (error: unknown) => error instanceof SshConnectError && error.reason === 'refused',
      );
    } finally {
      pool.closeAll();
    }
  });

  it('closeAll closes connections in use and idle, and rejects those who wait', async () => {
    const pool = new SshPool({ maxPerHost: 1, idleMs: 5000 });
    let leased: SshConnection | undefined;
    const first = pool.withConnection(targetFor(server), async (connection) => {
      leased = connection;
      await sleep(400);
      return connection.exec('x');
    });
    first.catch(() => undefined);
    await until(() => leased !== undefined, 5000, 'the first caller to get its connection');
    const waiting = pool.withConnection(targetFor(server), () => Promise.resolve('x'));
    waiting.catch(() => undefined);
    await until(() => pool.stats().waiting === 1, 5000, 'the second caller to queue');
    pool.closeAll();
    await assert.rejects(waiting, SshPoolClosedError);
    await assert.rejects(first, SshConnectionLostError);
    assert.equal(leased?.closed, true);
    assert.equal(pool.stats().entries, 0);
    // The pool is usable again.
    assert.equal(
      (await pool.withConnection(targetFor(server), (connection) => connection.exec('x'))).stdout,
      'ok',
    );
    pool.closeAll();
  });

  it('closeAll also rejects a caller whose connection is still being opened, at once', async () => {
    const silent = await startSilentServer();
    const pool = new SshPool({ maxPerHost: 1, acquireTimeoutMs: 60_000 });
    try {
      const target = {
        host: '127.0.0.1',
        port: silent.port,
        username: 'tester',
        auth: { kind: 'password', password: TEST_PASSWORD } as const,
        hostKey: { mode: 'discover' } as const,
        connectTimeoutMs: 5000,
      };
      const opening = pool.withConnection(target, () => Promise.resolve('x'));
      opening.catch(() => undefined);
      await until(() => pool.stats().connecting === 1, 3000, 'the connection to start opening');
      const started = Date.now();
      pool.closeAll();
      await assert.rejects(opening, SshPoolClosedError);
      assert.ok(Date.now() - started < 1000, 'closeAll left the caller waiting');
    } finally {
      pool.closeAll();
      await silent.close();
    }
  });

  it('closes the SFTP sessions a caller left open when the lease ends', async () => {
    const pool = new SshPool({ idleMs: 5000 });
    const sftpRoot = await TestSshServer.start({ users: USERS, sftpRoot: process.cwd() });
    try {
      let session: Awaited<ReturnType<SshConnection['sftp']>> | undefined;
      await pool.withConnection(targetFor(sftpRoot), async (connection) => {
        session = await connection.sftp();
      });
      assert.equal(session?.closed, true);
    } finally {
      pool.closeAll();
      await sftpRoot.close();
    }
  });

  it('validates its options', () => {
    assert.throws(() => new SshPool({ maxPerHost: 0 }), SshInputError);
    assert.throws(() => new SshPool({ maxPerHost: 1.5 }), SshInputError);
    assert.throws(() => new SshPool({ idleMs: -1 }), SshInputError);
    assert.throws(() => new SshPool({ acquireTimeoutMs: 0 }), SshInputError);
  });
});
