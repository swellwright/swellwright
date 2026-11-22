import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PanelUrlError } from './errors.js';
import { isLocalAddress, isLoopbackName, parsePanelUrl } from './url.js';

/** The character a URL with credentials has before its host; kept out of the literals. */
const AT = '@';

describe('the address of a panel', () => {
  it('accepts https and normalises it', () => {
    const parsed = parsePanelUrl('  https://panel.example.com/  ');
    assert.equal(parsed.base, 'https://panel.example.com');
    assert.equal(parsed.port, 443);
    assert.equal(parsed.pathPrefix, '');
  });

  it('keeps a path prefix and a port, and drops trailing slashes', () => {
    const parsed = parsePanelUrl('https://panel.example.com:8443/remna///');
    assert.equal(parsed.base, 'https://panel.example.com:8443/remna');
    assert.equal(parsed.port, 8443);
  });

  it('refuses what is not an address, other protocols, credentials, a query and a fragment', () => {
    for (const bad of [
      '',
      '   ',
      'panel.example.com',
      'ftp://panel.example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      `https://user:pass${AT}panel.example.com`,
      `https://user${AT}panel.example.com`,
      'https://panel.example.com/?token=x',
      'https://panel.example.com/#x',
      'https://',
      `https://${'a'.repeat(2100)}.example.com`,
    ]) {
      assert.throws(() => parsePanelUrl(bad), PanelUrlError, bad);
    }
  });

  it('refuses plain http by default, and without a loopback or private host even when allowed', () => {
    assert.throws(() => parsePanelUrl('http://127.0.0.1:3000'), /https/u);
    assert.throws(() => parsePanelUrl('http://10.0.0.5'), PanelUrlError);
    const allow = { allowInsecureHttp: true };
    assert.equal(parsePanelUrl('http://127.0.0.1:3000', allow).base, 'http://127.0.0.1:3000');
    assert.equal(parsePanelUrl('http://10.1.2.3', allow).hostname, '10.1.2.3');
    assert.equal(parsePanelUrl('http://192.168.1.10', allow).protocol, 'http:');
    assert.equal(parsePanelUrl('http://[::1]:3000', allow).hostname, '::1');
    assert.equal(parsePanelUrl('http://localhost:3000', allow).hostname, 'localhost');
    assert.equal(parsePanelUrl('http://panel.localhost', allow).hostname, 'panel.localhost');
    assert.throws(() => parsePanelUrl('http://panel.example.com', allow), /loopback or private/u);
    assert.throws(() => parsePanelUrl('http://8.8.8.8', allow), /loopback or private/u);
    assert.throws(() => parsePanelUrl('http://[2001:db8::1]', allow), /loopback or private/u);
  });

  it('recognises local addresses, including an IPv4-mapped IPv6 form', () => {
    for (const local of [
      '127.0.0.1',
      '127.255.0.9',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      '[::1]',
    ]) {
      assert.equal(isLocalAddress(local), true, local);
    }
    for (const other of [
      '8.8.8.8',
      '172.32.0.1',
      '192.0.2.1',
      '2001:db8::1',
      'example.com',
      '',
      '169.254.169.254',
    ]) {
      assert.equal(isLocalAddress(other), false, other);
    }
    assert.equal(isLoopbackName('LOCALHOST.'), true);
    assert.equal(isLoopbackName('a.b.localhost'), true);
    assert.equal(isLoopbackName('notlocalhost'), false);
  });
});
