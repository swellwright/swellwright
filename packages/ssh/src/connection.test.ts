import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { after, before, describe, it } from 'node:test';

import { SshConnection } from './connection.js';
import {
  HostKeyMismatchError,
  SshAbortError,
  SshAuthError,
  SshConnectError,
  SshConnectionLostError,
  SshError,
  SshExecError,
  SshInputError,
  SshTimeoutError,
} from './errors.js';
import { fetchHostKey, hostKeyAlgorithmsPreferring } from './host-key.js';
import {
  generateTestKeyPair,
  generateTestRsaKeyPair,
  publicKeyFingerprint,
  startSilentServer,
  startStallingServer,
  TestSshServer,
  type ExecHandler,
} from './test-support/index.js';
import { TEST_PASSWORD, USERS, sleep, targetFor, until } from './test-util.js';

/** Answers a few scripted commands, so the tests do not depend on a real shell. */
const scripted: ExecHandler = (channel, request, server) => {
  const finish = (code: number): void => {
    channel.exit(code);
    channel.end();
  };
  switch (request.command) {
    case 'hello':
      channel.write('hello\n');
      channel.stderr.write('warning\n');
      finish(0);
      return;
    case 'fail':
      channel.stderr.write('bad things\n');
      finish(3);
      return;
    case 'killed':
      channel.exit('TERM');
      channel.end();
      return;
    case 'echo-stdin':
      channel.on('data', (chunk: Buffer) => channel.write(chunk));
      channel.on('end', () => {
        finish(0);
      });
      return;
    case 'env':
      channel.write(JSON.stringify(request.env));
      finish(0);
      return;
    case 'split-utf8': {
      const bytes = Buffer.from('é€🙂', 'utf8');
      for (const byte of bytes) channel.write(Buffer.from([byte]));
      finish(0);
      return;
    }
    case 'big':
      channel.write(Buffer.alloc(300_000, 0x61));
      channel.stderr.write(Buffer.alloc(300_000, 0x62));
      finish(0);
      return;
    case 'hang':
      return;
    case 'drop':
      setTimeout(() => {
        server.dropConnections();
      }, 20);
      return;
    case 'no-status':
      channel.end();
      return;
    default:
      channel.stderr.write(`unknown command: ${request.command}\n`);
      finish(127);
  }
};

describe('connecting', () => {
  let server: TestSshServer;
  before(async () => {
    server = await TestSshServer.start({ users: USERS, exec: scripted });
  });
  after(async () => {
    await server.close();
  });

  it('connects with a password when the pinned host key matches, and reports the key', async () => {
    const connection = await SshConnection.connect(targetFor(server));
    try {
      assert.equal(connection.hostKey.fingerprintSha256, server.hostKeyFingerprint);
      assert.equal(connection.hostKey.algorithm, 'ssh-ed25519');
      assert.equal(connection.closed, false);
    } finally {
      connection.close();
    }
  });

  it('accepts any one of several pinned fingerprints', async () => {
    const other = `SHA256:${'B'.repeat(43)}`;
    const connection = await SshConnection.connect(
      targetFor(server, {
        hostKey: { mode: 'pinned', fingerprints: [other, server.hostKeyFingerprint] },
      }),
    );
    connection.close();
  });

  it('discover mode accepts the key and reports it for first-use confirmation', async () => {
    const connection = await SshConnection.connect(
      targetFor(server, { hostKey: { mode: 'discover' } }),
    );
    try {
      assert.equal(connection.hostKey.fingerprintSha256, server.hostKeyFingerprint);
    } finally {
      connection.close();
    }
  });

  it('refuses a policy that pins nothing or pins garbage', async () => {
    await assert.rejects(
      SshConnection.connect(targetFor(server, { hostKey: { mode: 'pinned', fingerprints: [] } })),
      SshInputError,
    );
    await assert.rejects(
      SshConnection.connect(
        targetFor(server, { hostKey: { mode: 'pinned', fingerprints: ['not-a-fingerprint'] } }),
      ),
      SshInputError,
    );
  });

  it('refuses invalid targets before touching the network', async () => {
    await assert.rejects(SshConnection.connect(targetFor(server, { host: '' })), SshInputError);
    await assert.rejects(SshConnection.connect(targetFor(server, { host: 'a b' })), SshInputError);
    await assert.rejects(SshConnection.connect(targetFor(server, { port: 70000 })), SshInputError);
    await assert.rejects(SshConnection.connect(targetFor(server, { username: '' })), SshInputError);
    await assert.rejects(
      SshConnection.connect(targetFor(server, { auth: { kind: 'password', password: '' } })),
      SshInputError,
    );
    await assert.rejects(
      SshConnection.connect(targetFor(server, { connectTimeoutMs: 0 })),
      SshInputError,
    );
  });
});

describe('host key verification', () => {
  it('rejects an unpinned key before any authentication request is sent', async () => {
    const server = await TestSshServer.start({ users: USERS });
    try {
      const wrong = `SHA256:${'C'.repeat(43)}`;
      await assert.rejects(
        SshConnection.connect(
          targetFor(server, { hostKey: { mode: 'pinned', fingerprints: [wrong] } }),
        ),
        (error: unknown) => {
          assert.ok(error instanceof HostKeyMismatchError);
          assert.equal(error.code, 'ssh_host_key_mismatch');
          assert.deepEqual(error.expected, [wrong]);
          assert.equal(error.actual, server.hostKeyFingerprint);
          assert.ok(!error.message.includes(TEST_PASSWORD));
          return true;
        },
      );
      // The proof: not one authentication request (not even "none") reached the server.
      assert.deepEqual(server.authAttempts, []);
      assert.equal(server.execLog.length, 0);
    } finally {
      await server.close();
    }
  });

  it('rejects a server whose key changed (a different host key under the same address)', async () => {
    const first = await TestSshServer.start({ users: USERS });
    const pinned = first.hostKeyFingerprint;
    await first.close();
    const second = await TestSshServer.start({ users: USERS, hostKey: generateTestKeyPair() });
    try {
      await assert.rejects(
        SshConnection.connect(
          targetFor(second, { hostKey: { mode: 'pinned', fingerprints: [pinned] } }),
        ),
        HostKeyMismatchError,
      );
      assert.deepEqual(second.authAttempts, []);
    } finally {
      await second.close();
    }
  });

  it('also protects key authentication: the signature is never produced for an unpinned server', async () => {
    const pair = generateTestKeyPair();
    const server = await TestSshServer.start({
      users: { tester: { publicKeys: [pair.publicKey] } },
    });
    try {
      await assert.rejects(
        SshConnection.connect(
          targetFor(server, {
            auth: { kind: 'key', privateKey: pair.privateKey },
            hostKey: { mode: 'pinned', fingerprints: [`SHA256:${'D'.repeat(43)}`] },
          }),
        ),
        HostKeyMismatchError,
      );
      assert.deepEqual(server.authAttempts, []);
    } finally {
      await server.close();
    }
  });
});

describe('a server with host keys of several types', () => {
  // A real sshd has an ed25519, an ECDSA and an RSA key and shows the one the client prefers. A client that pinned the
  // RSA key (it was the only one when it was scanned, or a person pinned it) must still find it after the server
  // gained an ed25519 key, and not take the server for another machine.
  const rsa = generateTestRsaKeyPair();
  const rsaFingerprint = publicKeyFingerprint(rsa.publicKey);
  let server: TestSshServer;
  before(async () => {
    server = await TestSshServer.start({
      users: USERS,
      exec: scripted,
      extraHostKeys: [rsa],
    });
  });
  after(async () => {
    await server.close();
  });

  it('shows the key of the preferred type when nothing is pinned for a type', async () => {
    const key = await fetchHostKey(server.host, server.port);
    assert.equal(key.algorithm, 'ssh-ed25519');
    assert.equal(key.fingerprintSha256, server.hostKeyFingerprint);
  });

  it('connects with the pinned RSA key although an ed25519 key is preferred by default', async () => {
    const connection = await SshConnection.connect(
      targetFor(server, {
        hostKey: { mode: 'pinned', fingerprints: [rsaFingerprint], keyTypes: ['ssh-rsa'] },
      }),
    );
    try {
      assert.equal(connection.hostKey.algorithm, 'ssh-rsa');
      assert.equal(connection.hostKey.fingerprintSha256, rsaFingerprint);
    } finally {
      connection.close();
    }
  });

  it('takes the key of another type for a mismatch when the types of the pin are not given (what a plain pin does)', async () => {
    await assert.rejects(
      SshConnection.connect(
        targetFor(server, { hostKey: { mode: 'pinned', fingerprints: [rsaFingerprint] } }),
      ),
      HostKeyMismatchError,
    );
  });

  it('fetchHostKey prefers the algorithms it is given', async () => {
    const key = await fetchHostKey(server.host, server.port, {
      algorithms: { serverHostKey: hostKeyAlgorithmsPreferring(['ssh-rsa']) },
    });
    assert.equal(key.algorithm, 'ssh-rsa');
    assert.equal(key.fingerprintSha256, rsaFingerprint);
  });

  it('never excludes a type: a pinned type the server lacks falls through to the fingerprint check', async () => {
    const only = await TestSshServer.start({ users: USERS, exec: scripted });
    try {
      await assert.rejects(
        SshConnection.connect(
          targetFor(only, {
            hostKey: {
              mode: 'pinned',
              fingerprints: [rsaFingerprint],
              keyTypes: ['ssh-rsa'],
            },
          }),
        ),
        (error: unknown) =>
          error instanceof HostKeyMismatchError && error.actual === only.hostKeyFingerprint,
      );
      assert.deepEqual(only.authAttempts, []);
    } finally {
      await only.close();
    }
  });

  it('puts the pinned types first and keeps every other one', () => {
    const rsaFirst = hostKeyAlgorithmsPreferring(['ssh-rsa']);
    assert.deepEqual(rsaFirst.slice(0, 3), ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
    assert.ok(rsaFirst.includes('ssh-ed25519') && rsaFirst.includes('ecdsa-sha2-nistp256'));
    assert.equal(new Set(rsaFirst).size, rsaFirst.length);
    // A label for the signature algorithm counts as the RSA key type; an unknown name changes nothing.
    assert.deepEqual(
      hostKeyAlgorithmsPreferring(['rsa-sha2-512']).slice(0, 3),
      rsaFirst.slice(0, 3),
    );
    assert.deepEqual(hostKeyAlgorithmsPreferring(['ssh-made-up']), hostKeyAlgorithmsPreferring([]));
    assert.equal(hostKeyAlgorithmsPreferring([])[0], 'ssh-ed25519');
  });

  it('refuses key type names that are not names', async () => {
    await assert.rejects(
      SshConnection.connect(
        targetFor(server, {
          hostKey: {
            mode: 'pinned',
            fingerprints: [server.hostKeyFingerprint],
            keyTypes: ['not a name'],
          },
        }),
      ),
      SshInputError,
    );
  });
});

describe('fetchHostKey', () => {
  it('returns the fingerprint and key type without sending credentials of any kind', async () => {
    const server = await TestSshServer.start({ users: USERS });
    try {
      const key = await fetchHostKey(server.host, server.port, { timeoutMs: 3000 });
      assert.equal(key.fingerprintSha256, server.hostKeyFingerprint);
      assert.equal(key.algorithm, 'ssh-ed25519');
      await sleep(50);
      assert.deepEqual(server.authAttempts, []);
    } finally {
      await server.close();
    }
  });

  it('times out on a peer that never speaks', async () => {
    const silent = await startSilentServer();
    try {
      const started = Date.now();
      await assert.rejects(
        fetchHostKey('127.0.0.1', silent.port, { timeoutMs: 300 }),
        SshTimeoutError,
      );
      assert.ok(Date.now() - started < 3000);
    } finally {
      await silent.close();
    }
  });

  it('times out on a peer that greets and then stalls', async () => {
    const stalling = await startStallingServer();
    try {
      await assert.rejects(
        fetchHostKey('127.0.0.1', stalling.port, { timeoutMs: 300 }),
        SshTimeoutError,
      );
    } finally {
      await stalling.close();
    }
  });

  it('reports a closed port as a refused connection', async () => {
    const silent = await startSilentServer();
    const port = silent.port;
    await silent.close();
    await assert.rejects(fetchHostKey('127.0.0.1', port, { timeoutMs: 2000 }), (error: unknown) => {
      assert.ok(error instanceof SshConnectError);
      assert.equal(error.reason, 'refused');
      assert.equal(error.code, 'ssh_connect_failed');
      return true;
    });
  });

  it('validates its input', async () => {
    await assert.rejects(fetchHostKey('', 22), SshInputError);
    await assert.rejects(fetchHostKey('127.0.0.1', 0), SshInputError);
  });
});

describe('authentication', () => {
  it('rejects a wrong password with a typed error that does not contain it', async () => {
    const server = await TestSshServer.start({ users: USERS });
    try {
      const secret = 'wrong-secret-value-123';
      await assert.rejects(
        SshConnection.connect(targetFor(server, { auth: { kind: 'password', password: secret } })),
        (error: unknown) => {
          assert.ok(error instanceof SshAuthError);
          assert.equal(error.code, 'ssh_auth_failed');
          assert.ok(!error.message.includes(secret));
          assert.ok(!String(error.cause).includes(secret));
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it('rejects an unknown user', async () => {
    const server = await TestSshServer.start({ users: USERS });
    try {
      await assert.rejects(
        SshConnection.connect(targetFor(server, { username: 'nobody' })),
        SshAuthError,
      );
    } finally {
      await server.close();
    }
  });

  it('authenticates with a private key', async () => {
    const pair = generateTestKeyPair();
    const server = await TestSshServer.start({
      users: { tester: { publicKeys: [pair.publicKey] } },
    });
    try {
      const connection = await SshConnection.connect(
        targetFor(server, { auth: { kind: 'key', privateKey: pair.privateKey } }),
      );
      connection.close();
      assert.ok(
        server.authAttempts.some((attempt) => attempt.method === 'publickey' && attempt.accepted),
      );
    } finally {
      await server.close();
    }
  });

  it('authenticates with an encrypted private key and its passphrase', async () => {
    const pair = generateTestKeyPair('pass-phrase-for-test');
    const server = await TestSshServer.start({
      users: { tester: { publicKeys: [pair.publicKey] } },
    });
    try {
      const connection = await SshConnection.connect(
        targetFor(server, {
          auth: { kind: 'key', privateKey: pair.privateKey, passphrase: 'pass-phrase-for-test' },
        }),
      );
      connection.close();
    } finally {
      await server.close();
    }
  });

  it('reports an encrypted key without its passphrase as an unusable key, before connecting', async () => {
    const pair = generateTestKeyPair('pass-phrase-for-test');
    const server = await TestSshServer.start({
      users: { tester: { publicKeys: [pair.publicKey] } },
    });
    try {
      await assert.rejects(
        SshConnection.connect(
          targetFor(server, { auth: { kind: 'key', privateKey: pair.privateKey } }),
        ),
        (error: unknown) => {
          assert.ok(error instanceof SshAuthError);
          assert.equal(error.code, 'ssh_key_invalid');
          return true;
        },
      );
      await assert.rejects(
        SshConnection.connect(
          targetFor(server, {
            auth: { kind: 'key', privateKey: pair.privateKey, passphrase: 'a-wrong-passphrase' },
          }),
        ),
        (error: unknown) => {
          assert.ok(error instanceof SshAuthError);
          assert.ok(!error.message.includes('a-wrong-passphrase'));
          return true;
        },
      );
      assert.deepEqual(server.authAttempts, []);
    } finally {
      await server.close();
    }
  });

  it('rejects text that is not a key, and a key the server does not know', async () => {
    const server = await TestSshServer.start({
      users: { tester: { publicKeys: [generateTestKeyPair().publicKey] } },
    });
    try {
      await assert.rejects(
        SshConnection.connect(
          targetFor(server, { auth: { kind: 'key', privateKey: 'not a key' } }),
        ),
        (error: unknown) => error instanceof SshAuthError && error.code === 'ssh_key_invalid',
      );
      const stranger = generateTestKeyPair();
      await assert.rejects(
        SshConnection.connect(
          targetFor(server, { auth: { kind: 'key', privateKey: stranger.privateKey } }),
        ),
        (error: unknown) => error instanceof SshAuthError && error.code === 'ssh_auth_failed',
      );
    } finally {
      await server.close();
    }
  });
});

describe('deadlines while connecting', () => {
  it('never hangs on a server that accepts the TCP connection and says nothing', async () => {
    const silent = await startSilentServer();
    try {
      const started = Date.now();
      await assert.rejects(
        SshConnection.connect({
          host: '127.0.0.1',
          port: silent.port,
          username: 'tester',
          auth: { kind: 'password', password: TEST_PASSWORD },
          hostKey: { mode: 'discover' },
          connectTimeoutMs: 400,
        }),
        (error: unknown) => {
          assert.ok(error instanceof SshTimeoutError);
          assert.equal(error.phase, 'connect');
          assert.ok(!error.message.includes(TEST_PASSWORD));
          return true;
        },
      );
      assert.ok(Date.now() - started < 3000, 'the connect deadline was not honoured');
    } finally {
      await silent.close();
    }
  });

  it('never hangs on a server whose handshake never completes', async () => {
    const stalling = await startStallingServer();
    try {
      const started = Date.now();
      await assert.rejects(
        SshConnection.connect({
          host: '127.0.0.1',
          port: stalling.port,
          username: 'tester',
          auth: { kind: 'password', password: TEST_PASSWORD },
          hostKey: { mode: 'pinned', fingerprints: [`SHA256:${'E'.repeat(43)}`] },
          connectTimeoutMs: 400,
        }),
        SshTimeoutError,
      );
      assert.ok(Date.now() - started < 3000);
    } finally {
      await stalling.close();
    }
  });

  it('reports a refused connection', async () => {
    const silent = await startSilentServer();
    const port = silent.port;
    await silent.close();
    await assert.rejects(
      SshConnection.connect({
        host: '127.0.0.1',
        port,
        username: 'tester',
        auth: { kind: 'password', password: TEST_PASSWORD },
        hostKey: { mode: 'discover' },
        connectTimeoutMs: 2000,
      }),
      (error: unknown) => error instanceof SshConnectError && error.reason === 'refused',
    );
  });
});

describe('algorithms', () => {
  it('does not downgrade to a legacy key exchange that only the server offers', async () => {
    const legacy = await TestSshServer.start({
      users: USERS,
      algorithms: { kex: ['diffie-hellman-group1-sha1'] },
    });
    try {
      await assert.rejects(SshConnection.connect(targetFor(legacy)), (error: unknown) => {
        assert.ok(error instanceof SshConnectError);
        assert.equal(error.reason, 'handshake');
        return true;
      });
      assert.deepEqual(legacy.authAttempts, []);
      // Nothing is forbidden for good: a caller that names the algorithm itself gets it.
      const connection = await SshConnection.connect(
        targetFor(legacy, { algorithms: { kex: ['diffie-hellman-group1-sha1'] } }),
      );
      connection.close();
    } finally {
      await legacy.close();
    }
  });

  it('offers only what an allow-list names', async () => {
    const server = await TestSshServer.start({
      users: USERS,
      algorithms: { kex: ['curve25519-sha256'] },
    });
    try {
      await assert.rejects(
        SshConnection.connect(targetFor(server, { algorithms: { kex: ['ecdh-sha2-nistp256'] } })),
        SshConnectError,
      );
      const connection = await SshConnection.connect(
        targetFor(server, {
          algorithms: {
            kex: ['curve25519-sha256'],
            cipher: ['aes256-ctr'],
            hmac: ['hmac-sha2-256'],
          },
        }),
      );
      connection.close();
    } finally {
      await server.close();
    }
  });

  it('refuses an empty list and a name ssh2 does not know', async () => {
    const server = await TestSshServer.start({ users: USERS });
    try {
      await assert.rejects(
        SshConnection.connect(targetFor(server, { algorithms: { kex: [] } })),
        SshInputError,
      );
      await assert.rejects(
        SshConnection.connect(targetFor(server, { algorithms: { cipher: ['not-a-cipher'] } })),
        SshInputError,
      );
    } finally {
      await server.close();
    }
  });
});

describe('exec', () => {
  let server: TestSshServer;
  let connection: SshConnection;
  before(async () => {
    server = await TestSshServer.start({ users: USERS, exec: scripted, acceptEnv: ['LC_SWTEST'] });
    connection = await SshConnection.connect(targetFor(server));
  });
  after(async () => {
    connection.close();
    await server.close();
  });

  it('returns output, status and duration; a non-zero status is a result, not an error', async () => {
    const ok = await connection.exec('hello');
    assert.deepEqual(
      { code: ok.code, signal: ok.signal, stdout: ok.stdout, stderr: ok.stderr },
      { code: 0, signal: null, stdout: 'hello\n', stderr: 'warning\n' },
    );
    assert.ok(ok.durationMs >= 0);
    assert.equal(ok.stdoutTruncated, false);
    const failed = await connection.exec('fail');
    assert.equal(failed.code, 3);
    assert.equal(failed.stderr, 'bad things\n');
  });

  it('reports a command ended by a signal', async () => {
    const result = await connection.exec('killed');
    assert.equal(result.code, null);
    assert.equal(result.signal, 'SIGTERM');
  });

  it('feeds standard input from a string or bytes, then closes it', async () => {
    assert.equal((await connection.exec('echo-stdin', { stdin: 'héllo' })).stdout, 'héllo');
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    const raw = await connection.execRaw('echo-stdin', { stdin: bytes });
    assert.deepEqual(raw.stdout, bytes);
    // Without input the command sees end of file at once instead of waiting.
    assert.equal((await connection.exec('echo-stdin')).stdout, '');
  });

  it('streams decoded text and does not split multi-byte characters across chunks', async () => {
    const chunks: string[] = [];
    const result = await connection.exec('split-utf8', {
      onStdout: (chunk) => {
        chunks.push(chunk);
      },
    });
    assert.equal(result.stdout, 'é€🙂');
    assert.equal(chunks.join(''), 'é€🙂');
    assert.ok(!chunks.join('').includes('�'));
  });

  it('caps what it collects, says so, and still shows everything to the callbacks', async () => {
    let streamed = 0;
    const result = await connection.exec('big', {
      maxOutputBytes: 1000,
      onStdout: (chunk) => {
        streamed += chunk.length;
      },
    });
    assert.equal(result.stdout.length, 1000);
    assert.equal(result.stderr.length, 1000);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.equal(streamed, 300_000);
    const full = await connection.exec('big');
    assert.equal(full.stdout.length, 300_000);
    assert.equal(full.stdoutTruncated, false);
  });

  it('ignores a callback that throws', async () => {
    const result = await connection.exec('hello', {
      onStdout: () => {
        throw new Error('callback bug');
      },
    });
    assert.equal(result.stdout, 'hello\n');
  });

  it('stops waiting at the deadline and stays usable', async () => {
    await assert.rejects(connection.exec('hang', { timeoutMs: 150 }), (error: unknown) => {
      assert.ok(error instanceof SshTimeoutError);
      assert.equal(error.phase, 'exec');
      assert.equal(error.code, 'ssh_timeout');
      return true;
    });
    assert.equal((await connection.exec('hello')).stdout, 'hello\n');
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    const pending = connection.exec('hang', { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await assert.rejects(pending, SshAbortError);
    await assert.rejects(connection.exec('hello', { signal: AbortSignal.abort() }), SshAbortError);
    assert.equal((await connection.exec('hello')).code, 0);
  });

  it('sends only the environment variables it was asked to, and the server only keeps what AcceptEnv allows', async () => {
    const result = await connection.exec('env', { env: { LC_SWTEST: 'one', OTHER_VAR: 'two' } });
    assert.deepEqual(JSON.parse(result.stdout), { LC_SWTEST: 'one' });
  });

  it('refuses bad arguments before sending anything', async () => {
    const before = server.execLog.length;
    await assert.rejects(connection.exec(''), SshInputError);
    await assert.rejects(connection.exec('a\0b'), SshInputError);
    await assert.rejects(connection.exec('hello', { env: { 'BAD NAME': 'x' } }), SshInputError);
    await assert.rejects(connection.exec('hello', { env: { GOOD: 'a\0b' } }), SshInputError);
    await assert.rejects(connection.exec('hello', { timeoutMs: -5 }), SshInputError);
    await assert.rejects(connection.exec('hello', { maxOutputBytes: 1.5 }), SshInputError);
    assert.equal(server.execLog.length, before);
  });

  it('turns an exec request the server refuses into a typed error', async () => {
    const bare = await TestSshServer.start({ users: USERS });
    const refused = await SshConnection.connect(targetFor(bare));
    try {
      await assert.rejects(refused.exec('anything'), SshExecError);
    } finally {
      refused.close();
      await bare.close();
    }
  });
});

// Reads all of its standard input before it answers, so that what the client sent can be inspected afterwards.
const drain: ExecHandler = (channel) => {
  channel.on('data', () => undefined);
  channel.on('end', () => {
    channel.exit(0);
    channel.end();
  });
};

describe('sudo password handling', () => {
  it('puts the password only on standard input: not in the command line, not in the environment', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: drain, acceptEnv: [] });
    const connection = await SshConnection.connect(targetFor(server));
    try {
      const password = 'sudo-secret-pw-42';
      await connection.exec('hello', { sudo: { password }, stdin: 'payload' });
      const logged = server.execLog.at(-1);
      assert.ok(logged);
      assert.ok(!logged.command.includes(password), 'the password is in the command line');
      assert.ok(logged.command.includes('sudo -S -p'));
      assert.deepEqual(logged.env, {});
      // The first line of the input is the password, then the caller's own input follows untouched.
      assert.equal(logged.stdin.toString('utf8'), `${password}\npayload`);
    } finally {
      connection.close();
      await server.close();
    }
  });

  it('without a password it runs sudo non-interactively and sends no extra input', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: drain });
    const connection = await SshConnection.connect(targetFor(server));
    try {
      await connection.exec('hello', { sudo: {} });
      const logged = server.execLog.at(-1);
      assert.ok(logged);
      assert.ok(logged.command.includes('sudo -n'));
      assert.ok(!logged.command.includes('read -r'));
      assert.equal(logged.stdin.length, 0);
    } finally {
      connection.close();
      await server.close();
    }
  });

  it('rejects a password that would break the framing', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: scripted });
    const connection = await SshConnection.connect(targetFor(server));
    try {
      await assert.rejects(connection.exec('hello', { sudo: { password: 'a\nb' } }), SshInputError);
      await assert.rejects(connection.exec('hello', { sudo: { password: 'a\0b' } }), SshInputError);
      assert.equal(server.execLog.length, 0);
    } finally {
      connection.close();
      await server.close();
    }
  });
});

describe('a connection that dies', () => {
  it('rejects the command in flight with a typed error and emits close', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: scripted });
    const connection = await SshConnection.connect(targetFor(server));
    try {
      let closed = false;
      connection.on('close', () => {
        closed = true;
      });
      await assert.rejects(connection.exec('drop', { timeoutMs: 5000 }), (error: unknown) => {
        assert.ok(error instanceof SshConnectionLostError);
        assert.equal(error.code, 'ssh_connection_lost');
        assert.equal(error.retryable, true);
        return true;
      });
      await until(() => closed, 3000, 'the close event');
      assert.equal(connection.closed, true);
      await assert.rejects(connection.exec('hello'), SshConnectionLostError);
    } finally {
      connection.close();
      await server.close();
    }
  });

  it('is detected by keepalive when the link goes silent, without crashing an unobserved process', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: scripted });
    // No 'error' listener on purpose: an unobserved dead connection must not throw.
    const connection = await SshConnection.connect(
      targetFor(server, { keepaliveIntervalMs: 100, keepaliveCountMax: 1 }),
    );
    try {
      const pending = connection.exec('hang', { timeoutMs: 10_000 });
      pending.catch(() => undefined);
      await sleep(50);
      server.freeze();
      await assert.rejects(pending, (error: unknown) => error instanceof SshError);
      await until(() => connection.closed, 5000, 'keepalive to give up');
    } finally {
      connection.close();
      await server.close();
    }
  });

  it('emits error to listeners with the typed cause', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: scripted });
    const connection = await SshConnection.connect(
      targetFor(server, { keepaliveIntervalMs: 100, keepaliveCountMax: 1 }),
    );
    try {
      const errors: Error[] = [];
      connection.on('error', (error) => {
        errors.push(error);
      });
      server.freeze();
      await until(() => connection.closed, 5000, 'keepalive to give up');
      assert.equal(errors.length, 1);
      assert.ok(errors[0] instanceof SshTimeoutError);
      assert.equal(errors[0].phase, 'keepalive');
    } finally {
      connection.close();
      await server.close();
    }
  });

  it('close() is idempotent and rejects commands afterwards', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: scripted });
    const connection = await SshConnection.connect(targetFor(server));
    try {
      connection.close();
      connection.close();
      await until(() => connection.closed, 3000, 'the connection to close');
      await assert.rejects(connection.exec('hello'), SshConnectionLostError);
    } finally {
      await server.close();
    }
  });
});

describe('closing a connection to a peer that does not answer', () => {
  it('destroys the socket after a second instead of waiting for the peer for ever', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: scripted });
    const connection = await SshConnection.connect(targetFor(server));
    // The peer is gone before the goodbye: `end()` of ssh2 leaves the socket not writable, and its `destroy()` does
    // nothing then, so the socket has to be destroyed directly or it stays (and keeps the process alive).
    await server.close();
    connection.close();
    await until(() => connection.closed, 4000, 'the socket to be destroyed');
  });
});

describe('secrets stay out of everything printable', () => {
  it('shows no credentials when the connection is printed, inspected or serialised', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: scripted });
    const connection = await SshConnection.connect(targetFor(server));
    try {
      for (const text of [
        String(connection),
        inspect(connection, { depth: 6, showHidden: true }),
        JSON.stringify(connection),
      ]) {
        assert.ok(!text.includes(TEST_PASSWORD), 'the password is printable');
        assert.ok(text.includes(server.host));
      }
    } finally {
      connection.close();
      await server.close();
    }
  });

  it('keeps the password, the passphrase and the sudo password out of every error message', async () => {
    const server = await TestSshServer.start({ users: USERS, exec: scripted });
    const secrets = ['hunter2-password', 'pass-phrase-secret', 'sudo-pw-secret'];
    const pair = generateTestKeyPair('pass-phrase-secret');
    const attempts: (() => Promise<unknown>)[] = [
      () =>
        SshConnection.connect(
          targetFor(server, { auth: { kind: 'password', password: 'hunter2-password' } }),
        ),
      () =>
        SshConnection.connect(
          targetFor(server, {
            auth: { kind: 'key', privateKey: pair.privateKey, passphrase: 'pass-phrase-secret' },
          }),
        ),
      () =>
        SshConnection.connect(
          targetFor(server, {
            auth: { kind: 'key', privateKey: pair.privateKey, passphrase: 'pass-phrase-secret' },
            hostKey: { mode: 'pinned', fingerprints: [`SHA256:${'F'.repeat(43)}`] },
          }),
        ),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), (error: unknown) => {
        assert.ok(error instanceof Error);
        const text = `${error.name} ${error.message} ${String(error.cause)} ${error.stack ?? ''}`;
        for (const secret of secrets)
          assert.ok(!text.includes(secret), `${secret} leaked into ${text}`);
        return true;
      });
    }
    const hanging = await TestSshServer.start({ users: USERS, exec: () => undefined });
    const connection = await SshConnection.connect(targetFor(hanging));
    try {
      await assert.rejects(
        connection.exec('anything', { sudo: { password: 'sudo-pw-secret' }, timeoutMs: 100 }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!`${error.message} ${error.stack ?? ''}`.includes('sudo-pw-secret'));
          return true;
        },
      );
    } finally {
      connection.close();
      await hanging.close();
      await server.close();
    }
  });
});
