import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalJson,
  contentHash,
  MASK,
  maskSecrets,
  maskText,
  UNREADABLE_DOCUMENT,
} from './mask.js';

const KEY = 'a-test-key-for-fingerprints';
/** The character a URL with credentials has before its host, and PEM lines: kept out of the literals. */
const AT = '@';
const begin = (kind: string): string => `-----BEGIN ${kind} KEY-----`;
const end = (kind: string): string => `-----END ${kind} KEY-----`;

const text = (value: unknown): string => JSON.stringify(value);

describe('masking secrets', () => {
  it('masks REALITY keys, short ids and passwords by the name of the key', () => {
    const { value, count } = maskSecrets({
      realitySettings: {
        privateKey: 'PRIV',
        shortIds: ['aa', 'bb', ''],
        serverNames: ['a.example.com'],
        publicKey: 'PUB',
      },
      settings: { password: 'PW', obfsPassword: 'OB', adminSecret: 'S', method: 'aes-256-gcm' },
    });
    const out = text(value);
    for (const secret of ['PRIV', '"aa"', '"bb"', 'PW', 'OB', '"S"']) {
      assert.ok(!out.includes(secret), secret);
    }
    // What is not secret stays readable, and the shape of a list of short ids is kept.
    assert.match(out, /a\.example\.com/u);
    assert.ok(out.includes('PUB') && out.includes('aes-256-gcm'));
    const ids = (value as { realitySettings: { shortIds: string[] } }).realitySettings.shortIds;
    assert.deepEqual(ids, [MASK, MASK, '']);
    assert.equal(count, 6);
  });

  it('ignores the case and the separators of a name', () => {
    const { value } = maskSecrets({
      PRIVATE_KEY: 'a',
      'private-key': 'b',
      PrivateKey: 'c',
      'Short Ids': ['d'],
      ClientSecret: 'e',
      'X-Api-Key': 'f',
    });
    assert.ok(!/"[a-f]"/u.test(text(value).replace(/"[A-Za-z _-]+":/gu, '')), text(value));
  });

  it('masks the ids and logins of the clients and accounts of an inbound, and keeps their labels', () => {
    const { value } = maskSecrets({
      settings: {
        clients: [
          { id: 'CLIENT-ID', flow: 'xtls-rprx-vision', email: 'person@example.com', level: 0 },
        ],
        accounts: [{ user: 'LOGIN', pass: 'PASS' }],
        auth: 'password',
        vnext: [{ users: [{ id: 'OUT-ID', encryption: 'none' }] }],
      },
    });
    const out = text(value);
    for (const secret of ['CLIENT-ID', 'person@example.com', 'LOGIN', 'PASS', 'OUT-ID']) {
      assert.ok(!out.includes(secret), secret);
    }
    assert.ok(
      out.includes('xtls-rprx-vision') &&
        out.includes('"auth":"password"') &&
        out.includes('"encryption":"none"'),
    );
  });

  it('masks a decryption string but not `none`, and an auth value that is not a plain mode', () => {
    assert.equal(maskSecrets({ decryption: 'none' }).value.decryption, 'none');
    assert.equal(
      maskSecrets({ decryption: 'mlkem768x25519plus.native.600s.SECRET' }).value.decryption,
      MASK,
    );
    assert.equal(maskSecrets({ auth: 'noauth' }).value.auth, 'noauth');
    assert.equal(maskSecrets({ auth: 'a-real-secret' }).value.auth, MASK);
    assert.equal(maskSecrets({ auth: true }).value.auth, true);
  });

  it('masks the value of a header pair whose name is sensitive, and not another', () => {
    const { value } = maskSecrets({
      headers: [
        { key: 'Authorization', value: 'Bearer SECRET-ONE' },
        { name: 'X-Api-Key', value: 'SECRET-TWO' },
        { key: 'Profile-Title', value: 'Hello' },
        { headerName: 'Cookie', value: 'SECRET-THREE' },
      ],
    });
    const out = text(value);
    for (const secret of ['SECRET-ONE', 'SECRET-TWO', 'SECRET-THREE']) {
      assert.ok(!out.includes(secret), secret);
    }
    assert.ok(out.includes('Hello') && out.includes('Profile-Title'));
  });

  it('masks a key that holds a PEM or a list of its lines, but not the `key` of a pair', () => {
    const { value } = maskSecrets({
      certificates: [
        {
          certificateFile: '/etc/c.pem',
          key: [begin('PRIVATE'), 'AAAA', end('PRIVATE')],
        },
      ],
      headers: [{ key: 'X-Note', value: 'plain' }],
    });
    const out = text(value);
    assert.ok(!out.includes('AAAA') && !out.includes('BEGIN PRIVATE'));
    assert.ok(out.includes('X-Note') && out.includes('plain') && out.includes('/etc/c.pem'));
  });

  it('finds a PEM private key under an innocent name, and every kind of PEM private key', () => {
    for (const kind of [
      'PRIVATE KEY',
      'RSA PRIVATE KEY',
      'EC PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
    ]) {
      const pem = `-----BEGIN ${kind}-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END ${kind}-----`;
      const { value } = maskSecrets({ note: `keep ${pem} done`, innocent: pem });
      const out = text(value);
      assert.ok(!out.includes('MIIEvQ'), kind);
      assert.ok(out.includes('keep ') && out.includes(' done'), kind);
    }
    // An unterminated block is masked to the end of the text.
    assert.ok(
      !text(maskSecrets({ x: `${begin('PRIVATE')}\nAAAABBBB` }).value).includes('AAAABBBB'),
    );
    // A public certificate is not secret.
    assert.ok(
      text(
        maskSecrets({ x: '-----BEGIN CERTIFICATE-----\nMIIDpublic\n-----END CERTIFICATE-----' })
          .value,
      ).includes('MIIDpublic'),
    );
  });

  it('masks credentials in URLs, secret query parameters, bearer tokens and JWTs wherever they are', () => {
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJ1dWlkIjoiYWJjZGVmIn0',
      'c2lnbmF0dXJlLXNpZ25hdHVyZQ',
    ].join('.');
    const { value } = maskSecrets({
      proxyUrl: 'socks5://login:PROXY-PASS@192.0.2.1:1080',
      link: `vless://USER-UUID${AT}node.example.com:443?security=reality&pbk=PUBKEY&sid=SHORT-ID&type=tcp#name`,
      hook: 'https://hooks.example.com/x?token=HOOK-TOKEN&format=json',
      header: 'Authorization: Bearer BEARER-VALUE-1234',
      loose: `something ${jwt} else`,
    });
    const out = text(value);
    for (const secret of [
      'PROXY-PASS',
      'login:',
      'USER-UUID',
      'SHORT-ID',
      'HOOK-TOKEN',
      'BEARER-VALUE-1234',
      jwt,
    ]) {
      assert.ok(!out.includes(secret), secret);
    }
    // The parts that are not secret stay.
    for (const kept of [
      '192.0.2.1:1080',
      'node.example.com',
      'PUBKEY',
      'format=json',
      'hooks.example.com',
    ]) {
      assert.ok(out.includes(kept), kept);
    }
  });

  it('finds a secret inside a JSON document that is itself a string', () => {
    const inner = JSON.stringify({ outbound: { password: 'INNER-SECRET', note: 'visible' } });
    const { value, count } = maskSecrets({
      blob: inner,
      array: JSON.stringify([{ privateKey: 'INNER-KEY' }]),
    });
    const out = text(value);
    assert.ok(!out.includes('INNER-SECRET') && !out.includes('INNER-KEY'));
    assert.ok(out.includes('visible'));
    assert.equal(count, 2);
    // A string that only looks like JSON is left alone.
    assert.equal(maskSecrets({ x: '{ not json' }).value.x, UNREADABLE_DOCUMENT);
    // A document without a secret is returned as it was (not rewritten).
    const plain = '{ "a" : 1 }';
    assert.equal(maskSecrets({ x: plain }).value.x, plain);
  });

  it('masks everything inside an array or object under a secret name, keeping the shape', () => {
    const { value } = maskSecrets({
      secret: { nested: ['a', { deep: 'b' }, 3, true, null, ''] },
      shortIds: [1, 'x'],
    });
    assert.deepEqual(value, {
      secret: { nested: [MASK, { deep: MASK }, MASK, MASK, null, ''] },
      shortIds: [MASK, MASK],
    });
  });

  it('survives hostile structures: prototype keys, very deep nesting, huge arrays, odd values', () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": true, "password": "P1"}, "constructor": {"prototype": {"x": 1}}, "privateKey": "P2"}',
    ) as unknown;
    const { value } = maskSecrets(hostile);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.ok(!text(value).includes('P1') && !text(value).includes('P2'));

    // Nesting beyond the limit is replaced as a whole instead of being walked: it fails closed.
    let deep: unknown = { password: 'DEEP-SECRET' };
    for (let i = 0; i < 200; i += 1) {
      deep = { next: deep };
    }
    const out = text(maskSecrets(deep).value);
    assert.ok(!out.includes('DEEP-SECRET'));

    // A long list is handled and every secret in it is found.
    const many = Array.from({ length: 20_000 }, (_unused, i) => ({
      id: i,
      password: `PW-${String(i)}`,
    }));
    const result = maskSecrets(many);
    assert.equal(result.count, 20_000);
    assert.ok(!text(result.value).includes('PW-19999'));

    for (const odd of [
      null,
      undefined,
      0,
      -0,
      true,
      'text',
      [],
      {},
      [[[]]],
      { a: { b: { c: [] } } },
    ]) {
      assert.doesNotThrow(() => maskSecrets(odd));
    }
  });

  it('does not change its input and shares no object with it', () => {
    const input = { a: { privateKey: 'K', list: [{ password: 'P' }] } };
    const before = text(input);
    const { value } = maskSecrets(input);
    assert.equal(text(input), before);
    assert.notEqual(value.a, input.a);
    assert.notEqual(value.a.list, input.a.list);
  });

  it('puts a keyed fingerprint in the mask: equal values match, other values and other keys do not', () => {
    const one = maskSecrets({ privateKey: 'same-value' }, { fingerprintKey: KEY }).value.privateKey;
    const again = maskSecrets({ x: { privateKey: 'same-value' } }, { fingerprintKey: KEY }).value.x
      .privateKey;
    const other = maskSecrets({ privateKey: 'another-value' }, { fingerprintKey: KEY }).value
      .privateKey;
    const otherKey = maskSecrets(
      { privateKey: 'same-value' },
      { fingerprintKey: 'a-different-key' },
    ).value.privateKey;
    assert.match(one, /^\[masked:[0-9a-f]{8}\]$/u);
    assert.equal(one, again);
    assert.notEqual(one, other);
    assert.notEqual(one, otherKey);
    assert.equal(maskSecrets({ privateKey: 'same-value' }).value.privateKey, MASK);
    // The fingerprint reveals nothing about the value.
    assert.ok(!one.includes('same-value'));
  });

  it('masks a URL given on its own', () => {
    assert.equal(maskText('socks5://u:p@192.0.2.1:1080').value, `socks5://${MASK}@192.0.2.1:1080`);
    assert.equal(maskText('https://hosting.example.com/login').count, 0);
  });
});

describe('canonical JSON and the content hash', () => {
  it('sorts keys, drops undefined and writes -0 as 0, so one value has one text', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }),
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
    assert.equal(canonicalJson([undefined]), '[null]');
    assert.throws(() => canonicalJson({ n: Number.NaN }));
    assert.throws(() => canonicalJson({ f: () => 1 }));
  });

  it('is the same for the same content in any key order, and different for other content', () => {
    assert.equal(contentHash({ a: 1, b: [1, 2] }), contentHash({ b: [1, 2], a: 1 }));
    assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
    assert.match(contentHash({}), /^[0-9a-f]{64}$/u);
  });

  it('stays the same when a secret is read again and changes when a secret is rotated (with a fingerprint key)', () => {
    const hash = (privateKey: string): string =>
      contentHash(maskSecrets({ privateKey, tag: 'x' }, { fingerprintKey: KEY }).value);
    assert.equal(hash('k1'), hash('k1'));
    assert.notEqual(hash('k1'), hash('k2'));
    // Without a key a rotation is invisible, which is why the API always passes one.
    const plain = (privateKey: string): string => contentHash(maskSecrets({ privateKey }).value);
    assert.equal(plain('k1'), plain('k2'));
  });
});
