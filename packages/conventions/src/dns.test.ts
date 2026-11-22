import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DnsLookup,
  DnsQueryError,
  type DnsQuery,
  type DnsRecords,
  MAX_CNAME_CHAIN,
  queryErrorFromCode,
  resolveName,
} from './dns.js';

type Zone = Record<
  string,
  Partial<Record<'A' | 'AAAA' | 'CNAME', string[] | DnsQueryError>> & { ttl?: number }
>;

/** A resolver over a table, with the failures a real one has. */
function zone(table: Zone, log: string[] = []): DnsQuery {
  return (name, type) => {
    log.push(`${name}/${type}`);
    const entry = table[name];
    const answer = entry?.[type];
    if (answer instanceof DnsQueryError) {
      return Promise.reject(answer);
    }
    if (answer === undefined || answer.length === 0) {
      return Promise.reject(new DnsQueryError('none', 'ENODATA'));
    }
    const records: DnsRecords = { records: answer, ttl: entry?.ttl ?? null };
    return Promise.resolve(records);
  };
}

const allowPublic = (address: string): boolean =>
  !address.startsWith('127.') && address !== '::1' && !address.startsWith('169.254.');
const options = (query: DnsQuery, extra: Partial<Parameters<typeof resolveName>[1]> = {}) => ({
  query,
  allow: allowPublic,
  timeoutMs: 200,
  ...extra,
});

describe('resolving a name', () => {
  it('returns the A and AAAA records, lower case, with the smallest time to live', async () => {
    const answer = await resolveName(
      'Node.Example.COM.',
      options(
        zone({
          'node.example.com': { A: ['192.0.2.1', '192.0.2.2'], AAAA: ['2001:DB8::1'], ttl: 300 },
        }),
      ),
    );
    assert.equal(answer.status, 'ok');
    assert.deepEqual([...answer.addresses].sort(), ['192.0.2.1', '192.0.2.2', '2001:db8::1']);
    assert.equal(answer.ttl, 300);
    assert.deepEqual(answer.refused, []);
  });

  it('follows a chain of CNAME records and reports it', async () => {
    const log: string[] = [];
    const answer = await resolveName(
      'a.example.com',
      options(
        zone(
          {
            'a.example.com': { CNAME: ['b.example.com.'] },
            'b.example.com': { CNAME: ['c.example.net'] },
            'c.example.net': { A: ['192.0.2.9'] },
          },
          log,
        ),
      ),
    );
    assert.equal(answer.status, 'ok');
    assert.deepEqual(answer.cnames, ['b.example.com', 'c.example.net']);
    assert.deepEqual(answer.addresses, ['192.0.2.9']);
    assert.ok(log.includes('c.example.net/A'));
    assert.ok(
      !log.includes('a.example.com/A'),
      'a name with a CNAME has its records at the target',
    );
  });

  it('stops a chain that is too long, and a loop', async () => {
    const long: Zone = {};
    for (let i = 0; i < MAX_CNAME_CHAIN + 3; i += 1) {
      long[`h${String(i)}.example.com`] = { CNAME: [`h${String(i + 1)}.example.com`] };
    }
    long[`h${String(MAX_CNAME_CHAIN + 3)}.example.com`] = { A: ['192.0.2.1'] };
    assert.equal((await resolveName('h0.example.com', options(zone(long)))).status, 'cname_loop');
    const loop = await resolveName(
      'a.example.com',
      options(
        zone({
          'a.example.com': { CNAME: ['b.example.com'] },
          'b.example.com': { CNAME: ['a.example.com'] },
        }),
      ),
    );
    assert.equal(loop.status, 'cname_loop');
    const self = await resolveName(
      'a.example.com',
      options(zone({ 'a.example.com': { CNAME: ['a.example.com'] } })),
    );
    assert.equal(self.status, 'cname_loop');
  });

  it('allows a chain up to the limit', async () => {
    const chain: Zone = {};
    for (let i = 0; i < MAX_CNAME_CHAIN; i += 1) {
      chain[`h${String(i)}.example.com`] = { CNAME: [`h${String(i + 1)}.example.com`] };
    }
    chain[`h${String(MAX_CNAME_CHAIN)}.example.com`] = { A: ['192.0.2.1'] };
    assert.equal((await resolveName('h0.example.com', options(zone(chain)))).status, 'ok');
  });

  it('tells a name that does not exist from a failure and a timeout', async () => {
    assert.equal((await resolveName('nothing.example.com', options(zone({})))).status, 'nxdomain');
    const failing: Zone = {
      'x.example.com': {
        A: new DnsQueryError('error', 'SERVFAIL'),
        AAAA: new DnsQueryError('error', 'SERVFAIL'),
      },
    };
    assert.equal((await resolveName('x.example.com', options(zone(failing)))).status, 'error');
    const slow: Zone = {
      'x.example.com': { A: new DnsQueryError('timeout'), AAAA: ['2001:db8::1'] },
    };
    assert.equal(
      (await resolveName('x.example.com', options(zone(slow)))).status,
      'ok',
      'one family answering is enough',
    );
    const none: Zone = {
      'x.example.com': { A: new DnsQueryError('timeout'), AAAA: new DnsQueryError('none') },
    };
    assert.equal((await resolveName('x.example.com', options(zone(none)))).status, 'timeout');
    const cnameTimeout: Zone = { 'x.example.com': { CNAME: new DnsQueryError('timeout') } };
    assert.equal(
      (await resolveName('x.example.com', options(zone(cnameTimeout)))).status,
      'timeout',
    );
    const cnameFailure: Zone = { 'x.example.com': { CNAME: new DnsQueryError('error') } };
    assert.equal((await resolveName('x.example.com', options(zone(cnameFailure)))).status, 'error');
  });

  it('gives up on a resolver that never answers, after the timeout', async () => {
    const never: DnsQuery = () => new Promise(() => undefined);
    const started = performance.now();
    const answer = await resolveName('x.example.com', options(never, { timeoutMs: 40 }));
    assert.equal(answer.status, 'timeout');
    assert.ok(performance.now() - started < 1500);
  });

  it('turns an error that is not ours into one of the three kinds', async () => {
    const odd: DnsQuery = () =>
      Promise.reject(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }));
    assert.equal((await resolveName('x.example.com', options(odd))).status, 'error');
    const gone: DnsQuery = () =>
      Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    assert.equal((await resolveName('x.example.com', options(gone))).status, 'nxdomain');
    assert.equal(queryErrorFromCode('ETIMEOUT', 'm').kind, 'timeout');
    assert.equal(queryErrorFromCode(undefined, 'm').kind, 'error');
  });

  it('keeps addresses the policy refuses out of the answer, and says they were found', async () => {
    const answer = await resolveName(
      'x.example.com',
      options(
        zone({
          'x.example.com': { A: ['127.0.0.1', '192.0.2.5', '169.254.169.254'], AAAA: ['::1'] },
        }),
      ),
    );
    assert.equal(answer.status, 'ok');
    assert.deepEqual(answer.addresses, ['192.0.2.5']);
    assert.deepEqual([...answer.refused].sort(), ['127.0.0.1', '169.254.169.254', '::1']);
    const onlyRefused = await resolveName(
      'y.example.com',
      options(zone({ 'y.example.com': { A: ['127.0.0.1'] } })),
    );
    assert.deepEqual(onlyRefused.addresses, []);
    assert.deepEqual(onlyRefused.refused, ['127.0.0.1']);
  });

  it('ignores records that are not addresses', async () => {
    const answer = await resolveName(
      'x.example.com',
      options(zone({ 'x.example.com': { A: ['not an ip', '192.0.2.1'] } })),
    );
    assert.deepEqual(answer.addresses, ['192.0.2.1']);
  });

  it('does not ask about what is not a name', async () => {
    const log: string[] = [];
    for (const bad of ['', '192.0.2.1', 'two words', 'a..b', '-x.example.com']) {
      assert.equal((await resolveName(bad, options(zone({}, log)))).status, 'invalid', bad);
    }
    assert.deepEqual(log, []);
  });
});

describe('looking names up', () => {
  const table: Zone = {
    'a.example.com': { A: ['192.0.2.1'], ttl: 60 },
    'b.example.com': { A: ['192.0.2.2'] },
    'c.example.com': {},
  };

  it('answers each distinct name once, however it is written, and counts', async () => {
    const log: string[] = [];
    const lookup = new DnsLookup({
      ...options(zone(table, log)),
      concurrency: 4,
      cacheMs: 0,
      maxNames: 10,
    });
    const { answers, stats } = await lookup.lookup([
      'A.example.com',
      'a.example.com.',
      'b.example.com',
      'c.example.com',
      '192.0.2.9',
    ]);
    assert.deepEqual([...answers.keys()].sort(), [
      'a.example.com',
      'b.example.com',
      'c.example.com',
    ]);
    assert.equal(answers.get('c.example.com')?.status, 'nxdomain');
    assert.deepEqual(
      {
        names: stats.names,
        resolved: stats.resolved,
        failed: stats.failed,
        skipped: stats.skipped,
        capped: stats.capped,
      },
      { names: 3, resolved: 2, failed: 1, skipped: 0, capped: false },
    );
    assert.equal(log.filter((entry) => entry === 'a.example.com/A').length, 1);
  });

  it('looks up no more names than the cap, the first ones, and says so', async () => {
    const lookup = new DnsLookup({
      ...options(zone(table)),
      concurrency: 4,
      cacheMs: 0,
      maxNames: 2,
    });
    const { answers, stats } = await lookup.lookup([
      'a.example.com',
      'b.example.com',
      'c.example.com',
    ]);
    assert.deepEqual([...answers.keys()].sort(), ['a.example.com', 'b.example.com']);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.capped, true);
    assert.equal(stats.names, 3);
  });

  it('asks at most `concurrency` questions at a time', async () => {
    let running = 0;
    let peak = 0;
    const query: DnsQuery = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      return { records: ['192.0.2.1'], ttl: null };
    };
    const lookup = new DnsLookup({ ...options(query), concurrency: 3, cacheMs: 0, maxNames: 100 });
    const names = Array.from({ length: 20 }, (_u, i) => `n${String(i)}.example.com`);
    await lookup.lookup(names);
    // Each name asks CNAME, then A and AAAA together: the bound is on names, and each holds up to two questions.
    assert.ok(peak <= 3 * 2, `peak ${String(peak)}`);
    assert.ok(peak >= 2);
  });

  it('remembers answers that are certain, for a short time, and not failures', async () => {
    let now = 1_000;
    const log: string[] = [];
    const flaky: Zone = {
      ...table,
      'slow.example.com': { A: new DnsQueryError('timeout'), AAAA: new DnsQueryError('timeout') },
    };
    const lookup = new DnsLookup({
      ...options(zone(flaky, log)),
      concurrency: 2,
      cacheMs: 5_000,
      maxNames: 10,
      now: () => now,
    });
    const first = await lookup.lookup(['a.example.com', 'c.example.com', 'slow.example.com']);
    assert.equal(first.stats.cached, 0);
    const asked = log.length;
    now += 1_000;
    const second = await lookup.lookup(['a.example.com', 'c.example.com', 'slow.example.com']);
    assert.equal(second.stats.cached, 2, 'the address and the missing name are kept');
    assert.ok(log.length > asked, 'the timeout is asked again');
    assert.equal(log.filter((entry) => entry === 'a.example.com/A').length, 1);
    now += 10_000;
    await lookup.lookup(['a.example.com']);
    assert.equal(
      log.filter((entry) => entry === 'a.example.com/A').length,
      2,
      'an old answer is asked again',
    );
    lookup.forget();
    const third = await lookup.lookup(['a.example.com']);
    assert.equal(third.stats.cached, 0);
  });

  it('does not remember anything when the memory is off', async () => {
    const log: string[] = [];
    const lookup = new DnsLookup({
      ...options(zone(table, log)),
      concurrency: 1,
      cacheMs: 0,
      maxNames: 10,
    });
    await lookup.lookup(['a.example.com']);
    await lookup.lookup(['a.example.com']);
    assert.equal(log.filter((entry) => entry === 'a.example.com/A').length, 2);
  });
});
