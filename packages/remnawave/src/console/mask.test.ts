import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MASK } from '../mask.js';
import { maskConsoleJson, maskConsoleText } from './mask.js';

const KEY = 'a-test-key-for-console-fingerprints';
const text = (value: unknown): string => JSON.stringify(value);
/** The character a URL with credentials has before its host; kept out of the literals. */
const AT = '@';
const begin = (kind: string): string => `-----BEGIN ${kind} KEY-----`;
const end = (kind: string): string => `-----END ${kind} KEY-----`;

/** Every string in a value, names of keys included: what a reader of the answer could see. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      allStrings(item, out);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      allStrings(item, out);
    }
  }
  return out;
}

const USER = {
  id: 7,
  uuid: '00000000-0000-4000-8000-000000009001',
  shortUuid: 'SECRET-SHORT-UUID',
  username: 'secret-user-name',
  email: 'secret.user@example.com',
  telegramId: 424242,
  description: 'secret note about the person',
  vlessUuid: '00000000-0000-4000-8000-000000009101',
  trojanPassword: 'SECRET-TROJAN',
  ssPassword: 'SECRET-SS',
  subscriptionUrl: 'https://sub.example.com/SECRET-SHORT-UUID',
  status: 'ACTIVE',
  userTraffic: { usedTrafficBytes: 1234 },
};
const PERSONAL_TEXTS = [
  'SECRET-SHORT-UUID',
  'secret-user-name',
  'secret.user@example.com',
  '424242',
  'secret note about the person',
  '00000000-0000-4000-8000-000000009001',
  '00000000-0000-4000-8000-000000009101',
  'SECRET-TROJAN',
  'SECRET-SS',
];

describe('masking for the API console', () => {
  it('hides the access material of a user in every answer, and leaves the rest', () => {
    const { value, count } = maskConsoleJson({ response: USER }, 'standard');
    const out = text(value);
    for (const secret of [
      'SECRET-SHORT-UUID',
      '00000000-0000-4000-8000-000000009101',
      'SECRET-TROJAN',
      'SECRET-SS',
      'sub.example.com/SECRET',
    ]) {
      assert.ok(!out.includes(secret), secret);
    }
    // What is not access material is readable in the standard profile: the person is not hidden, the credentials are.
    assert.ok(out.includes('secret-user-name') && out.includes('"ACTIVE"') && out.includes('1234'));
    assert.equal(count, 5);
  });

  it('also hides who the person is in the profile for answers about people, and keeps the number a user is addressed by', () => {
    const { value } = maskConsoleJson(
      { response: { users: [USER, { ...USER, id: 8 }], total: 2 } },
      'personal',
      KEY,
    );
    const out = text(value);
    for (const secret of PERSONAL_TEXTS) {
      assert.ok(!out.includes(secret), secret);
    }
    const users = (
      value as {
        response: { users: { id: number; status: string; userTraffic: unknown }[]; total: number };
      }
    ).response;
    assert.deepEqual(
      users.users.map((u) => u.id),
      [7, 8],
      'the numeric id is what a person addresses a user by and stays',
    );
    assert.equal(users.total, 2);
    const first = users.users[0];
    assert.equal(first?.status, 'ACTIVE');
    assert.deepEqual(first.userTraffic, { usedTrafficBytes: 1234 });
  });

  it('gives the same mask to the same value, so one person is one person across a list', () => {
    const { value } = maskConsoleJson(
      { users: [{ username: 'same' }, { username: 'same' }, { username: 'other' }] },
      'personal',
      KEY,
    );
    const names = (value as { users: { username: string }[] }).users.map((u) => u.username);
    assert.match(names[0] ?? '', /^\[masked:[0-9a-f]{8}\]$/u);
    assert.equal(names[0], names[1]);
    assert.notEqual(names[0], names[2]);
    // Without the key the mask is plain: the same value cannot be told from another.
    const plain = maskConsoleJson({ username: 'same' }, 'personal').value as { username: string };
    assert.equal(plain.username, MASK);
  });

  it('ignores the case and the separators of a name', () => {
    const { value } = maskConsoleJson(
      {
        SHORTUUID: 'A1',
        Short_Uuid: 'A2',
        'short-uuid': 'A3',
        'Subscription Url': 'A4',
        SubscriptionURL: 'A5',
        'v-less-uuid': 'A6',
      },
      'standard',
    );
    for (const secret of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
      assert.ok(!text(value).includes(`"${secret}"`), secret);
    }
  });

  it('finds a secret at any depth, in lists of lists, and keeps the shape of a list', () => {
    const { value } = maskConsoleJson(
      {
        a: [[{ b: { c: [{ shortUuid: ['X1', ['X2']] }] } }]],
        links: ['vless://u@h', 'vless://v@h'],
      },
      'standard',
    );
    const out = text(value);
    assert.ok(!out.includes('X1') && !out.includes('X2') && !out.includes('vless://u'));
    const links = (value as { links: string[] }).links;
    assert.equal(links.length, 2, 'how many links there are is still visible');
    assert.ok(links.every((l) => l.startsWith('[masked')));
  });

  it('reads a document inside a string and masks what is in it', () => {
    const inner = JSON.stringify({
      shortUuid: 'INNER-SHORT',
      nested: { subscriptionUrl: 'https://x.example.com/INNER-URL' },
    });
    const { value } = maskConsoleJson({ payload: inner, other: `[${inner}]` }, 'standard');
    const out = text(value);
    assert.ok(!out.includes('INNER-SHORT') && !out.includes('INNER-URL'), out);
  });

  it('masks the identity inside a connection link wherever the link is, whatever the name of the key', () => {
    const uuid = '00000000-0000-4000-8000-0000000091ff';
    const links = {
      anything: `vless://${uuid}${AT}node.example.com:443?type=tcp#x`,
      other: [
        `trojan://TROJAN-PASS${AT}node.example.com:443`,
        `ss://c2VjcmV0OnBhc3M${AT}node.example.com:8388`,
      ],
      vmess: 'vmess://eyJhZGQiOiJub2RlLmV4YW1wbGUuY29tIiwiaWQiOiJTRUNSRVQifQ==',
      legacy: 'ss://YWVzLTI1Ni1nY206U0VDUkVU',
      sentence: `copy this: vless://${uuid}${AT}h.example.com:1 and send it`,
    };
    const out = text(maskConsoleJson(links, 'standard').value);
    for (const secret of [
      uuid,
      'TROJAN-PASS',
      'c2VjcmV0OnBhc3M',
      'eyJhZGQi',
      'YWVzLTI1Ni1nY206U0VDUkVU',
    ]) {
      assert.ok(!out.includes(secret), `${secret} in ${out}`);
    }
    assert.match(out, /node\.example\.com:443/u, 'the host stays readable');
  });

  it('masks a pair whose name is one of the access names, and a token or a key in text', () => {
    const { value } = maskConsoleJson(
      {
        headers: [
          { name: 'subscriptionUrl', value: 'https://sub.example.com/PAIR-SECRET' },
          { name: 'Authorization', value: 'Bearer PAIR-BEARER-TOKEN' },
        ],
        note: `Bearer ABCDEFGHIJKLMNOP and ${['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlMTIz'].join('.')}`,
      },
      'standard',
    );
    const out = text(value);
    for (const secret of ['PAIR-SECRET', 'PAIR-BEARER-TOKEN', 'ABCDEFGHIJKLMNOP', 'eyJzdWIi']) {
      assert.ok(!out.includes(secret), secret);
    }
  });

  it('masks the REALITY keys and the short ids of a configuration as every masked view does', () => {
    const { value } = maskConsoleJson(
      {
        inbounds: [
          {
            settings: {
              clients: [{ id: 'CLIENT-ID-SECRET', email: 'c@example.com' }],
              decryption: 'none',
            },
            streamSettings: {
              realitySettings: { privateKey: 'REALITY-PRIVATE', shortIds: ['SID-1', 'SID-2'] },
            },
          },
        ],
      },
      'standard',
    );
    const out = text(value);
    for (const secret of ['CLIENT-ID-SECRET', 'REALITY-PRIVATE', 'SID-1', 'SID-2']) {
      assert.ok(!out.includes(secret), secret);
    }
  });

  it('keeps the people of an Xray configuration masked in the standard profile, where `users` means clients', () => {
    const standard = maskConsoleJson(
      { users: [{ id: 'XRAY-USER-ID', level: 0 }] },
      'standard',
    ).value;
    assert.ok(!text(standard).includes('XRAY-USER-ID'));
    // In the profile for people `users` is the panel's list: the number stays, the names go by their own names.
    const personal = maskConsoleJson({ users: [{ id: 12, username: 'x' }] }, 'personal').value as {
      users: { id: number }[];
    };
    assert.equal(personal.users[0]?.id, 12);
  });

  it('does not treat the names of the prototype as special, and does not change its input', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"shortUuid":"P1"},"constructor":{"prototype":{"username":"P2"}},"shortUuid":"P3"}',
    ) as Record<string, unknown>;
    const before = text(hostile);
    const { value } = maskConsoleJson(hostile, 'personal');
    assert.equal(text(hostile), before, 'the input is not changed');
    const out = text(value);
    assert.ok(!out.includes('P1') && !out.includes('P2') && !out.includes('P3'), out);
    assert.equal(
      Object.getPrototypeOf(value),
      Object.prototype,
      'the result has an ordinary prototype',
    );
  });

  it('fails closed on a structure deeper than it will read', () => {
    let deep: unknown = { shortUuid: 'DEEP-SECRET', other: 'DEEP-VISIBLE' };
    for (let i = 0; i < 100; i += 1) {
      deep = { next: deep };
    }
    const out = text(maskConsoleJson(deep, 'standard').value);
    assert.ok(!out.includes('DEEP-SECRET') && !out.includes('DEEP-VISIBLE'));
    assert.ok(out.includes(MASK));
  });

  it('masks every string of a large structure in the profile for people without leaving one behind', () => {
    const users = Array.from({ length: 2000 }, (_unused, i) => ({
      id: i,
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      username: `person-${String(i)}`,
      shortUuid: `SHORT-${String(i)}`,
      email: `p${String(i)}@example.com`,
      status: 'ACTIVE',
    }));
    const { value } = maskConsoleJson({ users }, 'personal', KEY);
    const strings = allStrings(value);
    assert.ok(!strings.some((s) => /person-|SHORT-|@example\.com|00000000-0000-4000/u.test(s)));
  });

  it('masks text that is not JSON by its values: links, keys and credentials in a page or a file', () => {
    const page = [
      `subscription: https://user:PASS-IN-URL${AT}panel.example.com/x?token=TOKEN-IN-URL`,
      begin('PRIVATE'),
      'PEM-BODY-SECRET',
      end('PRIVATE'),
      `vless://00000000-0000-4000-8000-0000000091aa${AT}node.example.com:443`,
    ].join('\n');
    const { value, count } = maskConsoleText(page, 'standard', KEY);
    for (const secret of ['PASS-IN-URL', 'TOKEN-IN-URL', 'PEM-BODY-SECRET', '0000000091aa']) {
      assert.ok(!value.includes(secret), secret);
    }
    assert.ok(count >= 4);
  });
});
