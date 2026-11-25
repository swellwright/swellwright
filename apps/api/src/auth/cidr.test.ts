import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ipInRanges, parseAddress } from './cidr.js';

describe('address ranges', () => {
  it('lets everything in when there are no ranges', () => {
    assert.equal(ipInRanges('203.0.113.9', []), true);
    assert.equal(ipInRanges(undefined, []), true);
  });

  it('matches single addresses and subnets', () => {
    assert.equal(ipInRanges('203.0.113.9', ['203.0.113.0/25']), true);
    assert.equal(ipInRanges('203.0.113.200', ['203.0.113.0/25']), false);
    assert.equal(ipInRanges('198.51.100.7', ['198.51.100.7']), true);
    assert.equal(ipInRanges('198.51.100.8', ['198.51.100.7']), false);
    assert.equal(ipInRanges('10.1.2.3', ['203.0.113.0/24', '10.0.0.0/8']), true);
    assert.equal(ipInRanges('2001:db8::5', ['2001:db8::/32']), true);
    assert.equal(ipInRanges('2001:db9::5', ['2001:db8::/32']), false);
  });

  it('reads an IPv4 address given as an IPv6 socket reports it', () => {
    assert.equal(ipInRanges('::ffff:203.0.113.9', ['203.0.113.0/25']), true);
    assert.equal(ipInRanges('::FFFF:203.0.113.200', ['203.0.113.0/25']), false);
  });

  it('keeps out an unknown address and anything that is not an address', () => {
    assert.equal(ipInRanges(undefined, ['203.0.113.0/24']), false);
    assert.equal(ipInRanges('not-an-address', ['203.0.113.0/24']), false);
    assert.equal(ipInRanges('', ['203.0.113.0/24']), false);
    // A broken range matches nothing instead of everything.
    assert.equal(ipInRanges('203.0.113.9', ['garbage']), false);
  });

  it('does not match across address families', () => {
    assert.equal(ipInRanges('203.0.113.9', ['2001:db8::/32']), false);
    assert.equal(ipInRanges('2001:db8::1', ['203.0.113.0/24']), false);
  });

  it('keeps IPv4 out of an IPv6-only policy, even ::/0', () => {
    // Node's BlockList compares an IPv4 candidate with an IPv6 rule as a mapped address, so `::/0` let it in.
    assert.equal(ipInRanges('203.0.113.9', ['::/0']), false);
    assert.equal(ipInRanges('::ffff:203.0.113.9', ['::/0']), false);
    assert.equal(ipInRanges('::ffff:cb00:7109', ['::/0']), false);
    assert.equal(ipInRanges('2001:db8::1', ['::/0']), true);
  });

  it('keeps IPv6 out of an IPv4-only policy, and a mixed policy admits both', () => {
    assert.equal(ipInRanges('2001:db8::1', ['0.0.0.0/0']), false);
    assert.equal(ipInRanges('203.0.113.9', ['0.0.0.0/0']), true);
    assert.equal(ipInRanges('2001:db8::1', ['0.0.0.0/0', '::/0']), true);
    assert.equal(ipInRanges('203.0.113.9', ['0.0.0.0/0', '::/0']), true);
  });

  it('reads every spelling of a mapped IPv4 address as IPv4', () => {
    for (const address of [
      '::ffff:203.0.113.9',
      '::FFFF:cb00:7109',
      '0:0:0:0:0:ffff:cb00:7109',
      '0000:0000:0000:0000:0000:ffff:203.0.113.9',
      '::ffff:203.0.113.9%eth0',
    ]) {
      assert.deepEqual(parseAddress(address), { address: '203.0.113.9', family: 4 }, address);
      assert.equal(ipInRanges(address, ['203.0.113.0/24']), true, address);
      assert.equal(ipInRanges(address, ['198.51.100.0/24']), false, address);
    }
    assert.deepEqual(parseAddress('2001:DB8::1'), { address: '2001:db8::1', family: 6 });
    assert.equal(parseAddress('::ffff:1.2.3.256'), null);
    assert.equal(parseAddress('nonsense'), null);
  });

  it('treats a mapped range of /96 or narrower as the IPv4 range, a broader one as IPv6', () => {
    assert.equal(ipInRanges('203.0.113.9', ['::ffff:203.0.113.0/120']), true);
    assert.equal(ipInRanges('203.0.114.9', ['::ffff:203.0.113.0/120']), false);
    assert.equal(ipInRanges('203.0.113.9', ['::ffff:0:0/96']), true);
    assert.equal(ipInRanges('203.0.113.9', ['::ffff:cb00:7109']), true);
    assert.equal(ipInRanges('203.0.113.9', ['::/64']), false);
    assert.equal(ipInRanges('2001:db8::1', ['::ffff:0:0/96']), false);
  });

  it('skips a malformed stored range and still applies the others', () => {
    for (const bad of [
      '203.0.113.0/33',
      '2001:db8::/129',
      '203.0.113.0/-1',
      '203.0.113.0/2x',
      '1/2/3',
    ]) {
      assert.equal(ipInRanges('203.0.113.9', [bad]), false, bad);
      assert.equal(ipInRanges('203.0.113.9', [bad, '203.0.113.0/24']), true, bad);
    }
    assert.equal(ipInRanges(undefined, ['::/0', '0.0.0.0/0']), false);
  });
});
