import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PANEL_SNAPSHOT_OBJECT_KINDS, type PanelSnapshotObjectKind } from '@swellwright/contracts';

import { diffSnapshotContents, diffValues } from './diff.js';
import { contentHash } from './mask.js';
import {
  SNAPSHOT_CONTENT_FORMAT,
  SNAPSHOT_CONTENT_VERSION,
  type SnapshotContent,
  type SnapshotItem,
} from './snapshot-content.js';

const changes = (before: unknown, after: unknown, options = {}) =>
  diffValues(before, after, options).changes;

const item = (id: string, name: string, config: unknown): SnapshotItem => ({
  id,
  name,
  hash: contentHash(config),
  config,
});

function content(
  kinds: Partial<Record<PanelSnapshotObjectKind, SnapshotItem[]>>,
  maskKeyId = 'key-one',
): SnapshotContent {
  return {
    format: SNAPSHOT_CONTENT_FORMAT,
    schemaVersion: SNAPSHOT_CONTENT_VERSION,
    maskKeyId,
    kinds,
  };
}

describe('the field changes between two configurations', () => {
  it('finds nothing in a value compared with itself, and says nothing for equal values', () => {
    const value = { a: 1, b: [1, 2, { c: 'x' }], d: { e: null } };
    assert.deepEqual(changes(value, structuredClone(value)), []);
    assert.deepEqual(changes([], []), []);
    assert.deepEqual(changes(null, null), []);
  });

  it('reports a changed, an added and a removed field with the path to it', () => {
    const result = changes(
      { name: 'a', port: 443, gone: true, nested: { deep: 1 } },
      { name: 'a', port: 8443, fresh: 'x', nested: { deep: 2 } },
    );
    assert.deepEqual(result, [
      { path: 'fresh', op: 'added', after: 'x' },
      { path: 'gone', op: 'removed', before: true },
      { path: 'nested.deep', op: 'changed', before: 1, after: 2 },
      { path: 'port', op: 'changed', before: 443, after: 8443 },
    ]);
  });

  it('writes a key that is not an identifier in brackets', () => {
    const result = changes({ 'a b': 1, 'x-y': 1 }, { 'a b': 2, 'x-y': 2 });
    assert.deepEqual(
      result.map((change) => change.path),
      ['["a b"]', 'x-y'],
    );
  });

  it('tells a changed type from a changed value, and null from absence', () => {
    assert.deepEqual(changes({ a: 1 }, { a: '1' }), [
      { path: 'a', op: 'changed', before: 1, after: '1' },
    ]);
    assert.deepEqual(changes({ a: null }, {}), [{ path: 'a', op: 'removed', before: null }]);
    assert.deepEqual(changes({ a: {} }, { a: [] }), [
      { path: 'a', op: 'changed', before: {}, after: [] },
    ]);
  });

  it('matches an array of objects by its tag, so that an added inbound is one change', () => {
    const before = {
      inbounds: [
        { tag: 'A', port: 1 },
        { tag: 'C', port: 3 },
      ],
    };
    const after = {
      inbounds: [
        { tag: 'A', port: 1 },
        { tag: 'B', port: 2 },
        { tag: 'C', port: 3 },
      ],
    };
    assert.deepEqual(changes(before, after), [
      { path: 'inbounds[tag=B]', op: 'added', after: { tag: 'B', port: 2 } },
    ]);
    assert.deepEqual(changes(after, before), [
      { path: 'inbounds[tag=B]', op: 'removed', before: { tag: 'B', port: 2 } },
    ]);
  });

  it('goes into the element that has a natural key and changed', () => {
    const result = changes(
      { outbounds: [{ tag: 'DIRECT', protocol: 'freedom' }] },
      { outbounds: [{ tag: 'DIRECT', protocol: 'blackhole' }] },
    );
    assert.deepEqual(result, [
      {
        path: 'outbounds[tag=DIRECT].protocol',
        op: 'changed',
        before: 'freedom',
        after: 'blackhole',
      },
    ]);
  });

  it('prefers tag, then uuid, ruleTag and name, and needs a key that every element has once', () => {
    const named = changes(
      {
        list: [
          { name: 'a', v: 1 },
          { name: 'b', v: 2 },
        ],
      },
      {
        list: [
          { name: 'b', v: 2 },
          { name: 'a', v: 3 },
        ],
      },
    );
    assert.ok(named.some((change) => change.path === 'list[name=a].v'));
    // A repeated key is no key: the array is compared by position.
    const repeated = changes(
      {
        list: [
          { name: 'a', v: 1 },
          { name: 'a', v: 2 },
        ],
      },
      {
        list: [
          { name: 'a', v: 1 },
          { name: 'a', v: 3 },
        ],
      },
    );
    assert.deepEqual(
      repeated.map((change) => change.path),
      ['list[1].v'],
    );
  });

  it('reports a reordering of the elements of an ordered array and ignores that of a set of objects', () => {
    const ordered = changes(
      { outbounds: [{ tag: 'A' }, { tag: 'B' }] },
      { outbounds: [{ tag: 'B' }, { tag: 'A' }] },
    );
    assert.deepEqual(ordered, [
      { path: 'outbounds', op: 'changed', before: ['A', 'B'], after: ['B', 'A'] },
    ]);
    assert.deepEqual(
      changes(
        { inbounds: [{ tag: 'A' }, { tag: 'B' }] },
        { inbounds: [{ tag: 'B' }, { tag: 'A' }] },
      ),
      [],
    );
  });

  it('compares a set without regard to order, and names the members that came and went', () => {
    assert.deepEqual(changes({ tags: ['a', 'b', 'c'] }, { tags: ['c', 'a', 'b'] }), []);
    assert.deepEqual(changes({ tags: ['a', 'b'] }, { tags: ['b', 'c'] }), [
      { path: 'tags', op: 'removed', before: 'a' },
      { path: 'tags', op: 'added', after: 'c' },
    ]);
    assert.deepEqual(changes({ serverNames: [] }, { serverNames: ['x.example.com'] }), [
      { path: 'serverNames', op: 'added', after: 'x.example.com' },
    ]);
  });

  it('compares any other array by what it keeps, so that one inserted rule is one change', () => {
    const rule = (n: number) => ({ type: 'field', ip: [`10.0.0.${String(n)}`] });
    const before = { rules: [rule(1), rule(2), rule(3)] };
    const after = { rules: [rule(1), rule(9), rule(2), rule(3)] };
    assert.deepEqual(changes(before, after), [{ path: 'rules[1]', op: 'added', after: rule(9) }]);
    assert.deepEqual(changes(after, before), [
      { path: 'rules[1]', op: 'removed', before: rule(9) },
    ]);
  });

  it('pairs what is removed with what is added at the same place into one change', () => {
    assert.deepEqual(
      changes({ servers: ['192.0.2.1', '192.0.2.2'] }, { servers: ['192.0.2.1', '192.0.2.3'] }),
      [{ path: 'servers[1]', op: 'changed', before: '192.0.2.2', after: '192.0.2.3' }],
    );
    assert.deepEqual(
      changes({ rules: [{ a: 1, b: 1 }, { a: 2 }] }, { rules: [{ a: 1, b: 5 }, { a: 2 }] }),
      [{ path: 'rules[0].b', op: 'changed', before: 1, after: 5 }],
    );
  });

  it('shows only the number of items of a list of clients, never what is in them', () => {
    const before = {
      settings: { clients: [{ id: '[masked:aaaaaaaa]', email: '[masked:bbbbbbbb]' }] },
    };
    const after = {
      settings: {
        clients: [
          { id: '[masked:aaaaaaaa]', email: '[masked:bbbbbbbb]' },
          { id: '[masked:cccccccc]', email: '[masked:dddddddd]' },
        ],
      },
    };
    assert.deepEqual(changes(before, after), [
      {
        path: 'settings.clients',
        op: 'changed',
        before: { items: 1 },
        after: { items: 2 },
        masked: true,
        hidden: true,
      },
    ]);
    // The same list is no change; a list that appears is counted and not listed.
    assert.deepEqual(changes(before, structuredClone(before)), []);
    // A whole object that holds such a list and is added: the list is counted in it, not shown.
    assert.deepEqual(changes({}, before), [
      { path: 'settings', op: 'added', after: { clients: { items: 1 } }, masked: true },
    ]);
    assert.deepEqual(changes({ users: [] }, { users: [{ id: 'x' }] })[0]?.hidden, true);
  });

  it('shows a rotated secret as changed and masked, with the two fingerprints and nothing else', () => {
    const before = { reality: { privateKey: '[masked:1a2b3c4d]', target: 'a.example.com:443' } };
    const after = { reality: { privateKey: '[masked:5e6f7a8b]', target: 'a.example.com:443' } };
    assert.deepEqual(changes(before, after), [
      {
        path: 'reality.privateKey',
        op: 'changed',
        before: '[masked:1a2b3c4d]',
        after: '[masked:5e6f7a8b]',
        masked: true,
      },
    ]);
    assert.deepEqual(changes(before, structuredClone(before)), []);
  });

  it('compares masked values as equal when the two sides were masked with different keys', () => {
    const before = {
      key: '[masked:1a2b3c4d]',
      url: 'vless://[masked:11111111]@h:1?sid=[masked:22222222]',
    };
    const after = {
      key: '[masked:5e6f7a8b]',
      url: 'vless://[masked:33333333]@h:1?sid=[masked:44444444]',
    };
    assert.equal(changes(before, after).length, 2);
    assert.deepEqual(changes(before, after, { ignoreMaskFingerprints: true }), []);
    // A real change is still found.
    assert.equal(
      changes(before, { ...after, key: 'a value now' }, { ignoreMaskFingerprints: true }).length,
      1,
    );
  });

  it('flags a change that holds a mask inside a longer text', () => {
    const [change] = changes(
      { url: 'socks5://[masked:aaaaaaaa]@192.0.2.1:1080' },
      { url: 'socks5://[masked:bbbbbbbb]@192.0.2.1:1080' },
    );
    assert.equal(change?.masked, true);
  });

  it('shows the lines that went and the lines that came of a text of several lines', () => {
    const before = 'proxies:\n  - name: a\n    port: 443\nrules:\n  - MATCH,DIRECT\n';
    const after = 'proxies:\n  - name: a\n    port: 8443\nrules:\n  - MATCH,DIRECT\n';
    assert.deepEqual(changes({ yaml: before }, { yaml: after }), [
      {
        path: 'yaml',
        op: 'changed',
        before: '    port: 443',
        after: '    port: 8443',
        lines: { removed: 1, added: 1 },
      },
    ]);
  });

  it('ignores timestamps at the top of an object and keeps the same words deeper down', () => {
    assert.deepEqual(
      changes(
        { createdAt: 'a', updatedAt: 'b', name: 'x' },
        { createdAt: 'c', updatedAt: 'd', name: 'x' },
      ),
      [],
    );
    assert.equal(changes({ config: { updatedAt: 1 } }, { config: { updatedAt: 2 } }).length, 1);
  });

  it('cuts the list of changes and a very large value, and still counts every change', () => {
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (let i = 0; i < 300; i += 1) {
      before[`k${String(i).padStart(3, '0')}`] = 1;
      after[`k${String(i).padStart(3, '0')}`] = 2;
    }
    const result = diffValues(before, after, { maxChangesPerObject: 50 });
    assert.equal(result.total, 300);
    assert.equal(result.changes.length, 50);

    const big = diffValues(
      { v: 'x'.repeat(10_000) },
      { v: 'y'.repeat(10_000) },
      { maxValueBytes: 100 },
    );
    const [change] = big.changes;
    assert.equal(change?.valueTruncated, true);
    assert.ok(String(change.before).length <= 101);

    const object = diffValues({ v: { a: 'x'.repeat(500) } }, { v: { a: 'y'.repeat(500) } }, {});
    // A value that is an object is walked, so the leaves are what is shown; a whole added object is clipped.
    assert.equal(object.changes.length, 1);
    const added = diffValues({}, { v: { a: 'z'.repeat(9000) } }, { maxValueBytes: 1000 });
    assert.match(String(added.changes[0]?.after), /not shown/u);
    assert.equal(added.changes[0]?.valueTruncated, true);
  });

  it('is fast on large arrays and falls back to positions when the table would be too big', () => {
    const rows = (n: number, offset: number) =>
      Array.from({ length: n }, (_unused, i) => ({
        type: 'field',
        ip: [`10.${String(offset + i)}.0.1`],
      }));
    const started = Date.now();
    const result = diffValues({ rules: rows(1500, 0) }, { rules: rows(1500, 1) });
    // 1500 x 1500 cells fit under the cap; whatever the outcome, it must come quickly and with counted changes.
    assert.ok(Date.now() - started < 5000);
    assert.ok(result.total > 0);
    const huge = diffValues({ rules: rows(2500, 0) }, { rules: rows(2500, 1) });
    assert.ok(huge.total >= 2500);
  });
});

describe('the diff of two snapshot contents', () => {
  const node = (n: number, extra: Record<string, unknown> = {}) =>
    item(`00000000-0000-4000-8000-00000000000${String(n)}`, `Node ${String(n)}`, {
      name: `Node ${String(n)}`,
      address: `192.0.2.${String(n)}`,
      tags: [],
      ...extra,
    });

  it('says "no differences" as a result when the two are the same', () => {
    const one = content({ nodes: [node(1), node(2)], hosts: [] });
    const result = diffSnapshotContents(one, structuredClone(one));
    assert.equal(result.identical, true);
    assert.deepEqual(result.summary.objects, { added: 0, removed: 0, changed: 0, unchanged: 2 });
    assert.deepEqual(result.objects, []);
    assert.deepEqual(result.notes, []);
    assert.deepEqual(result.summary.byKind.hosts, {
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 0,
    });
  });

  it('finds an object that was added, one that was removed and one that changed', () => {
    const before = content({ nodes: [node(1), node(2), node(3)] });
    const after = content({ nodes: [node(1, { address: '192.0.2.99' }), node(3), node(4)] });
    const result = diffSnapshotContents(before, after);
    assert.equal(result.identical, false);
    assert.deepEqual(result.summary.objects, { added: 1, removed: 1, changed: 1, unchanged: 1 });
    assert.equal(result.summary.fieldChanges, 1);
    assert.deepEqual(
      result.objects.map((object) => [object.name, object.status]),
      [
        ['Node 1', 'changed'],
        ['Node 2', 'removed'],
        ['Node 4', 'added'],
      ],
    );
    const changed = result.objects[0];
    assert.deepEqual(changed?.changes, [
      { path: 'address', op: 'changed', before: '192.0.2.1', after: '192.0.2.99' },
    ]);
    assert.equal(changed.fromHash === changed.toHash, false);
  });

  it('lists the objects that did not change on request, with the summary the same either way', () => {
    const before = content({ nodes: [node(1), node(2)] });
    const after = content({ nodes: [node(1), node(2, { address: 'x' })] });
    const plain = diffSnapshotContents(before, after);
    const full = diffSnapshotContents(before, after, { includeUnchanged: true });
    assert.deepEqual(plain.summary, full.summary);
    assert.equal(plain.objects.length, 1);
    assert.deepEqual(
      full.objects.map((object) => object.status),
      ['unchanged', 'changed'],
    );
  });

  it('does not compare a kind that only one side holds, and says which', () => {
    const before = content({ nodes: [node(1)], hosts: [] });
    const after = content({ nodes: [node(1)] });
    const result = diffSnapshotContents(before, after);
    assert.equal(result.identical, true);
    assert.deepEqual(result.notes, [{ code: 'kind_not_covered', kinds: ['hosts'] }]);
    assert.equal(result.summary.byKind.hosts, undefined);
  });

  it('sets fingerprints aside when the two were masked with different keys, and says so', () => {
    const secretA = item('00000000-0000-4000-8000-000000000001', 'P', {
      key: '[masked:1a2b3c4d]',
      port: 1,
    });
    const secretB = item('00000000-0000-4000-8000-000000000001', 'P', {
      key: '[masked:5e6f7a8b]',
      port: 1,
    });
    const same = diffSnapshotContents(
      content({ configProfiles: [secretA] }, 'one'),
      content({ configProfiles: [secretB] }, 'two'),
    );
    assert.equal(same.identical, true);
    assert.deepEqual(same.notes, [{ code: 'mask_key_differs' }]);
    // With one key the same two are a rotation.
    const rotated = diffSnapshotContents(
      content({ configProfiles: [secretA] }, 'one'),
      content({ configProfiles: [secretB] }, 'one'),
    );
    assert.equal(rotated.identical, false);
    assert.equal(rotated.objects[0]?.changes[0]?.masked, true);
  });

  it('notes the objects whose hash moved while nothing that is compared did', () => {
    const before = content({ nodes: [item('id-1', 'n', { name: 'n', createdAt: '2026-01-01' })] });
    const after = content({ nodes: [item('id-1', 'n', { name: 'n', createdAt: '2026-02-01' })] });
    const result = diffSnapshotContents(before, after);
    assert.equal(result.identical, true);
    assert.deepEqual(result.notes, [{ code: 'noise_only', count: 1 }]);
  });

  it('cuts the list of objects, keeps the counts and says how many were left out', () => {
    const many = (suffix: string) =>
      Array.from({ length: 30 }, (_unused, i) =>
        item(`id-${String(i).padStart(2, '0')}`, `Host ${String(i).padStart(2, '0')}`, {
          v: suffix,
        }),
      );
    const result = diffSnapshotContents(
      content({ hosts: many('a') }),
      content({ hosts: many('b') }),
      { maxObjects: 10 },
    );
    assert.equal(result.summary.objects.changed, 30);
    assert.equal(result.objects.length, 10);
    assert.deepEqual(result.notes, [{ code: 'objects_cut', count: 20 }]);
  });

  it('names the uuids that appear in the values of the changes', () => {
    const profile = item('00000000-0000-4000-8000-0000000000aa', 'Profile One', {
      name: 'Profile One',
      inbounds: [{ uuid: '00000000-0000-4000-8000-0000000000bb', tag: 'MAIN' }],
    });
    const squadBefore = item('00000000-0000-4000-8000-0000000000cc', 'Squad', {
      inbounds: ['00000000-0000-4000-8000-0000000000bb'],
    });
    const squadAfter = item('00000000-0000-4000-8000-0000000000cc', 'Squad', { inbounds: [] });
    const result = diffSnapshotContents(
      content({ configProfiles: [profile], internalSquads: [squadBefore] }),
      content({ configProfiles: [profile], internalSquads: [squadAfter] }),
    );
    assert.deepEqual(result.labels, {
      '00000000-0000-4000-8000-0000000000bb': 'Profile One / MAIN',
    });
  });
});

// ---- properties -------------------------------------------------------------------------------------------------------

/** A small deterministic generator: the same seed gives the same run, so a failure can be reproduced. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

/** A random configuration: objects, sets, keyed arrays of objects, scalars. No unkeyed arrays of objects. */
function randomConfig(random: Random, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  for (const key of keys) {
    if (random() < 0.35) {
      continue;
    }
    const roll = random();
    if (roll < 0.25) {
      out[key] = Math.floor(random() * 5);
    } else if (roll < 0.45) {
      out[key] = pick(random, ['x', 'y', 'z', '[masked:aaaaaaaa]', '[masked:bbbbbbbb]']);
    } else if (roll < 0.55) {
      out[key] = random() < 0.5;
    } else if (roll < 0.7) {
      out['tags'] = Array.from(
        new Set(Array.from({ length: 3 }, () => pick(random, ['a', 'b', 'c', 'd']))),
      );
    } else if (roll < 0.85 && depth < 2) {
      out[key] = randomConfig(random, depth + 1);
    } else if (depth < 2) {
      const tags = ['T1', 'T2', 'T3', 'T4'].filter(() => random() < 0.6);
      out['inbounds'] = tags.map((tag) => ({
        tag,
        port: Math.floor(random() * 4),
        ...(random() < 0.3 ? { extra: true } : {}),
      }));
    }
  }
  return out;
}

/** A random change to a configuration, as a person editing it would make it. */
function mutate(random: Random, value: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(value);
  const keys = Object.keys(copy);
  const roll = random();
  if (keys.length === 0 || roll < 0.3) {
    copy[`added${String(Math.floor(random() * 1000))}`] = 'new';
  } else if (roll < 0.55) {
    Reflect.deleteProperty(copy, pick(random, keys));
  } else {
    const key = pick(random, keys);
    const current = copy[key];
    if (typeof current === 'number') {
      copy[key] = current + 1;
    } else if (typeof current === 'string') {
      copy[key] = `${current}!`;
    } else if (typeof current === 'boolean') {
      copy[key] = !current;
    } else {
      copy[key] = 'replaced';
    }
  }
  return copy;
}

const asOps = (list: ReturnType<typeof diffValues>['changes']): string[] =>
  list.map((change) => `${change.path}:${change.op}`).sort();

const flip = (op: string): string =>
  op.endsWith(':added')
    ? op.replace(/:added$/u, ':removed')
    : op.endsWith(':removed')
      ? op.replace(/:removed$/u, ':added')
      : op;

describe('properties of the diff', () => {
  it('finds no difference between a value and a copy of itself', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const value = randomConfig(generator(seed));
      assert.deepEqual(
        diffValues(value, structuredClone(value)).changes,
        [],
        `seed ${String(seed)}`,
      );
    }
  });

  it('finds a difference after a mutation that changes the value, and none after one that does not', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = generator(seed);
      const before = randomConfig(random);
      const after = mutate(random, before);
      const equal = contentHash(before) === contentHash(after);
      assert.equal(diffValues(before, after).total === 0, equal, `seed ${String(seed)}`);
    }
  });

  it('turns every addition into a removal and the reverse when the sides are swapped', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = generator(seed);
      const a = randomConfig(random);
      const b = mutate(random, mutate(random, a));
      const forward = diffValues(a, b).changes;
      const backward = diffValues(b, a).changes;
      assert.deepEqual(asOps(forward).map(flip).sort(), asOps(backward), `seed ${String(seed)}`);
    }
  });

  it('is the same however a set is ordered', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = generator(seed);
      const tags = Array.from(
        new Set(Array.from({ length: 5 }, () => pick(random, ['a', 'b', 'c', 'd', 'e']))),
      );
      const shuffled = [...tags].sort(() => random() - 0.5);
      assert.deepEqual(
        diffValues({ tags }, { tags: shuffled }).changes,
        [],
        `seed ${String(seed)}`,
      );
    }
  });

  it('adds up at the level of objects: what one side adds, the other removes', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = generator(seed);
      const make = () =>
        content(
          Object.fromEntries(
            PANEL_SNAPSHOT_OBJECT_KINDS.filter(() => random() < 0.6).map((kind) => [
              kind,
              Array.from({ length: 6 }, (_unused, i) => i)
                .filter(() => random() < 0.7)
                .map((i) => item(`id-${String(i)}`, `Object ${String(i)}`, randomConfig(random))),
            ]),
          ),
        );
      const a = make();
      const b = make();
      const forward = diffSnapshotContents(a, b);
      const backward = diffSnapshotContents(b, a);
      assert.equal(
        forward.summary.objects.added,
        backward.summary.objects.removed,
        `seed ${String(seed)}`,
      );
      assert.equal(
        forward.summary.objects.removed,
        backward.summary.objects.added,
        `seed ${String(seed)}`,
      );
      assert.equal(
        forward.summary.objects.changed,
        backward.summary.objects.changed,
        `seed ${String(seed)}`,
      );
      assert.equal(
        forward.summary.objects.unchanged,
        backward.summary.objects.unchanged,
        `seed ${String(seed)}`,
      );
      assert.equal(forward.identical, backward.identical);
      assert.equal(diffSnapshotContents(a, structuredClone(a)).identical, true);
    }
  });
});
