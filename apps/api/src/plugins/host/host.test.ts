import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { servicesFor, writeFixture } from './fixtures.js';
import {
  isPublicAddress,
  NetworkRefused,
  PluginNetwork,
  type TransportRequest,
} from './network.js';
import { PluginCallError, PluginProcess } from './process.js';

const RUNNER = fileURLToPath(new URL('./runner.js', import.meta.url));

/** An IPv4 address from its parts, so that the tests do not carry address literals. */
const ip = (...octets: number[]): string => octets.join('.');
const PUBLIC = [{ address: ip(93, 184, 216, 34), family: 4 as const }];

describe('which addresses a plugin may be sent to', () => {
  it('lets public addresses through and refuses everything local, private, shared or reserved', () => {
    for (const address of [
      ip(93, 184, 216, 34),
      ip(8, 8, 8, 8),
      ip(1, 1, 1, 1),
      '2606:4700:4700::1111',
      ip(172, 32, 0, 1),
    ]) {
      assert.equal(isPublicAddress(address), true, address);
    }
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      ip(100, 64, 0, 1),
      '0.0.0.0',
      ip(224, 0, 0, 1),
      '255.255.255.255',
      '192.0.2.1',
      '198.51.100.7',
      '203.0.113.9',
      '198.18.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
      '::ffff:10.1.2.3',
      'not an address',
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }
  });

  it('judges an IPv6 address by what it really leads to, however it is written', () => {
    for (const address of [
      // The same loopback and private addresses in hexadecimal, compatible and translated forms.
      '::ffff:7f00:1',
      '::ffff:a01:203',
      '::127.0.0.1',
      '::7f00:1',
      '64:ff9b::7f00:1',
      '64:ff9b::a9fe:a9fe', // the metadata address through NAT64
      '64:ff9b::192.168.0.1',
      '64:ff9b:1::1', // local NAT64
      '2002:7f00:1::1', // 6to4
      '2002:5db8:d822::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
      '2001:2::1', // benchmarking
      '100::1', // discard
      'fec0::1', // site local
      '3fff::1', // documentation
      'fe80::1%1',
      '0:0:0:0:0:0:0:1',
      '::ffff:0:0',
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of [
      '64:ff9b::5db8:d822', // a public IPv4 address through NAT64 is public
      '::ffff:5db8:d822',
      '2a00:1450:4001:80b::200e',
      '2001:4860:4860::8888',
    ]) {
      assert.equal(isPublicAddress(address), true, address);
    }
  });
});

describe('the core door for a plugin', () => {
  const seen: TransportRequest[] = [];
  const network = new PluginNetwork({
    resolve: () => Promise.resolve(PUBLIC),
    transport: (request) => {
      seen.push(request);
      return Promise.resolve({ status: 200, headers: { 'x-a': 'b' }, body: 'hello' });
    },
  });
  const allowed = ['api.example.com:443', 'dns.example.com:8443'];
  const refusal = (promise: Promise<unknown>) =>
    assert.rejects(promise, (error: unknown) => error instanceof NetworkRefused);

  it('makes a request to an approved host and returns its answer', async () => {
    const answer = await network.fetch('p', allowed, 'https://api.example.com/v1/zones?x=1', {
      method: 'post',
      headers: { Authorization: 'Bearer t', Host: 'evil.example', 'Content-Length': '99' },
      body: '{}',
    });
    assert.deepEqual(answer, { status: 200, headers: { 'x-a': 'b' }, body: 'hello' });
    const request = seen.at(-1);
    assert.ok(request);
    assert.equal(request.host, 'api.example.com');
    assert.equal(request.port, 443);
    assert.equal(request.path, '/v1/zones?x=1');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['authorization'], 'Bearer t');
    assert.equal(request.headers['host'], undefined, 'the Host header is the core’s to set');
    assert.equal(request.headers['content-length'], undefined);
    assert.equal(request.address.address, ip(93, 184, 216, 34));
    await network.fetch('p', allowed, 'https://dns.example.com:8443/');
    assert.equal(seen.at(-1)?.port, 8443);
  });

  it('refuses a host or port that was not approved, and anything that is not plain https to a name', async () => {
    await refusal(network.fetch('p', allowed, 'https://other.example.com/'));
    await refusal(network.fetch('p', allowed, 'https://api.example.com:444/'));
    await refusal(network.fetch('p', allowed, 'https://dns.example.com/'));
    await refusal(network.fetch('p', allowed, 'http://api.example.com/'));
    const withLogin = new URL('https://api.example.com/');
    withLogin.username = 'user';
    withLogin.password = 'secret';
    await refusal(network.fetch('p', allowed, withLogin.href));
    await refusal(network.fetch('p', allowed, `https://${ip(93, 184, 216, 34)}/`));
    await refusal(network.fetch('p', allowed, 'https://127.0.0.1/'));
    await refusal(network.fetch('p', allowed, 'not a url'));
    await refusal(network.fetch('p', allowed, 'ftp://api.example.com/'));
    await refusal(network.fetch('p', [], 'https://api.example.com/'));
    await refusal(network.fetch('p', allowed, 'https://api.example.com/', { method: 'CONNECT' }));
  });

  it('refuses a name that resolves to an address that is not public, even one mixed with public ones', async () => {
    for (const bad of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.0.10']) {
      const guarded = new PluginNetwork({
        resolve: () => Promise.resolve([...PUBLIC, { address: bad, family: 4 as const }]),
        transport: () => Promise.reject(new Error('must not be reached')),
      });
      await assert.rejects(
        guarded.fetch('p', allowed, 'https://api.example.com/'),
        (error: unknown) => error instanceof NetworkRefused && error.reason === 'address',
        bad,
      );
    }
    const none = new PluginNetwork({
      resolve: () => Promise.resolve([]),
      transport: () => Promise.reject(new Error('no')),
    });
    await refusal(none.fetch('p', allowed, 'https://api.example.com/'));
  });

  it('bounds the size of what goes out and how many requests are in flight', async () => {
    await refusal(
      network.fetch('p', allowed, 'https://api.example.com/', {
        method: 'POST',
        body: 'x'.repeat(1024 * 1024 + 1),
      }),
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new PluginNetwork({
      resolve: () => Promise.resolve(PUBLIC),
      transport: async () => {
        await gate;
        return { status: 204, headers: {}, body: '' };
      },
    });
    const busy = Array.from({ length: 4 }, () =>
      slow.fetch('q', allowed, 'https://api.example.com/'),
    );
    await refusal(slow.fetch('q', allowed, 'https://api.example.com/'));
    release();
    await Promise.all(busy);
    assert.equal((await slow.fetch('q', allowed, 'https://api.example.com/')).status, 204);
  });

  describe('against a server on this machine', () => {
    let server: Server;
    let port = 0;
    let lastHost: string | undefined;
    before(async () => {
      server = createServer((request, response) => {
        lastHost = request.headers.host;
        if (request.url === '/big') {
          response.end('x'.repeat(5 * 1024 * 1024));
          return;
        }
        response.setHeader('X-Test', 'yes');
        // JSON, not HTML: the request path is echoed back.
        response.setHeader('Content-Type', 'application/json');
        response.statusCode = request.url === '/missing' ? 404 : 200;
        response.end(JSON.stringify({ method: request.method, url: request.url }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
    });
    after(() => {
      server.close();
    });

    const local = () =>
      new PluginNetwork({
        plain: true,
        resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
        allowAddress: () => true,
      });

    it('connects to the address that was checked, under the name that was approved', async () => {
      const answer = await local().fetch(
        'p',
        [`api.example.com:${String(port)}`],
        `http://api.example.com:${String(port)}/zones`,
        {
          method: 'PUT',
        },
      );
      assert.equal(answer.status, 200);
      assert.equal(answer.headers['x-test'], 'yes');
      assert.deepEqual(JSON.parse(answer.body), { method: 'PUT', url: '/zones' });
      assert.equal(lastHost, `api.example.com:${String(port)}`);
      assert.equal(
        (
          await local().fetch(
            'p',
            [`api.example.com:${String(port)}`],
            `http://api.example.com:${String(port)}/missing`,
          )
        ).status,
        404,
      );
    });

    it('refuses an answer that is too large', async () => {
      await assert.rejects(
        local().fetch(
          'p',
          [`api.example.com:${String(port)}`],
          `http://api.example.com:${String(port)}/big`,
        ),
      );
    });
  });
});

describe('a plugin in its process', () => {
  let root: string;
  let directory: string;
  let outside: string;
  let server: Server;
  let port = 0;
  let requests = 0;
  const processes: PluginProcess[] = [];
  const seen: TransportRequest[] = [];
  const gateway = new PluginNetwork({
    resolve: () => Promise.resolve(PUBLIC),
    transport: (request) => {
      seen.push(request);
      return Promise.resolve({
        status: 200,
        headers: {},
        body: `answered ${request.host}${request.path}`,
      });
    },
  });

  const start = async (overrides: Partial<Parameters<typeof PluginProcess.start>[0]> = {}) => {
    const started = await PluginProcess.start({
      pluginId: 'dns-example',
      directory,
      modules: [{ kind: 'DnsProvider', entry: 'dist/entry.js' }],
      services: servicesFor({ gateway }),
      runnerPath: RUNNER,
      memoryMiB: 64,
      startTimeoutMs: 15_000,
      ...overrides,
    });
    processes.push(started);
    return started;
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'sw-host-'));
    directory = await writeFixture(root, 'dns-example');
    outside = join(root, 'outside.txt');
    await writeFile(outside, 'a file the plugin has no business reading');
    server = createServer((_request, response) => {
      requests += 1;
      response.end('hi');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    process.env['SW_TEST_SECRET'] = 'hunter2';
  });
  after(async () => {
    delete process.env['SW_TEST_SECRET'];
    await Promise.all(processes.map((p) => p.stop()));
    server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('loads its modules and says which methods each offers', async () => {
    const plugin = await start();
    const snapshot = plugin.snapshot();
    assert.equal(snapshot.state, 'running');
    const [loaded] = snapshot.modules;
    assert.equal(snapshot.modules.length, 1);
    assert.ok(loaded);
    assert.equal(loaded.kind, 'DnsProvider');
    for (const method of ['echo', 'hog', 'loop', 'pid', 'probe', 'refused', 'throws', 'viaCore']) {
      assert.ok(loaded.methods.includes(method), method);
    }
    assert.deepEqual(loaded.methods, [...loaded.methods].sort(), 'listed in order');
    assert.deepEqual(await plugin.call('DnsProvider', 'echo', { a: [1, 'two'] }, 5000), {
      a: [1, 'two'],
    });
    assert.equal(plugin.snapshot().calls, 1);
  });

  it('runs in a process of its own, not the core', async () => {
    const plugin = await start();
    const pid = await plugin.call('DnsProvider', 'pid', null, 5000);
    assert.equal(typeof pid, 'number');
    assert.notEqual(pid, process.pid);
    assert.equal(pid, plugin.pid);
  });

  it('can read its own files and nothing else, and cannot write, run programs, start workers, reach the network or generate code', async () => {
    const plugin = await start();
    const found = (await plugin.call('DnsProvider', 'probe', { outside, port }, 10_000)) as Record<
      string,
      { ok: boolean; code?: string } | string[]
    >;
    const result = (name: string) => found[name] as { ok: boolean; code?: string };
    assert.equal(result('readOwn').ok, true, 'it reads its own module');
    for (const name of ['readOutside', 'writeOwn', 'spawn', 'worker']) {
      assert.deepEqual(result(name), { ok: false, code: 'ERR_ACCESS_DENIED' }, name);
    }
    assert.equal(result('fetch').ok, false, 'no direct network');
    assert.equal(requests, 0, 'the server on this machine never saw a request');
    assert.equal(result('eval').ok, false);
    assert.equal(result('newFunction').ok, false);
    assert.equal(result('binding').ok, false);
    assert.equal(result('eval').code, 'EvalError');
  });

  it('does not see the environment of the core', async () => {
    const plugin = await start();
    const found = (await plugin.call('DnsProvider', 'probe', { outside, port }, 10_000)) as {
      envKeys: string[];
    };
    assert.equal(found.envKeys.includes('SW_TEST_SECRET'), false);
    assert.equal(found.envKeys.includes('SW_AUTH_KEY'), false);
    assert.equal(
      found.envKeys.some((k) => k.startsWith('SW_')),
      false,
    );
    if (process.platform !== 'win32') {
      assert.deepEqual(found.envKeys, []);
    }
  });

  it('reaches the network only through the core, and only the approved hosts', async () => {
    const plugin = await start();
    const answer = await plugin.call(
      'DnsProvider',
      'viaCore',
      { url: 'https://api.example.com/v1/x', init: { method: 'GET' } },
      5000,
    );
    assert.deepEqual(answer, { status: 200, ok: true, body: 'answered api.example.com/v1/x' });
    const denied: { host: string; reason: string }[] = [];
    const watched = await start({
      services: servicesFor({
        gateway,
        onRefused: (host, reason) => denied.push({ host, reason }),
      }),
    });
    const message = await watched.call(
      'DnsProvider',
      'refused',
      { url: 'https://evil.example.org/steal' },
      5000,
    );
    assert.match(String(message), /not among the hosts this plugin was approved to call/u);
    assert.deepEqual(denied, [{ host: 'evil.example.org', reason: 'not_allowed' }]);
  });

  it('gets its settings with every call, never a secret with them, and asks the core for one', async () => {
    const plugin = await start({
      services: servicesFor({
        gateway,
        settings: { zone: 'example.org', ttl: 300 },
        secrets: { token: 'hunter2-value' },
      }),
    });
    assert.deepEqual(await plugin.call('DnsProvider', 'config', null, 5000), {
      zone: 'example.org',
      ttl: 300,
    });
    assert.equal(
      await plugin.call('DnsProvider', 'secret', { field: 'token' }, 5000),
      'hunter2-value',
    );
    assert.equal(
      await plugin.call('DnsProvider', 'secretRefused', { field: 'other' }, 5000),
      'refused: no secret is chosen for other',
    );
  });

  it('has a storage of its own that it reads and writes through the core', async () => {
    const plugin = await start();
    assert.deepEqual(
      await plugin.call('DnsProvider', 'store', { key: 'k', value: { n: [1, 2] } }, 5000),
      {
        n: [1, 2],
      },
    );
    assert.deepEqual(await plugin.call('DnsProvider', 'storedKeys', null, 5000), ['k']);
    assert.deepEqual(await plugin.call('DnsProvider', 'forget', { key: 'k' }, 5000), []);
  });

  it('is not called when its settings are not filled in, and says which', async () => {
    const services = {
      ...servicesFor({ gateway }),
      settings: () => Promise.reject(new Error('The plugin is not configured: zone is required.')),
    };
    const plugin = await start({ services });
    await assert.rejects(plugin.call('DnsProvider', 'echo', 1, 5000), (error: unknown) => {
      assert.ok(error instanceof PluginCallError);
      assert.equal(error.reason, 'not_configured');
      assert.match(error.message, /zone is required/u);
      return true;
    });
    assert.equal(
      plugin.snapshot().state,
      'running',
      'it is the settings that are missing, not the plugin',
    );
  });

  it('reports an error a method throws without going down', async () => {
    const plugin = await start();
    await assert.rejects(plugin.call('DnsProvider', 'throws', null, 5000), (error: unknown) => {
      assert.ok(error instanceof PluginCallError);
      assert.equal(error.reason, 'failed');
      assert.equal(error.message, 'nope');
      return true;
    });
    assert.equal(plugin.snapshot().state, 'running');
    assert.deepEqual(await plugin.call('DnsProvider', 'echo', 1, 5000), 1);
  });

  it('refuses a method it does not have, including the ones every object has', async () => {
    const plugin = await start();
    for (const method of ['nothing', 'constructor', 'toString', '__proto__']) {
      await assert.rejects(plugin.call('DnsProvider', method, null, 5000), /no method/u, method);
    }
    await assert.rejects(plugin.call('NodeFlavor', 'echo', null, 5000), /no method/u);
  });

  it('is ended when a call takes too long, and says so', async () => {
    const plugin = await start();
    const pid = plugin.pid;
    await assert.rejects(plugin.call('DnsProvider', 'loop', null, 400), (error: unknown) => {
      assert.ok(error instanceof PluginCallError);
      assert.equal(error.reason, 'timeout');
      return true;
    });
    const snapshot = plugin.snapshot();
    assert.equal(snapshot.state, 'failed');
    assert.match(snapshot.lastError ?? '', /took longer than/u);
    await assert.rejects(plugin.call('DnsProvider', 'echo', 1, 1000), /took longer/u);
    await waitForExit(pid);
  });

  it('is ended when it uses more memory than it was given', async () => {
    const plugin = await start({ memoryMiB: 32 });
    await assert.rejects(plugin.call('DnsProvider', 'hog', null, 20_000), (error: unknown) => {
      assert.ok(error instanceof PluginCallError);
      assert.equal(error.reason, 'crashed');
      return true;
    });
    assert.equal(plugin.snapshot().state, 'failed');
    assert.match(plugin.snapshot().lastError ?? '', /ended/u);
  });

  it('can be stopped on purpose, and is gone', async () => {
    const plugin = await start();
    const pid = plugin.pid;
    await plugin.stop();
    assert.equal(plugin.snapshot().state, 'stopped');
    await assert.rejects(plugin.call('DnsProvider', 'echo', 1, 1000), /not running|stopped/u);
    await waitForExit(pid);
  });

  it('reports a core-owned diagnostic when a module cannot be loaded', async () => {
    const safe = (error: unknown): boolean =>
      error instanceof PluginCallError &&
      error.reason === 'failed' &&
      error.message === 'The plugin could not load its modules.';
    await assert.rejects(
      start({ modules: [{ kind: 'DnsProvider', entry: 'dist/missing.js' }] }),
      safe,
    );
    const broken = await writeFixture(root, 'broken', 'throw new Error("boom at load");\n');
    await assert.rejects(start({ directory: broken }), safe);
    const bare = await writeFixture(root, 'bare', 'export default {};\n');
    await assert.rejects(start({ directory: bare }), safe);
    const wrong = await writeFixture(root, 'wrong', 'export default { methods: { a: 1 } };\n');
    await assert.rejects(start({ directory: wrong }), safe);
  });

  it('keeps nothing the plugin printed: a secret it printed before it died does not reach the last error', async () => {
    const plugin = await start({
      services: servicesFor({ gateway, secrets: { token: 'printed-synthetic-value' } }),
    });
    await assert.rejects(
      plugin.call('DnsProvider', 'printAndDie', { field: 'token' }, 5000),
      (error: unknown) => error instanceof PluginCallError && error.reason === 'crashed',
    );
    const { lastError, state } = plugin.snapshot();
    assert.equal(state, 'failed');
    assert.equal(lastError, 'The plugin process ended with code 3.');
  });

  it('answers a request to the core only while a call is under way', async () => {
    const plugin = await start({
      services: servicesFor({ gateway, secrets: { token: 'kept-synthetic-value' } }),
    });
    assert.equal(await plugin.call('DnsProvider', 'keep', null, 5000), 'kept');
    // A context kept from a call that is over is refused, though the call that uses it now is live.
    assert.match(
      String(await plugin.call('DnsProvider', 'later', { field: 'token' }, 5000)),
      /^refused: The core answers a plugin only while a call to it is under way\./u,
    );
  });

  it('limits how often one call may ask the core', async () => {
    const plugin = await start();
    assert.match(
      String(await plugin.call('DnsProvider', 'flood', { times: 300 }, 20_000)),
      /at most 256 times/u,
    );
    assert.equal(await plugin.call('DnsProvider', 'flood', { times: 10 }, 5000), '');
  });

  it('refuses a ninth simultaneous broker request while the first eight are pending', async () => {
    const services = servicesFor({ gateway });
    let admitted = 0;
    let release = (): void => undefined;
    const hold = new Promise<string[]>((resolve) => {
      release = () => {
        resolve([]);
      };
    });
    const plugin = await start({
      services: {
        ...services,
        storage: {
          ...services.storage,
          keys: () => {
            admitted += 1;
            return hold;
          },
        },
      },
    });
    try {
      await assert.rejects(
        plugin.call('DnsProvider', 'burst', { times: 9 }, 5000),
        /Too many requests at once/u,
      );
      assert.equal(admitted, 8);
    } finally {
      release();
    }
  });

  it('survives a message of the wrong shape: the process is ended, the core is not', async () => {
    for (const message of [
      { type: 'failed', message: 1 },
      { type: 'ready' },
      { type: 'result', id: 'x' },
      { type: 'result', id: 1, value: 'x'.repeat(4 * 1024 * 1024 + 1) },
      { type: 'core', id: 1, op: 'secret', field: 'token' },
      {
        type: 'core',
        id: 1,
        call: 1,
        op: 'fetch',
        url: 'https://example.com',
        init: { method: 1 },
      },
      'not even an object',
    ]) {
      const plugin = await start();
      await assert.rejects(
        plugin.call('DnsProvider', 'rogue', { message }, 5000),
        (error: unknown) => error instanceof PluginCallError,
        typeof message === 'string' ? message : message.type,
      );
      assert.equal(plugin.snapshot().state, 'failed');
      assert.match(plugin.snapshot().lastError ?? '', /does not accept/u);
    }
  });

  it('fails a call as secret_expired when the vault refused it an expired secret', async () => {
    const plugin = await start({ services: servicesFor({ gateway, expired: ['token'] }) });
    await assert.rejects(
      plugin.call('DnsProvider', 'secret', { field: 'token' }, 5000),
      (error: unknown) => error instanceof PluginCallError && error.reason === 'secret_expired',
    );
    // An error the plugin makes up with the same words is just a failure.
    await assert.rejects(
      plugin.call('DnsProvider', 'throws', null, 5000),
      (error: unknown) => error instanceof PluginCallError && error.reason === 'failed',
    );
  });

  it('admits no more calls than the limit, even when they all arrive while the settings are read', async () => {
    const base = servicesFor({ gateway });
    const plugin = await start({
      services: {
        ...base,
        settings: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({});
            }, 200);
          }),
      },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () => plugin.call('DnsProvider', 'slow', null, 5000)),
    );
    const busy = results.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof PluginCallError &&
        r.reason.reason === 'busy',
    );
    assert.equal(busy.length, 1);
  });

  it('ends a request to the network that a call made when the call is over', async () => {
    let aborted: Promise<boolean> | undefined;
    const hanging = new PluginNetwork({
      resolve: () => Promise.resolve(PUBLIC),
      transport: (request) => {
        aborted = new Promise<boolean>((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve(true);
          });
          setTimeout(() => {
            resolve(false);
          }, 5000);
        });
        return new Promise(() => undefined);
      },
    });
    const plugin = await start({ services: servicesFor({ gateway: hanging }) });
    await assert.rejects(
      plugin.call('DnsProvider', 'viaCore', { url: 'https://api.example.com/slow' }, 500),
      (error: unknown) => error instanceof PluginCallError && error.reason === 'timeout',
    );
    assert.ok(aborted);
    assert.equal(await aborted, true);
  });

  it('is killed when it is stopped while it starts', async () => {
    const controller = new AbortController();
    const slow = await writeFixture(
      root,
      'slow-start',
      'await new Promise((r) => setTimeout(r, 3000));\nexport default { methods: { a: () => 1 } };\n',
    );
    const started = start({ directory: slow, signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 300);
    await assert.rejects(
      started,
      (error: unknown) => error instanceof PluginCallError && error.reason === 'not_running',
    );
  });

  it('does not start when the runtime itself cannot be run', async () => {
    await assert.rejects(start({ execPath: join(root, 'no-such-node') }));
  });
});

/** The process is gone within a moment of being told to stop. */
async function waitForExit(pid: number | undefined): Promise<void> {
  assert.ok(pid !== undefined);
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`process ${String(pid)} is still running`);
}
