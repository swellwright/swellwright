import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { maskedYaml } from '../adapters.js';
import { MASK, maskSecrets, UNREADABLE_DOCUMENT } from '../mask.js';
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
    // The page is not one clean document, so it is masked as a whole (the fail-closed rule).
    assert.equal(value, UNREADABLE_DOCUMENT);
    assert.equal(count, 1);
    // A trivial one-line text keeps the value rules, each value masked in place.
    const line = `see vless://00000000-0000-4000-8000-0000000091aa${AT}node.example.com:443`;
    const byShape = maskConsoleText(line, 'standard', KEY);
    assert.ok(!byShape.value.includes('0000000091aa'));
    assert.ok(byShape.value.includes('node.example.com'));
    assert.ok(byShape.count >= 1);
  });

  it('decodes the base64 YAML of a subscription template and masks it like any document', () => {
    const yaml = [
      '# admin password in a comment: COMMENT-SECRET',
      'proxies:',
      '  - name: upstream',
      '    type: trojan',
      '    server: node-1.example.com',
      '    password: YAML-PASSWORD-SECRET',
      '    nested:',
      '      apiToken: YAML-NESTED-TOKEN',
      `    url: https://user:YAML-URL-SECRET${AT}upstream.example.com/`,
      'dns:',
      '  nameserver: [ "https://dns.example.com/dns-query" ]',
    ].join('\n');
    const answer = {
      response: {
        uuid: '00000000-0000-4000-8000-000000000a01',
        name: 'Template with credentials',
        templateType: 'MIHOMO',
        templateJson: null,
        encodedTemplateYaml: Buffer.from(yaml, 'utf8').toString('base64'),
      },
    };
    const { value, count } = maskConsoleJson(answer, 'standard', KEY);
    const encoded = (value as { response: { encodedTemplateYaml: string } }).response
      .encodedTemplateYaml;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    for (const secret of [
      'YAML-PASSWORD-SECRET',
      'YAML-NESTED-TOKEN',
      'YAML-URL-SECRET',
      'COMMENT-SECRET',
    ]) {
      assert.ok(!decoded.includes(secret), secret);
      assert.ok(!text(value).includes(secret), secret);
    }
    // The document is still the template: its structure and its harmless values are readable.
    assert.ok(decoded.includes('type: trojan'));
    assert.ok(decoded.includes('node-1.example.com'));
    assert.match(decoded, /\[masked:[0-9a-f]{8}\]/u);
    assert.ok(count >= 3);
  });

  it('masks a template body that cannot be read as a whole, and keeps one without secrets as it was', () => {
    const unreadable = maskConsoleJson(
      { response: { encodedTemplateYaml: Buffer.from('a: [unclosed', 'utf8').toString('base64') } },
      'standard',
    );
    assert.deepEqual(unreadable.value, { response: { encodedTemplateYaml: MASK } });
    const scalar = maskConsoleJson(
      {
        response: { encodedTemplateYaml: Buffer.from('SECRET-SCALAR', 'utf8').toString('base64') },
      },
      'standard',
    );
    assert.deepEqual(scalar.value, { response: { encodedTemplateYaml: MASK } });
    const plain = Buffer.from('proxies:\n  - name: a\n    type: vless\n', 'utf8').toString(
      'base64',
    );
    const kept = maskConsoleJson({ response: { encodedTemplateYaml: plain } }, 'standard');
    assert.deepEqual(kept.value, { response: { encodedTemplateYaml: plain } });
    assert.equal(kept.count, 0);
  });

  it('masks a YAML answer by its names, not only by the shapes of values', () => {
    const yaml = [
      'proxies:',
      '  - name: a',
      '    type: ss',
      '    password: TEXT-YAML-PASSWORD',
      '    uuid: 00000000-0000-4000-8000-0000000000b1',
      'secret-note: TEXT-YAML-SECRET',
    ].join('\n');
    const { value, count } = maskConsoleText(yaml, 'standard', KEY);
    for (const secret of ['TEXT-YAML-PASSWORD', '0000000000b1', 'TEXT-YAML-SECRET']) {
      assert.ok(!value.includes(secret), secret);
    }
    assert.ok(value.includes('type: ss'));
    assert.ok(count >= 3);
    // A page that is not a YAML document keeps the rules for text.
    assert.equal(maskConsoleText('<html><body>Not found</body></html>', 'standard').count, 0);
  });

  it('reads a YAML alias of itself once, in a text answer and in a template body, and answers at once', () => {
    const cyclic = 'a: &a [*a, *a]\npassword: CYCLE-SECRET\n';
    let started = performance.now();
    const asText = maskConsoleText(cyclic, 'standard', KEY);
    assert.ok(performance.now() - started < 1000, 'the text answer took too long');
    assert.ok(!asText.value.includes('CYCLE-SECRET'));
    started = performance.now();
    const asTemplate = maskConsoleJson(
      { response: { encodedTemplateYaml: Buffer.from(cyclic, 'utf8').toString('base64') } },
      'standard',
      KEY,
    );
    assert.ok(performance.now() - started < 1000, 'the template body took too long');
    const body = (asTemplate.value as { response: { encodedTemplateYaml: string } }).response
      .encodedTemplateYaml;
    assert.ok(!Buffer.from(body, 'base64').toString('utf8').includes('CYCLE-SECRET'));
    assert.ok(!text(asTemplate.value).includes('CYCLE-SECRET'));
    // The shared masker itself, as the typed reads and the snapshots call it.
    started = performance.now();
    const direct = maskSecrets({
      encodedTemplateYaml: Buffer.from(cyclic, 'utf8').toString('base64'),
    });
    assert.ok(performance.now() - started < 1000, 'maskSecrets took too long');
    assert.ok(
      !Buffer.from(direct.value.encodedTemplateYaml, 'base64')
        .toString('utf8')
        .includes('CYCLE-SECRET'),
    );
  });

  it('masks the whole value when a structure is too large to read, instead of reading it for ever', () => {
    // Shared, not cyclic: every level points twice at the one below, 2^40 paths through a small object.
    let node: unknown = { password: 'SHARED-SECRET' };
    for (let level = 0; level < 40; level += 1) {
      node = { left: node, right: node };
    }
    const started = performance.now();
    const { value, count } = maskConsoleJson({ response: node }, 'standard');
    assert.ok(performance.now() - started < 5000, 'masking took too long');
    assert.equal(value, MASK);
    assert.ok(count > 0);
  });

  it('masks the plain items of a collection of secrets and reads the objects in it by their names', () => {
    const { value } = maskConsoleJson(
      {
        accessTokens: ['x-access'],
        authTokens: ['y-auth'],
        botTokens: ['z-bot'],
        passwords: ['p-word'],
      },
      'standard',
    );
    assert.deepEqual(value, {
      accessTokens: [MASK],
      authTokens: [MASK],
      botTokens: [MASK],
      passwords: [MASK],
    });
    const listed = maskConsoleJson(
      { apiTokens: [{ tokenName: 'ci', token: 'OBJECT-TOKEN', expiresAt: 'soon' }, 'PLAIN-TOKEN'] },
      'standard',
    );
    assert.deepEqual(listed.value, {
      apiTokens: [{ tokenName: 'ci', token: MASK, expiresAt: 'soon' }, MASK],
    });
    // A plural of a name that is not secret stays readable.
    assert.deepEqual(maskConsoleJson({ publicKeys: ['pk'] }, 'standard').value, {
      publicKeys: ['pk'],
    });
  });

  it('fails closed on a text that is not one readable YAML document', () => {
    for (const input of [
      'password: a\n---\npassword: b\n',
      'password: first-of-two\npassword: second-of-two\n',
      'name: x\npassword: dup-a\nname: y\n',
      'SECRET_KEY=env-file-secret\nPORT=1\n',
      '- password: |\n    block-secret-line\n  name: z\n: broken [\n',
    ]) {
      const { value, count } = maskConsoleText(input, 'standard');
      for (const secret of [
        'password: a',
        'password: b',
        'first-of-two',
        'second-of-two',
        'dup-a',
        'env-file-secret',
        'block-secret-line',
      ]) {
        assert.ok(!value.includes(secret), `${JSON.stringify(input)} kept ${secret}`);
      }
      assert.ok(count > 0, JSON.stringify(input));
    }
    // Several documents that can be read are kept readable, each masked.
    const stream = maskConsoleText(
      'password: a1\nname: n1\n---\npassword: b1\nname: n2\n',
      'standard',
    );
    assert.ok(stream.value.includes('n1') && stream.value.includes('n2'));
    assert.ok(!stream.value.includes('a1') && !stream.value.includes('b1'));
  });

  it('shows a text that is not one clean document as a whole mask, whatever its names look like', () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const nbsp = String.fromCharCode(0xa0);
    const fullWidth = 'ｐａｓｓｗｏｒｄ';
    const vless = 'proxies:\n  - type: vless\n    uuid: 00000000-0000-4000-8000-0000000000b1\n';
    const inputs = [
      // A broken template: the people rules of the structured masker cannot run on it.
      `${vless}broken: [`,
      // A valid template past the size limit (a long comment).
      `${vless}# ${'c'.repeat(65_536)}\n`,
      // Explicit keys, and a quoted key continued on the next line with an escaped line end.
      '? password\n: FIRST\n? password\n: SECOND\n',
      '"pass\\\n  word": FIRST\n"pass\\\n  word": SECOND\n',
      // Repeated keys in every spelling that hid a name from a scan.
      'password: FIRST\r\npassword: SECOND\r\n',
      'x: {password: FIRST, password: SECOND}\n',
      'password: &p !!str |\n  SECOND\nname: x\nname: y\n',
      'a: 1\n\tpassword\t:\tFIRST\na: 2\n',
      `pass${zeroWidth}word: FIRST\npass${zeroWidth}word: SECOND\n`,
      `\tpassword${nbsp}:${nbsp}FIRST\n\tpassword: SECOND\n`,
      `${fullWidth}: FIRST\n${fullWidth}: SECOND\n`,
      '"p\\u0061ssword": FIRST\n"p\\x61ssword": SECOND\n"p\\x61ssword": x\n',
      'accessTokens: [FIRST]\naccessTokens: [SECOND]\n',
      'auth: FIRST\nauth: SECOND\n',
      'password = FIRST\rpassword = SECOND\r',
      'SECRET_KEY=FIRST\nPORT=1\n',
      'PASSWORD=FIRST',
      `<p>user:FIRST${AT}x</p>\nline: one\nline: two\n`,
    ];
    for (const input of inputs) {
      const { value, count } = maskConsoleText(input, 'standard', KEY);
      assert.equal(value, UNREADABLE_DOCUMENT, JSON.stringify(input.slice(0, 80)));
      assert.equal(count, 1);
    }
    // A clean document keeps its structure, masked by its names.
    const clean = maskConsoleText(`${vless}name: n\n`, 'standard', KEY);
    assert.ok(!clean.value.includes('0000000000b1'));
    assert.ok(clean.value.includes('type: vless'));
    const folded = maskConsoleText(`${fullWidth}: X9\nname: n\n`, 'standard');
    assert.ok(!folded.value.includes('X9'));
    assert.ok(folded.value.includes('name: n'));
  });

  it('applies the rule of a text answer to every string value that is a document in itself', () => {
    const block = 'config: |\n  password: example-only-secret\n';
    for (const [name, masked] of [
      ['YAML block scalar', maskConsoleText(block, 'standard').value],
      [
        'JSON property',
        text(maskConsoleJson({ config: 'password: example-only-secret' }, 'standard').value),
      ],
      [
        'JSON scalar body',
        text(maskConsoleJson('password: example-only-secret', 'standard').value),
      ],
      [
        'template body',
        Buffer.from(
          (
            maskConsoleJson(
              { encodedTemplateYaml: Buffer.from(block, 'utf8').toString('base64') },
              'standard',
            ).value as { encodedTemplateYaml: string }
          ).encodedTemplateYaml,
          'base64',
        ).toString('utf8'),
      ],
    ] as const) {
      assert.ok(!masked.includes('example-only-secret'), `${name}: ${masked}`);
    }
    // A string that is not a clean document is masked whole; a trivial one keeps the value rules.
    assert.deepEqual(
      maskConsoleJson({ note: 'line one\nPASSWORD=example-only-secret' }, 'standard').value,
      { note: UNREADABLE_DOCUMENT },
    );
    assert.deepEqual(maskConsoleJson({ note: 'just a remark' }, 'standard').value, {
      note: 'just a remark',
    });
    // A document in a string with nothing secret in it is kept as it was.
    assert.deepEqual(maskConsoleJson({ note: 'Error: not found' }, 'standard').value, {
      note: 'Error: not found',
    });
  });

  it('does not let an alias of a scalar show a secret under another name', () => {
    const scalar = maskConsoleText('password: &p example-only-secret\nmessage: *p\n', 'standard');
    assert.equal(scalar.value, UNREADABLE_DOCUMENT);
    // An alias of a mapping keeps its names: it is read and masked as usual.
    const mapping = maskConsoleText(
      'base: &b\n  password: example-only-secret\n  port: 443\ncopy: *b\n',
      'standard',
    );
    assert.ok(!mapping.value.includes('example-only-secret'));
    assert.ok(mapping.value.includes('port: 443'));
  });

  it('masks the value of a name/value pair in any case and order of its properties', () => {
    for (const values of [
      [{ Name: 'password', Value: 'example-only-secret' }],
      [{ name: 'display', key: 'password', value: 'example-only-secret' }],
      [{ VALUE: 'example-only-secret', Label: 'API_TOKEN' }],
      [{ variable: 'SECRET_KEY', value: 'example-only-secret' }],
    ]) {
      const out = text(maskConsoleJson({ values }, 'standard').value);
      assert.ok(!out.includes('example-only-secret'), JSON.stringify(values));
    }
    assert.ok(
      text(
        maskConsoleJson({ values: [{ name: 'region', value: 'eu-1' }] }, 'standard').value,
      ).includes('eu-1'),
    );
  });

  it('reads the names of an object by the value rules too, keeping both entries of a collision', () => {
    const { value } = maskConsoleJson(
      {
        // Credentials that do not contain a secret name, so the names alone do not make the values secret.
        [`https://alice:wonderland-1${AT}example.com/`]: 'ok',
        [`https://bob:builder-2${AT}example.com/`]: 'also',
      },
      'standard',
    );
    const out = text(value);
    assert.ok(!out.includes('wonderland-1') && !out.includes('builder-2'), out);
    assert.equal(Object.keys(value as object).length, 2);
    assert.ok(out.includes('"ok"') && out.includes('"also"'));
    const yaml = maskConsoleText(
      `"https://alice:example-only-secret${AT}example.com/": ok\nname: x\n`,
      'standard',
    );
    assert.ok(!yaml.value.includes('example-only-secret'));
  });

  it('gives many names that mask alike distinct suffixes in linear time', () => {
    const source: Record<string, number> = {};
    for (let index = 0; index < 20_000; index += 1) {
      source[`Bearer synthetic-${String(index)}`] = index;
    }
    const started = performance.now();
    const { value } = maskConsoleJson(source, 'standard');
    const took = performance.now() - started;
    assert.ok(took < 1_000, `20,000 names took ${took.toFixed(0)} ms`);
    const names = Object.keys(value as object);
    assert.equal(names.length, 20_000);
    assert.equal(new Set(names).size, 20_000);
    assert.ok(names.every((name) => !name.includes('synthetic-')));
    assert.ok(names.includes('Bearer [masked]') && names.includes('Bearer [masked]#19999'));
  });

  it('keeps an ordinary short answer readable', () => {
    for (const input of [
      'ok',
      '42',
      'Not Found',
      'Too many requests, try later.',
      '<html><body>Sign in</body></html>',
    ]) {
      const { value, count } = maskConsoleText(input, 'standard');
      assert.equal(value, input);
      assert.equal(count, 0);
    }
  });

  it('applies the fail-closed rule to every document of a stream that is only a text', () => {
    for (const input of [
      'name: example\n---\nPASSWORD=synthetic-secret\n',
      'name: example\n---\n|\n  PASSWORD=synthetic-secret\n  other line\n',
      'name: example\n---\n"PASSWORD=synthetic-secret"\n',
    ]) {
      const { value, count } = maskConsoleText(input, 'standard');
      assert.ok(!value.includes('synthetic-secret'), JSON.stringify(input));
      assert.ok(value.includes('name: example'));
      assert.ok(count >= 1);
    }
  });

  it('applies the value rules to the names of a YAML mapping as well', () => {
    const input = `https://user:synthetic-pass${AT}example.com: label # comment\n`;
    const { value } = maskConsoleText(input, 'standard', KEY);
    assert.ok(!value.includes('synthetic-pass'), value);
    assert.ok(value.includes('example.com'));
    const template = maskConsoleJson(
      { encodedTemplateYaml: Buffer.from(input, 'utf8').toString('base64') },
      'standard',
    );
    const decoded = Buffer.from(
      (template.value as { encodedTemplateYaml: string }).encodedTemplateYaml,
      'base64',
    ).toString('utf8');
    assert.ok(!decoded.includes('synthetic-pass'));
  });

  it('masks the value of a name/value pair whose name is a collection of secrets', () => {
    assert.deepEqual(
      maskConsoleJson({ name: 'accessTokens', value: ['SYNTHETIC'] }, 'standard').value,
      { name: 'accessTokens', value: [MASK] },
    );
    assert.deepEqual(maskConsoleJson({ key: 'botTokens', value: { a: 'x' } }, 'standard').value, {
      key: 'botTokens',
      value: { a: MASK },
    });
  });

  it('does not read a YAML text full of anchors and aliases as a document, and reads the largest allowed one fast', () => {
    const aliases = '- &a x\n- *a\n'.repeat(20_000);
    let started = performance.now();
    const many = maskConsoleText(aliases, 'standard');
    assert.ok(performance.now() - started < 1000, 'the alias-heavy text took too long');
    assert.equal(
      many.value,
      UNREADABLE_DOCUMENT,
      'it is not read as a document, so it is not shown',
    );
    // The most a document may hold: 64 KiB, 300 anchors and aliases together, the rest plain keys.
    const allowed = [
      '- &a x\n- *a\n'.repeat(150),
      ...Array.from({ length: 9000 }, (_unused, index) => `- k${String(index)}\n`),
    ]
      .join('')
      .slice(0, 64 * 1024 - 8)
      .concat('\n- end\n');
    started = performance.now();
    maskConsoleText(allowed, 'standard');
    assert.ok(performance.now() - started < 300, 'the largest allowed document took too long');
  });

  it('never lets the metadata of a record show what the profile hides', () => {
    const answer = {
      accessTokens: [{ uuid: 'private-id', name: 'ci', expireAt: '2026-12-01T00:00:00Z' }],
    };
    const standard = text(maskConsoleJson(answer, 'standard').value);
    assert.ok(standard.includes('private-id'), 'the standard profile shows a token uuid');
    const personal = text(maskConsoleJson(answer, 'personal').value);
    assert.ok(!personal.includes('private-id'), 'the profile for people hides every uuid');
    assert.ok(personal.includes('2026-12-01T00:00:00Z'));
  });

  it('reads the answer of GET /api/tokens in the shape of the frozen description', () => {
    // response.tokens[]: uuid, name, expireAt, scopes, createdAt, updatedAt (GetApiTokensResponseDto, 3.4.11).
    const answer = {
      response: {
        tokens: [
          {
            uuid: '00000000-0000-4000-8000-0000000000e1',
            name: 'synthetic-ci-token',
            expireAt: '2027-01-01T00:00:00.000Z',
            scopes: ['nodes:read', 'hosts:read'],
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-02T00:00:00.000Z',
          },
        ],
      },
    };
    const out = text(maskConsoleJson(answer, 'standard').value);
    for (const visible of [
      '0000000000e1',
      'synthetic-ci-token',
      '2027-01-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    ]) {
      assert.ok(out.includes(visible), visible);
    }
    // The scopes are a list in a record of a collection of secrets: not on the metadata list, so they are hidden.
    assert.ok(!out.includes('nodes:read'));
  });

  it('masks every scalar under a secret collection, keeping only the metadata of its records', () => {
    const { value } = maskConsoleJson(
      {
        accessTokens: [['SYNTHETIC-TOKEN-1', ['SYNTHETIC-TOKEN-2']]],
        botTokens: { admin: 'SYNTHETIC-TOKEN-3', nested: { deeper: 'SYNTHETIC-TOKEN-4' } },
        apiTokens: [
          {
            uuid: '00000000-0000-4000-8000-0000000000d1',
            name: 'ci',
            createdAt: '2026-11-01',
            expiresAt: '2026-12-01',
            enabled: true,
            token: 'SYNTHETIC-TOKEN-5',
            scopes: ['SYNTHETIC-SCOPE'],
            extra: { value: 'SYNTHETIC-TOKEN-6' },
          },
        ],
      },
      'standard',
    );
    const out = text(value);
    for (const index of [1, 2, 3, 4, 5, 6]) {
      assert.ok(!out.includes(`SYNTHETIC-TOKEN-${String(index)}`), String(index));
    }
    assert.ok(!out.includes('SYNTHETIC-SCOPE'));
    for (const visible of [
      '"name":"ci"',
      '2026-11-01',
      '2026-12-01',
      '"enabled":true',
      '0000000000d1',
    ]) {
      assert.ok(out.includes(visible), visible);
    }
    assert.deepEqual(maskConsoleJson({ accessTokens: [['x']] }, 'standard').value, {
      accessTokens: [[MASK]],
    });
    assert.deepEqual(maskConsoleJson({ accessTokens: { admin: 'y' } }, 'standard').value, {
      accessTokens: { admin: MASK },
    });
  });

  it('reads a large YAML answer in bounded time, and still refuses a repeated key', () => {
    const big = Array.from({ length: 50_000 }, (_unused, i) => `k${String(i)}: 1`).join('\n');
    let started = performance.now();
    const masked = maskConsoleText(big, 'standard');
    assert.ok(performance.now() - started < 1000, 'the 50,000-line answer took too long');
    assert.equal(masked.value, UNREADABLE_DOCUMENT, 'a text over the limit is not shown');
    const keys = Array.from({ length: 5_000 }, (_unused, i) => `k${String(i)}: 1`);
    started = performance.now();
    const read = maskConsoleText([...keys, 'password: FIVE-THOUSAND'].join('\n'), 'standard');
    assert.ok(performance.now() - started < 1000, 'the 5,000-key document took too long');
    assert.ok(!read.value.includes('FIVE-THOUSAND'));
    assert.ok(read.value.includes('k4999: 1'), 'it was read as a document');
    const repeated = maskConsoleText(
      [...keys, 'k7: 2', 'password: REPEATED'].join('\n'),
      'standard',
    );
    assert.equal(repeated.value, UNREADABLE_DOCUMENT, 'a repeated key goes to the whole-text rule');
  });

  it('never lets the YAML parser write a source line to the log', async () => {
    const writes: string[] = [];
    // The parser reports through `process.emitWarning`, which writes on a later tick: the event is caught as well.
    const onWarning = (warning: Error): void => {
      writes.push(warning.message);
    };
    process.on('warning', onWarning);
    const original = process.stderr.write.bind(process.stderr);
    const originalWarn = console.warn;
    const originalLog = console.log;
    const originalError = console.error;
    const capture = (...args: unknown[]): void => {
      writes.push(args.map(String).join(' '));
    };
    process.stderr.write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    console.warn = capture;
    console.log = capture;
    console.error = capture;
    try {
      const yaml = 'password: !custom synthetic-credential\nname: x\n';
      const asText = maskConsoleText(yaml, 'standard');
      const asTemplate = maskConsoleJson(
        { encodedTemplateYaml: Buffer.from(yaml, 'utf8').toString('base64') },
        'standard',
      );
      assert.ok(!asText.value.includes('synthetic-credential'));
      assert.ok(!text(asTemplate.value).includes('synthetic-credential'));
      // The typed read of a template parses the same way.
      assert.equal(
        maskedYaml(Buffer.from(yaml, 'utf8').toString('base64'), { fingerprintKey: KEY }),
        null,
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      process.off('warning', onWarning);
      process.stderr.write = original;
      console.warn = originalWarn;
      console.log = originalLog;
      console.error = originalError;
    }
    assert.deepEqual(writes, []);
  });

  it('hides the Telegram ids of the administrators in the panel settings', () => {
    const settings = {
      response: {
        oauth2Settings: {
          telegram: {
            enabled: true,
            botToken: 'SETTINGS-BOT-TOKEN',
            allowedIds: [111111, '222222'],
          },
          github: { enabled: false, allowedEmails: ['admin@example.com'] },
        },
        passwordSettings: { enabled: true },
      },
    };
    const { value } = maskConsoleJson(settings, 'standard', KEY);
    for (const secret of ['111111', '222222', 'SETTINGS-BOT-TOKEN', 'admin@example.com']) {
      assert.ok(!text(value).includes(secret), secret);
    }
    assert.ok(text(value).includes('"enabled":true'));
  });

  it('knows the names of tokens and keys that a deny-list of exact names would miss', () => {
    const config = {
      response: {
        apiToken: 'NAME-API-TOKEN',
        webhookToken: 'NAME-WEBHOOK-TOKEN',
        cfToken: 'NAME-CF-TOKEN',
        x_token: 'NAME-X-TOKEN',
        signingKey: 'NAME-SIGNING-KEY',
        encryptionKey: 'NAME-ENCRYPTION-KEY',
        licenseKey: 'NAME-LICENSE-KEY',
        cookies: 'NAME-COOKIES',
        Authorization: 'NAME-AUTHORIZATION',
        shortId: 'NAME-SHORT-ID',
        // Names about a token, and public keys, stay readable.
        tokenUrl: 'https://auth.example.com/token',
        tokenType: 'bearer-kind',
        tokenExpiresAt: '2026-12-01T00:00:00Z',
        publicKey: 'PUBLIC-KEY-VISIBLE',
        apiTokens: [
          {
            uuid: '00000000-0000-4000-8000-0000000000c1',
            tokenName: 'ci',
            token: 'NAME-LIST-TOKEN',
          },
        ],
      },
    };
    const { value } = maskConsoleJson(config, 'standard', KEY);
    const out = text(value);
    for (const secret of [
      'NAME-API-TOKEN',
      'NAME-WEBHOOK-TOKEN',
      'NAME-CF-TOKEN',
      'NAME-X-TOKEN',
      'NAME-SIGNING-KEY',
      'NAME-ENCRYPTION-KEY',
      'NAME-LICENSE-KEY',
      'NAME-COOKIES',
      'NAME-AUTHORIZATION',
      'NAME-SHORT-ID',
      'NAME-LIST-TOKEN',
    ]) {
      assert.ok(!out.includes(secret), secret);
    }
    for (const visible of [
      'https://auth.example.com/token',
      'bearer-kind',
      '2026-12-01T00:00:00Z',
      'PUBLIC-KEY-VISIBLE',
      '"tokenName":"ci"',
    ]) {
      assert.ok(out.includes(visible), visible);
    }
  });
});
