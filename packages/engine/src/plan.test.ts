import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dnsZoneResource, nodeResource, panelResource, serverResource } from './locks.js';
import {
  CanonicalJsonError,
  InvalidPlanError,
  MAX_PLAN_STEPS,
  buildPlan,
  canonicalJson,
  isKey,
  planHash,
  sha256Hex,
  type PlanItem,
  type StepPlanInput,
} from './plan.js';

describe('canonicalJson', () => {
  it('sorts the keys of every object and leaves no white space', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }),
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('gives one text for one value, whatever order the keys were made in', () => {
    assert.equal(canonicalJson({ x: 1, y: 2, z: 3 }), canonicalJson({ z: 3, x: 1, y: 2 }));
    assert.equal(
      canonicalJson(Object.assign(Object.create(null) as object, { b: 1, a: 2 })),
      '{"a":2,"b":1}',
    );
  });

  it('keeps the order of an array, because there it means something', () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  it('sorts keys by code unit, the same everywhere', () => {
    assert.equal(
      canonicalJson({ b: 1, B: 2, a: 3, '': 4, é: 5 }),
      '{"":4,"B":2,"a":3,"b":1,"é":5}',
    );
  });

  it('writes strings with every character that JSON escapes', () => {
    assert.equal(canonicalJson('a"b\\c\n\u0001'), '"a\\"b\\\\c\\n\\u0001"');
    assert.equal(canonicalJson({ 'k"ey': 1 }), '{"k\\"ey":1}');
  });

  it('writes `-0` as `0` and leaves out a key whose value is undefined', () => {
    assert.equal(canonicalJson(-0), '0');
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
    assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  });

  it('refuses what JSON cannot say instead of turning it into `null`', () => {
    const cases: [string, unknown][] = [
      ['undefined', undefined],
      ['function', () => 1],
      ['symbol', Symbol('x')],
      ['bigint', 1n],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['undefined in an array', [1, undefined]],
      // eslint-disable-next-line no-sparse-arrays
      ['a hole in an array', [1, , 3]],
      ['a Date', new Date(0)],
      ['a Map', new Map()],
      ['a class instance', new (class Thing {})()],
    ];
    for (const [name, value] of cases) {
      assert.throws(() => canonicalJson(value), CanonicalJsonError, name);
    }
  });

  it('says where the problem is', () => {
    assert.throws(
      () => canonicalJson({ steps: [{ ok: 1 }, { bad: Number.NaN }] }),
      (error: unknown) =>
        error instanceof CanonicalJsonError &&
        error.path === '/steps/1/bad' &&
        error.message.includes('(at /steps/1/bad)'),
    );
    assert.throws(() => canonicalJson(Number.NaN), /at the root/u);
  });

  it('refuses a value that refers to itself, but not one that is used twice', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    assert.throws(() => canonicalJson(loop), /refers to itself/u);
    const shared = { n: 1 };
    assert.equal(
      canonicalJson({ a: shared, b: [shared, shared] }),
      '{"a":{"n":1},"b":[{"n":1},{"n":1}]}',
    );
  });

  it('refuses a value that is nested too deep to be a plan', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i += 1) {
      deep = [deep];
    }
    assert.throws(() => canonicalJson(deep), /nested deeper/u);
  });
});

describe('sha256Hex', () => {
  it('is SHA-256 as 64 lower-case hex digits', () => {
    assert.equal(
      sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.match(sha256Hex('é'), /^[0-9a-f]{64}$/u);
  });
});

describe('a key', () => {
  it('is lower-case words separated by dots, at least two', () => {
    for (const key of [
      'node.install',
      'node.install.nginx',
      'panel.node-create.v2',
      'dns.record.ensure-a',
    ]) {
      assert.equal(isKey(key), true, key);
    }
    for (const key of [
      '',
      'node',
      'Node.install',
      'node..install',
      '.node.install',
      'node.install.',
      'node.1x',
      '1node.x',
      'node install',
      'a.b'.repeat(40),
    ]) {
      assert.equal(isKey(key), false, key);
    }
  });
});

const step = (key: string, extra: Partial<StepPlanInput> = {}): StepPlanInput => ({
  key,
  title: key,
  estimateSeconds: 10,
  locks: [],
  items: [],
  ...extra,
});

const item = (kind: string, target: string, extra: Partial<PlanItem> = {}): PlanItem => ({
  kind,
  target,
  summary: `${kind} ${target}`,
  ...extra,
});

/** A plan with a few of everything: the one the golden hash below was made from. */
const deploy = () =>
  buildPlan({
    workflowKey: 'node.deploy',
    params: { name: 'edge-09', zone: 'example.test', ports: [443, 8443], dns: 'manual' },
    steps: [
      step('ssh.connect', { estimateSeconds: 5, locks: [serverResource('s-1')] }),
      step('node.snapshot', {
        estimateSeconds: 20,
        locks: [serverResource('s-1')],
        items: [item('file.read', '/etc/ssh/sshd_config')],
      }),
      step('node.install.nginx', {
        estimateSeconds: 120,
        locks: [nodeResource('edge-09'), serverResource('s-1')],
        items: [item('package.install', 'nginx'), item('file.write', '/etc/nginx/nginx.conf')],
      }),
      step('panel.create-node', {
        estimateSeconds: 15,
        locks: [panelResource(), dnsZoneResource('example.test')],
        items: [item('panel.node.create', 'edge-09', { irreversible: true })],
      }),
    ],
  });

describe('building a plan', () => {
  it('numbers the steps, orders the locks of each and joins them into the locks of the run', () => {
    const plan = deploy();
    assert.deepEqual(
      plan.steps.map((s) => s.index),
      [0, 1, 2, 3],
    );
    assert.deepEqual(plan.steps[2]?.locks, ['server:s-1', 'node:edge-09']);
    assert.deepEqual(plan.locks, ['panel', 'dns-zone:example.test', 'server:s-1', 'node:edge-09']);
  });

  it('adds up the estimate and finds the first step that cannot be taken back', () => {
    const plan = deploy();
    assert.equal(plan.estimateSeconds, 160);
    assert.equal(plan.irreversibleFrom, 3);
    assert.equal(
      buildPlan({ workflowKey: 'a.b', params: null, steps: [step('a.b')] }).irreversibleFrom,
      null,
    );
  });

  it('does not change what it was given', () => {
    const items = [item('x.y', 'z')];
    const plan = buildPlan({ workflowKey: 'a.b', params: null, steps: [step('a.b', { items })] });
    assert.notEqual(plan.steps[0]?.items[0], items[0]);
    assert.deepEqual(plan.steps[0]?.items, items);
  });

  it('refuses a plan that is empty, too long, or has a bad key or a bad estimate', () => {
    assert.throws(
      () => buildPlan({ workflowKey: 'a.b', params: null, steps: [] }),
      InvalidPlanError,
    );
    assert.throws(
      () =>
        buildPlan({
          workflowKey: 'a.b',
          params: null,
          steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, () => step('a.b')),
        }),
      /at most 256 steps/u,
    );
    assert.throws(
      () => buildPlan({ workflowKey: 'Deploy', params: null, steps: [step('a.b')] }),
      /not a workflow key/u,
    );
    assert.throws(
      () => buildPlan({ workflowKey: 'a.b', params: null, steps: [step('nope')] }),
      /Step 0: "nope" is not a step key/u,
    );
    for (const estimateSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          buildPlan({
            workflowKey: 'a.b',
            params: null,
            steps: [step('a.b', { estimateSeconds })],
          }),
        /estimate/u,
      );
    }
    assert.doesNotThrow(() =>
      buildPlan({
        workflowKey: 'a.b',
        params: null,
        steps: Array.from({ length: MAX_PLAN_STEPS }, () => step('a.b')),
      }),
    );
  });

  it('allows the same step twice, because the place in the run tells them apart', () => {
    const plan = buildPlan({
      workflowKey: 'a.b',
      params: null,
      steps: [step('node.run'), step('node.run')],
    });
    assert.deepEqual(
      plan.steps.map((s) => s.index),
      [0, 1],
    );
  });
});

describe('the hash of a plan', () => {
  // The hash that approvals are bound to. If this changes, every approval that was given is void: change it knowingly.
  it('is this one for the plan above, forever', () => {
    // The text that is hashed, written out by hand: keys sorted, no white space, no title and no estimate.
    const text =
      '{"params":{"dns":"manual","name":"edge-09","ports":[443,8443],"zone":"example.test"},"steps":[' +
      '{"index":0,"items":[],"key":"ssh.connect","locks":["server:s-1"]},' +
      '{"index":1,"items":[{"kind":"file.read","summary":"file.read /etc/ssh/sshd_config","target":"/etc/ssh/sshd_config"}],"key":"node.snapshot","locks":["server:s-1"]},' +
      '{"index":2,"items":[{"kind":"package.install","summary":"package.install nginx","target":"nginx"},{"kind":"file.write","summary":"file.write /etc/nginx/nginx.conf","target":"/etc/nginx/nginx.conf"}],"key":"node.install.nginx","locks":["server:s-1","node:edge-09"]},' +
      '{"index":3,"items":[{"irreversible":true,"kind":"panel.node.create","summary":"panel.node.create edge-09","target":"edge-09"}],"key":"panel.create-node","locks":["panel","dns-zone:example.test"]}' +
      '],"workflowKey":"node.deploy"}';
    assert.equal(planHash(deploy()), sha256Hex(text));
    assert.equal(
      planHash(deploy()),
      '4a94f64181c669244ba3c46108b13467795f07f4f4d70180272a4ecd8380f33e',
    );
  });

  it('is the same for the same plan, whatever order the keys of the parameters were made in', () => {
    const again = buildPlan({
      workflowKey: 'node.deploy',
      params: { dns: 'manual', ports: [443, 8443], zone: 'example.test', name: 'edge-09' },
      steps: deploy().steps.map((s) => ({
        key: s.key,
        title: s.title,
        estimateSeconds: s.estimateSeconds,
        locks: s.locks.map((key) => {
          const [kind, id] = key.split(':');
          return kind === 'panel'
            ? panelResource()
            : kind === 'server'
              ? serverResource(id ?? '')
              : kind === 'node'
                ? nodeResource(id ?? '')
                : dnsZoneResource(id ?? '');
        }),
        items: s.items,
      })),
    });
    assert.equal(planHash(again), planHash(deploy()));
  });

  const base = () => ({
    workflowKey: 'node.deploy',
    params: { name: 'edge-09' } as const,
    steps: [
      step('a.one', { items: [item('file.write', '/x')], locks: [nodeResource('edge-09')] }),
      step('a.two'),
    ],
  });
  const hashOf = (change: (input: ReturnType<typeof base>) => unknown): string =>
    planHash(buildPlan(change(base()) as Parameters<typeof buildPlan>[0]));

  it('is another one when anything the run will do is another', () => {
    const reference = planHash(buildPlan(base()));
    const changed = [
      hashOf((p) => ({ ...p, workflowKey: 'node.redeploy' })),
      hashOf((p) => ({ ...p, params: { name: 'edge-10' } })),
      hashOf((p) => ({ ...p, params: { name: 'edge-09', extra: 1 } })),
      hashOf((p) => ({ ...p, steps: [...p.steps].reverse() })),
      hashOf((p) => ({ ...p, steps: [p.steps[0], step('a.three')] })),
      hashOf((p) => ({
        ...p,
        steps: [
          step('a.one', { items: [item('file.write', '/y')], locks: [nodeResource('edge-09')] }),
          p.steps[1],
        ],
      })),
      hashOf((p) => ({
        ...p,
        steps: [
          step('a.one', {
            items: [item('file.write', '/x', { summary: 'other' })],
            locks: [nodeResource('edge-09')],
          }),
          p.steps[1],
        ],
      })),
      hashOf((p) => ({
        ...p,
        steps: [
          step('a.one', {
            items: [item('file.write', '/x', { irreversible: true })],
            locks: [nodeResource('edge-09')],
          }),
          p.steps[1],
        ],
      })),
      hashOf((p) => ({
        ...p,
        steps: [
          step('a.one', { items: [item('file.write', '/x')], locks: [nodeResource('edge-10')] }),
          p.steps[1],
        ],
      })),
      hashOf((p) => ({
        ...p,
        steps: [step('a.one', { items: [item('file.write', '/x')], locks: [] }), p.steps[1]],
      })),
    ];
    assert.equal(new Set([reference, ...changed]).size, changed.length + 1);
  });

  it('is the same when only what describes a step changed: its title and its estimate', () => {
    const reference = planHash(buildPlan(base()));
    assert.equal(
      hashOf((p) => ({
        ...p,
        steps: [{ ...p.steps[0], title: 'Another title', estimateSeconds: 999 }, p.steps[1]],
      })),
      reference,
    );
  });

  it('is the same for `irreversible: false` and for no `irreversible`, and for the locks named in another order', () => {
    const reference = planHash(buildPlan(base()));
    assert.equal(
      hashOf((p) => ({
        ...p,
        steps: [
          step('a.one', {
            items: [item('file.write', '/x', { irreversible: false })],
            locks: [nodeResource('edge-09')],
          }),
          p.steps[1],
        ],
      })),
      reference,
    );
    const two = (locks: StepPlanInput['locks']) =>
      planHash(buildPlan({ workflowKey: 'a.b', params: null, steps: [step('a.b', { locks })] }));
    assert.equal(
      two([nodeResource('a'), serverResource('b')]),
      two([serverResource('b'), nodeResource('a'), nodeResource('a')]),
    );
  });

  it('refuses a plan whose parameters cannot be written as JSON, when the plan is made', () => {
    assert.throws(
      () => buildPlan({ workflowKey: 'a.b', params: { n: Number.NaN }, steps: [step('a.b')] }),
      CanonicalJsonError,
    );
  });
});
