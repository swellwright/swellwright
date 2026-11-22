import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  type BaselineFleet,
  BaselineFleetSchema,
  type BaselineView,
  BaselineViewSchema,
  type CheckRunDiff,
  CheckRunDiffSchema,
  CheckRunListSchema,
  type CheckRunView,
  CheckRunViewSchema,
  StartBaselineRunsResultSchema,
} from '@swellwright/contracts';

import {
  createGate,
  eventsOf,
  FP_OTHER,
  Harness,
  LOGIN,
  OTHER,
  PASSPHRASE,
  SUDO,
  until,
} from '../commands/commands-test-support.js';
import type { Gate, Program, StepHost } from '../commands/step-host.js';
import { databaseUrl, errorCode } from '../test-support.js';
import { CheckRunner } from './check-runner.service.js';
import { CheckScheduler } from './check-scheduler.service.js';

/** What a stand-in server reports for each kind of observation: the lines of the observation, or `denied`. */
type World = Record<string, readonly string[] | 'denied'>;

const GOOD_WORLD: World = {
  'sshd.effective': ['permitrootlogin=no'],
  'disk.usage': ['mountpoint=/', 'usedPercent=31', 'availableMiB=9000', 'inodeUsedPercent=10'],
  'ports.public': ['ports=tcp/22', 'ports=tcp/443', 'count=2'],
  'ufw.status': ['installed=yes', 'active=yes', 'defaultIncoming=deny', 'ruleCount=0'],
};

const MINI = `
schema: 1
description: Four checks for the tests.
checks:
  - id: ssh.root
    title: Root cannot log in over SSH
    category: ssh
    severity: high
    observe: { kind: sshd.effective, field: permitrootlogin }
    expect: { equals: "no" }
    remediationHint: Set PermitRootLogin no.
  - id: disk.root
    title: The root filesystem is not nearly full
    category: resources
    severity: medium
    observe: { kind: disk.usage, params: { path: / }, field: usedPercent }
    expect: { atMost: 90 }
  - id: ports.allowed
    title: Only the expected ports listen
    category: network
    severity: medium
    observe: { kind: ports.public, field: ports }
    expect: { in: [tcp/22, tcp/443] }
  - id: ufw.on
    title: The firewall is active
    category: firewall
    severity: high
    observe: { kind: ufw.status, field: active }
    expect: { equals: true }
`;

/**
 * The program of the stand-in server that stands for the observation script: it reads the plan from its standard input and
 * answers every line from the world, in the format of the real script, so that the whole run is tested without a shell.
 */
function baselineProgram(options: {
  world: () => World;
  gate?: () => Gate | undefined;
  raw?: () => string | undefined;
  uid?: number;
}): Program {
  return async (context) => {
    await options.gate?.()?.promise;
    const raw = options.raw?.();
    if (raw !== undefined) {
      context.write('stdout', raw);
      return 0;
    }
    context.write(
      'stdout',
      `@@swb v1\n@@swb epoch ${String(Math.floor(Date.now() / 1000))}\n@@swb uid ${String(options.uid ?? 0)}\n`,
    );
    for (const line of context.stdin.split('\n')) {
      if (line.length === 0) {
        continue;
      }
      const [index = '', kind = ''] = line.split('\t');
      const answer = options.world()[kind];
      context.write('stdout', `@@swb begin ${index} ${kind}\n`);
      if (answer === undefined) {
        context.write('stdout', `\n@@swb end ${index} 99\n`);
      } else if (answer === 'denied') {
        context.write('stdout', `\n@@swb end ${index} 11\n`);
      } else {
        for (const field of answer) {
          context.write('stdout', `| ${field}\n`);
        }
        context.write('stdout', `\n@@swb end ${index} 0\n`);
      }
    }
    context.write('stdout', '@@swb done\n');
    return 0;
  };
}

const isBaselineScript = (script: string): string | undefined =>
  script.includes('# swellwright-baseline:') ? 'baseline' : undefined;

describe('baseline checks over SSH', { skip: !databaseUrl }, () => {
  const h = new Harness();
  let world: World = GOOD_WORLD;
  let gate: Gate | undefined;
  let raw: string | undefined;
  let host: StepHost;
  let serverId = '';
  let baselineId = '';

  const program = baselineProgram({ world: () => world, gate: () => gate, raw: () => raw });

  const waitForRun = async (id: string): Promise<CheckRunView> => {
    const found = await until(
      `run ${id} to end`,
      async () => {
        const reply = await h.owner.get(`/baseline-runs/${id}`);
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        const run = CheckRunViewSchema.parse(reply.body);
        return run.state === 'completed' || run.state === 'error' ? run : undefined;
      },
      30_000,
    );
    return found;
  };

  const runOnce = async (
    id = serverId,
    body: Record<string, unknown> = {},
  ): Promise<CheckRunView> => {
    const started = await h.operator.post(`/servers/${id}/baseline-runs`, body);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    return waitForRun((started.body as { id: string }).id);
  };

  before(async () => {
    await h.open({
      SW_BASELINE_RATE_LIMIT_PER_MINUTE: '600',
      SW_CHECKS_POLL_MS: '25',
      SW_CHECKS_KEEP_RUNS: '3',
      SW_CHECKS_PARALLELISM: '2',
    });
    host = await h.host({ baseline: program }, { programFor: isBaselineScript, uid: 1000 });
    serverId = await h.server(host, { name: 'checked-1' });
    const created = await h.operator.post('/baselines', {
      name: 'mini',
      source: MINI,
      comment: 'The first version.',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    baselineId = BaselineViewSchema.parse(created.body).id;
    const assigned = await h.operator.call('PUT', `/baselines/${baselineId}/assignments`, {
      serverIds: [serverId],
      tags: [],
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  });
  after(async () => {
    await h.close();
  });

  it('ships the two built-in baselines, valid, and a catalogue of observations', async () => {
    const list = await h.observer.get('/baselines');
    assert.equal(list.status, 200);
    const names = (list.body as { baselines: { name: string; builtIn: boolean }[] }).baselines;
    assert.deepEqual(
      names.filter((entry) => entry.builtIn).map((entry) => entry.name),
      ['linux-generic', 'node-selfsteal'],
    );
    const generic = names.find((entry) => entry.name === 'linux-generic');
    assert.ok(generic);
    const view = await h.observer.get(`/baselines/${(generic as unknown as { id: string }).id}`);
    assert.equal(view.status, 200);
    assert.ok(BaselineViewSchema.parse(view.body).source.startsWith('# Baseline "linux-generic"'));
    const catalogue = await h.observer.get('/baseline-catalogue');
    assert.equal(catalogue.status, 200);
    assert.ok((catalogue.body as { kinds: unknown[] }).kinds.length >= 30);
  });

  it('checks a server, stores every result, and leaves nothing behind on it', async () => {
    const run = await runOnce();
    assert.equal(run.state, 'completed', JSON.stringify(run));
    assert.equal(run.errorCode, null);
    assert.deepEqual(run.counts, { pass: 4, warn: 0, fail: 0, error: 0, skipped: 0 });
    assert.equal(run.baseline.name, 'mini');
    assert.equal(run.baseline.version, 1);
    assert.equal(run.trigger, 'manual');
    assert.equal(run.startedBy?.name, 'ops');
    assert.equal(run.collectedAs, 'sudo');
    assert.equal(run.trend, null);
    assert.equal(run.changedSincePrevious, null);
    assert.match(run.scriptSha256 ?? '', /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      run.results.map((result) => [result.checkId, result.status]),
      [
        ['ssh.root', 'pass'],
        ['disk.root', 'pass'],
        ['ports.allowed', 'pass'],
        ['ufw.on', 'pass'],
      ],
    );
    const root = run.results[0];
    assert.equal(root?.observed, 'no');
    assert.deepEqual(root.expectation, { comparator: 'equals', value: 'no' });
    assert.equal(root.remediationHint, 'Set PermitRootLogin no.');
    assert.deepEqual(run.results[2]?.observed, ['tcp/22', 'tcp/443']);
    assert.deepEqual(run.results[1]?.observation, {
      kind: 'disk.usage',
      field: 'usedPercent',
      params: { path: '/' },
      status: 'ok',
    });
    // One session, one step, and the step's directory was removed.
    assert.equal(host.server.connections, 1);
    assert.equal(host.launches.created, 1);
    assert.equal(host.removed.length, 1);
    // No secret of the login went anywhere it should not: not into a command line, not into the answer.
    assert.ok(!host.commands.some((command) => command.includes(LOGIN)));
    assert.ok(!JSON.stringify(run).includes(LOGIN));
  });

  it('says what each result means: a miss is a fail or a warn by severity, an unknown is an error', async () => {
    world = {
      ...GOOD_WORLD,
      'sshd.effective': ['permitrootlogin=yes'],
      'disk.usage': ['usedPercent=95'],
      'ports.public': ['ports=tcp/22', 'ports=tcp/3306'],
      'ufw.status': 'denied',
    };
    try {
      const run = await runOnce();
      assert.equal(run.state, 'completed');
      assert.deepEqual(run.counts, { pass: 0, warn: 2, fail: 1, error: 1, skipped: 0 });
      const by = new Map(run.results.map((result) => [result.checkId, result]));
      assert.equal(by.get('ssh.root')?.status, 'fail');
      assert.equal(by.get('ssh.root')?.message, 'Observed "yes", expected "no".');
      assert.equal(by.get('disk.root')?.status, 'warn');
      assert.equal(by.get('ports.allowed')?.status, 'warn');
      assert.match(by.get('ports.allowed')?.message ?? '', /tcp\/3306/u);
      assert.equal(by.get('ufw.on')?.status, 'error');
      assert.equal(by.get('ufw.on')?.observation.status, 'denied');
      assert.equal(by.get('ufw.on')?.observed, null);
    } finally {
      world = GOOD_WORLD;
    }
  });

  it('shows the drift between two runs, and how the server is doing in the fleet', async () => {
    const before = await runOnce();
    world = { ...GOOD_WORLD, 'sshd.effective': ['permitrootlogin=yes'] };
    const worse = await runOnce();
    assert.equal(worse.trend, 'worse');
    assert.equal(worse.changedSincePrevious, 1);
    const diff = await h.observer.get(`/baseline-runs/${worse.id}/diff`);
    assert.equal(diff.status, 200, JSON.stringify(diff.body));
    const drift: CheckRunDiff = CheckRunDiffSchema.parse(diff.body);
    assert.equal(drift.from?.id, before.id);
    assert.equal(drift.identical, false);
    assert.deepEqual(drift.counts, {
      regressed: 1,
      improved: 0,
      changed: 0,
      added: 0,
      removed: 0,
      unchanged: 3,
    });
    assert.deepEqual(
      drift.changes.map((change) => [
        change.checkId,
        change.change,
        change.from?.status,
        change.to?.status,
      ]),
      [['ssh.root', 'regressed', 'pass', 'fail']],
    );

    const fleet: BaselineFleet = BaselineFleetSchema.parse(
      (await h.observer.get('/baseline-fleet')).body,
    );
    const item = fleet.items.find((entry) => entry.server.id === serverId);
    assert.equal(item?.baseline?.name, 'mini');
    assert.equal(item.assignedBy, 'server');
    assert.equal(item.lastRun?.id, worse.id);
    assert.equal(item.trend, 'worse');
    assert.equal(fleet.totals.failing, 1);
    assert.equal(fleet.totals.failingChecks, 1);

    world = GOOD_WORLD;
    const better = await runOnce();
    assert.equal(better.trend, 'better');
    const again = CheckRunDiffSchema.parse(
      (await h.observer.get(`/baseline-runs/${better.id}/diff?against=${before.id}`)).body,
    );
    assert.equal(again.identical, true, 'compared with the first of the three, nothing differs');
    assert.deepEqual(again.changes, []);
    // A run of another server, or a run that did not complete, cannot be compared.
    assert.equal(
      (await h.observer.get(`/baseline-runs/${better.id}/diff?against=${better.id}`)).status,
      409,
    );
  });

  it('keeps only the newest SW_CHECKS_KEEP_RUNS runs of a server', async () => {
    for (let index = 0; index < 4; index += 1) {
      await runOnce();
    }
    const list = CheckRunListSchema.parse(
      (await h.observer.get(`/servers/${serverId}/baseline-runs`)).body,
    );
    assert.equal(list.total, 3);
    assert.equal(list.runs.length, 3);
    const rows = await h.instance.isolated.database.client.checkResult.count();
    assert.equal(rows, 3 * 4, 'the results of a deleted run went with it');
    const page = CheckRunListSchema.parse(
      (await h.observer.get(`/servers/${serverId}/baseline-runs?limit=1&offset=1`)).body,
    );
    assert.equal(page.runs.length, 1);
    assert.equal(page.total, 3);
  });

  it('runs one check per server at a time, and says so', async () => {
    gate = createGate();
    try {
      const started = await h.operator.post(`/servers/${serverId}/baseline-runs`, {});
      assert.equal(started.status, 201);
      const second = await h.operator.post(`/servers/${serverId}/baseline-runs`, {});
      assert.equal(second.status, 409);
      assert.equal(errorCode(second), 'conflict');
      assert.deepEqual((second.body as { error: { details: unknown } }).error.details, {
        reason: 'already_running',
      });
      const fleet = await h.operator.post('/baseline-runs', { all: true });
      assert.equal(fleet.status, 201);
      const result = StartBaselineRunsResultSchema.parse(fleet.body);
      assert.deepEqual(result.runs, []);
      assert.deepEqual(
        result.skipped.map((entry) => entry.reason),
        ['already_running'],
      );
      const going = BaselineFleetSchema.parse((await h.observer.get('/baseline-fleet')).body);
      assert.equal(going.items.find((item) => item.server.id === serverId)?.running, true);
      gate.open();
      await waitForRun((started.body as { id: string }).id);
    } finally {
      gate.open();
      gate = undefined;
    }
  });

  it('turns a server that cannot be reached into an error with the reason, never a crash', async () => {
    const cases: { name: string; options: Parameters<Harness['server']>[1]; code: string }[] = [
      { name: 'key-changed', options: { fingerprint: FP_OTHER }, code: 'host_key_mismatch' },
      { name: 'wrong-password', options: { password: h.secrets.wrong }, code: 'ssh_auth_failed' },
      { name: 'not-pinned', options: { fingerprint: null }, code: 'host_key_not_pinned' },
      { name: 'no-access', options: { access: false }, code: 'no_access_entry' },
    ];
    for (const entry of cases) {
      const id = await h.server(host, { name: entry.name, ...entry.options });
      const baseline = await h.operator.post(`/servers/${id}/baseline-runs`, { baselineId });
      assert.equal(baseline.status, 201, JSON.stringify(baseline.body));
      const run = await waitForRun((baseline.body as { id: string }).id);
      assert.equal(run.state, 'error', entry.name);
      assert.equal(run.errorCode, entry.code, entry.name);
      assert.equal(run.results.length, 0);
      assert.deepEqual(run.counts, { pass: 0, warn: 0, fail: 0, error: 0, skipped: 0 });
      assert.ok((run.errorMessage ?? '').length > 10);
      assert.ok(!(run.errorMessage ?? '').includes(OTHER));
    }
    // The wrong key is seen before any credential is sent: the server saw no login attempt of that run's server.
    const mismatch = host.server.authAttempts.filter(
      (attempt) => attempt.method === 'password' && !attempt.accepted,
    ).length;
    assert.equal(mismatch, 1, 'only the wrong password was tried, once');
    const events = await eventsOf(h.instance, 'baseline.run.finished');
    assert.ok(
      events.some(
        (event) =>
          event.outcome === 'failure' && event.details['error_code'] === 'host_key_mismatch',
      ),
    );
  });

  it('reports an expired secret and a sealed vault, and an output that is not the script', async () => {
    const id = await h.server(host, { name: 'expiring' });
    await h.instance.isolated.database.client.secret.update({
      where: { id: h.secrets.login },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const expired = await h.operator.post(`/servers/${id}/baseline-runs`, { baselineId });
    const run = await waitForRun((expired.body as { id: string }).id);
    assert.equal(run.errorCode, 'secret_expired');
    await h.instance.isolated.database.client.secret.update({
      where: { id: h.secrets.login },
      data: { expiresAt: null },
    });

    raw = 'Welcome to the server\nNo mail.\n';
    try {
      const garbage = await runOnce(id, { baselineId });
      assert.equal(garbage.state, 'error');
      assert.equal(garbage.errorCode, 'observe_unreadable');
    } finally {
      raw = undefined;
    }

    assert.equal((await h.owner.post('/vault/seal')).status, 200);
    const sealed = await h.operator.post(`/servers/${id}/baseline-runs`, { baselineId });
    assert.equal(sealed.status, 423);
    assert.equal((await h.operator.post('/baseline-runs', { all: true })).status, 423);
    assert.equal((await h.owner.post('/vault/unseal', { passphrase: PASSPHRASE })).status, 200);
  });

  it('refuses to guess about a server whose login has no sudo: the run says it looked as the login', async () => {
    const plain = await h.host(
      { baseline: program },
      { programFor: isBaselineScript, uid: 1000, sudoFails: true },
    );
    const id = await h.server(plain, { name: 'no-sudo' });
    world = { ...GOOD_WORLD, 'ufw.status': 'denied' };
    try {
      const run = await runOnce(id, { baselineId });
      assert.equal(run.collectedAs, 'user');
      assert.equal(run.results.find((result) => result.checkId === 'ufw.on')?.status, 'error');
    } finally {
      world = GOOD_WORLD;
    }
    const rootHost = await h.host({ baseline: program }, { programFor: isBaselineScript, uid: 0 });
    const rootId = await h.server(rootHost, { name: 'root-login' });
    assert.equal((await runOnce(rootId, { baselineId })).collectedAs, 'root');
  });

  it('works through the fleet form with a cap on how many servers are checked at once', async () => {
    let running = 0;
    let highest = 0;
    const counting: Program = async (context) => {
      running += 1;
      highest = Math.max(highest, running);
      await context.sleep(150);
      running -= 1;
      return baselineProgram({ world: () => GOOD_WORLD })(context);
    };
    const busy = await h.host({ baseline: counting }, { programFor: isBaselineScript, uid: 0 });
    const ids: string[] = [];
    for (const name of ['fleet-a', 'fleet-b', 'fleet-c', 'fleet-d']) {
      ids.push(await h.server(busy, { name }));
    }
    const started = await h.operator.post('/baseline-runs', { serverIds: ids, baselineId });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const result = StartBaselineRunsResultSchema.parse(started.body);
    assert.equal(result.runs.length, 4);
    for (const run of result.runs) {
      assert.equal((await waitForRun(run.id)).state, 'completed');
    }
    assert.ok(highest <= 2, `at most two at once, saw ${String(highest)}`);
    assert.ok(highest >= 1);
    // A server without a baseline is left out with the reason.
    const unassigned = await h.server(busy, { name: 'fleet-e' });
    const skipped = StartBaselineRunsResultSchema.parse(
      (await h.operator.post('/baseline-runs', { serverIds: [unassigned] })).body,
    );
    assert.deepEqual(
      skipped.skipped.map((entry) => entry.reason),
      ['no_baseline'],
    );
    const single = await h.operator.post(`/servers/${unassigned}/baseline-runs`, {});
    assert.equal(single.status, 409);
    assert.deepEqual((single.body as { error: { details: unknown } }).error.details, {
      reason: 'no_baseline',
    });
    // Neither a missing server nor a missing baseline is a run.
    assert.equal(
      (await h.operator.post('/servers/00000000-0000-4000-8000-000000000000/baseline-runs', {}))
        .status,
      404,
    );
    assert.equal(
      (
        await h.operator.post(`/servers/${ids[0] ?? ''}/baseline-runs`, {
          baselineId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
      404,
    );
  });

  it('versions a baseline, refuses a stale edit and a change to a built-in one, and moves assignments', async () => {
    const edited = await h.operator.call('PUT', `/baselines/${baselineId}`, {
      source: MINI.replace('atMost: 90', 'atMost: 80'),
      comment: 'Stricter disk.',
      expectedVersion: 1,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const view: BaselineView = BaselineViewSchema.parse(edited.body);
    assert.equal(view.currentVersion, 2);
    assert.deepEqual(
      view.versions.map((version) => [version.version, version.comment]),
      [
        [2, 'Stricter disk.'],
        [1, 'The first version.'],
      ],
    );
    const first = BaselineViewSchema.parse(
      (await h.observer.get(`/baselines/${baselineId}?version=1`)).body,
    );
    assert.ok(first.source.includes('atMost: 90'));
    assert.equal((await h.observer.get(`/baselines/${baselineId}?version=9`)).status, 404);

    const stale = await h.operator.call('PUT', `/baselines/${baselineId}`, {
      source: MINI,
      expectedVersion: 1,
    });
    assert.equal(stale.status, 409);
    assert.equal(
      (
        await h.operator.call('PUT', `/baselines/${baselineId}`, {
          source: MINI.replace('atMost: 90', 'atMost: 80'),
        })
      ).status,
      200,
    );
    assert.equal(
      BaselineViewSchema.parse((await h.observer.get(`/baselines/${baselineId}`)).body)
        .currentVersion,
      2,
      'the same text is not a new version',
    );
    const bad = await h.operator.call('PUT', `/baselines/${baselineId}`, {
      source: MINI.replace('equals: "no"', 'atLeast: 3'),
    });
    assert.equal(bad.status, 400);
    assert.equal(errorCode(bad), 'validation_failed');
    assert.ok(JSON.stringify(bad.body).includes('checks[0].expect.atLeast'));

    const list = (await h.observer.get('/baselines')).body as {
      baselines: { id: string; name: string; builtIn: boolean }[];
    };
    const builtin = list.baselines.find((entry) => entry.builtIn);
    assert.ok(builtin);
    const refused = await h.operator.call('PUT', `/baselines/${builtin.id}`, { source: MINI });
    assert.equal(refused.status, 409);
    assert.equal((await h.operator.call('DELETE', `/baselines/${builtin.id}`)).status, 409);

    // A server given to another baseline moves there.
    const other = BaselineViewSchema.parse(
      (await h.operator.post('/baselines', { name: 'other', source: MINI })).body,
    );
    const moved = await h.operator.call('PUT', `/baselines/${other.id}/assignments`, {
      serverIds: [serverId],
      tags: ['edge'],
    });
    assert.equal(moved.status, 200);
    const mini = BaselineViewSchema.parse((await h.observer.get(`/baselines/${baselineId}`)).body);
    assert.deepEqual(mini.assignments.servers, []);
    assert.equal(mini.serverCount, 0);
    const run = await runOnce();
    assert.equal(run.baseline.name, 'other');
    // The runs of a deleted baseline stay and name it.
    assert.equal((await h.operator.call('DELETE', `/baselines/${other.id}`)).status, 204);
    const kept = CheckRunViewSchema.parse((await h.observer.get(`/baseline-runs/${run.id}`)).body);
    assert.equal(kept.baseline.id, null);
    assert.equal(kept.baseline.name, 'other');
    assert.equal(kept.results.length, 4);
  });

  it('applies a baseline to the servers that carry a tag, unless the server has one of its own', async () => {
    const tagged = await h.server(host, { name: 'tagged' });
    await h.owner.call('PATCH', `/servers/${tagged}`, { tags: ['edge'] });
    const edge = BaselineViewSchema.parse(
      (await h.operator.post('/baselines', { name: 'edge-baseline', source: MINI })).body,
    );
    assert.equal(
      (
        await h.operator.call('PUT', `/baselines/${edge.id}/assignments`, {
          serverIds: [],
          tags: ['edge'],
        })
      ).status,
      200,
    );
    const fleet = BaselineFleetSchema.parse((await h.observer.get('/baseline-fleet')).body);
    const item = fleet.items.find((entry) => entry.server.id === tagged);
    assert.equal(item?.baseline?.name, 'edge-baseline');
    assert.equal(item.assignedBy, 'tag');
    assert.equal((await runOnce(tagged)).baseline.name, 'edge-baseline');
    const summary = BaselineViewSchema.parse((await h.observer.get(`/baselines/${edge.id}`)).body);
    assert.equal(summary.serverCount, 1);
    assert.deepEqual(summary.assignments.tags, ['edge']);
  });

  it('records what was done in the audit log, with no value that was observed', async () => {
    const started = await eventsOf(h.instance, 'baseline.run');
    assert.ok(started.length >= 5);
    const first = started[0];
    assert.equal(first?.actor?.name, 'ops');
    assert.equal(first.details['trigger'], 'manual');
    assert.equal(first.details['baseline'], 'mini');
    const finished = await eventsOf(h.instance, 'baseline.run.finished');
    assert.ok(finished.length >= 5);
    assert.equal(finished[0]?.actor, null);
    assert.equal(finished[0].details['state'], 'completed');
    assert.equal(finished[0].details['pass'], 4);
    const versions = await eventsOf(h.instance, 'baseline.version.created');
    assert.ok(
      versions.every((event) => event.details['built_in'] !== true),
      'the built-ins, which are the content of the build, are not in the audit chain',
    );
    assert.ok(
      versions.some(
        (event) => event.details['baseline'] === 'mini' && event.details['version'] === 2,
      ),
    );
    assert.ok((await eventsOf(h.instance, 'baseline.assigned')).length >= 2);
    assert.ok((await eventsOf(h.instance, 'baseline.deleted')).length >= 1);
    const everything = JSON.stringify([...started, ...finished, ...versions]);
    for (const value of ['permitrootlogin', 'tcp/3306', LOGIN, SUDO, 'usedPercent=95']) {
      assert.ok(!everything.includes(value), `the audit log holds ${value}`);
    }
  });

  it('lets every reader read, and only those who may run or edit do so, with a fresh code', async () => {
    const runId = (await runOnce(serverId, { baselineId })).id;
    const reads = [
      '/baselines',
      '/baseline-catalogue',
      '/baseline-fleet',
      `/servers/${serverId}/baseline-runs`,
      `/baseline-runs/${runId}`,
      `/baseline-runs/${runId}/diff`,
    ];
    for (const client of [h.observer, h.auditor, h.operator, h.owner]) {
      for (const path of reads) {
        assert.equal((await client.get(path)).status, 200, path);
      }
      assert.equal((await client.post('/baselines/validate', { source: MINI })).status, 200);
    }
    const anonymous = h.instance.client();
    for (const path of reads) {
      assert.equal((await anonymous.get(path)).status, 401, path);
    }
    assert.equal((await anonymous.post(`/servers/${serverId}/baseline-runs`, {})).status, 401);
    // Nobody who is not allowed to run commands or to write servers.
    for (const client of [h.observer, h.auditor]) {
      assert.equal(
        errorCode(await client.post(`/servers/${serverId}/baseline-runs`, {})),
        'forbidden',
      );
      assert.equal(errorCode(await client.post('/baseline-runs', { all: true })), 'forbidden');
      assert.equal(
        errorCode(await client.post('/baselines', { name: 'x', source: MINI })),
        'forbidden',
      );
      assert.equal(
        errorCode(await client.call('PUT', `/baselines/${baselineId}`, { source: MINI })),
        'forbidden',
      );
      assert.equal(
        errorCode(
          await client.call('PUT', `/baselines/${baselineId}/assignments`, {
            serverIds: [],
            tags: [],
          }),
        ),
        'forbidden',
      );
      assert.equal(errorCode(await client.call('DELETE', `/baselines/${baselineId}`)), 'forbidden');
    }
    // The operator needs a fresh code for each of them.
    await h.lapse();
    assert.equal(
      errorCode(await h.operator.post(`/servers/${serverId}/baseline-runs`, {})),
      'step_up_required',
    );
    assert.equal(
      errorCode(await h.operator.post('/baseline-runs', { all: true })),
      'step_up_required',
    );
    assert.equal(
      errorCode(await h.operator.post('/baselines', { name: 'y', source: MINI })),
      'step_up_required',
    );
    assert.equal(
      errorCode(await h.operator.call('PUT', `/baselines/${baselineId}`, { source: MINI })),
      'step_up_required',
    );
    assert.equal(
      errorCode(
        await h.operator.call('PUT', `/baselines/${baselineId}/assignments`, {
          serverIds: [],
          tags: [],
        }),
      ),
      'step_up_required',
    );
    assert.equal(
      errorCode(await h.operator.call('DELETE', `/baselines/${baselineId}`)),
      'step_up_required',
    );
    await h.stepUp(h.operator, 'ops');
    assert.equal(
      (await h.operator.post(`/servers/${serverId}/baseline-runs`, { baselineId })).status,
      201,
    );
    // The reads need no code.
    await h.lapse();
    assert.equal((await h.operator.get('/baseline-fleet')).status, 200);
  });

  it('closes the runs that were going on when the process stopped, and starts clean', async () => {
    await h.instance.app.get(CheckRunner).idle();
    const client = h.instance.isolated.database.client;
    const created = await client.checkRun.create({
      data: {
        serverId,
        serverName: 'checked-1',
        baselineName: 'ghost',
        baselineVersion: 1,
        baselineSha256: '0'.repeat(64),
        trigger: 'manual',
        state: 'running',
      },
    });
    await h.restart({
      SW_CHECKS_POLL_MS: '25',
      SW_CHECKS_KEEP_RUNS: '3',
      SW_CHECKS_PARALLELISM: '2',
    });
    const closed = await client.checkRun.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(closed.state, 'error');
    assert.equal(closed.errorCode, 'interrupted');
    assert.notEqual(closed.finishedAt, null);
  });
});

describe('the schedule of baseline checks', { skip: !databaseUrl }, () => {
  const h = new Harness();
  let clock = Date.UTC(2027, 0, 1, 0, 0, 0);
  let host: StepHost;
  let serverIds: string[] = [];
  const HOUR = 3_600_000;

  before(async () => {
    await h.open(
      {
        SW_BASELINE_RATE_LIMIT_PER_MINUTE: '600',
        SW_CHECKS_POLL_MS: '25',
        SW_CHECKS_INTERVAL_HOURS: '6',
        SW_CHECKS_PARALLELISM: '3',
        SW_CHECKS_KEEP_RUNS: '5',
      },
      { checksClock: () => clock },
    );
    host = await h.host(
      { baseline: baselineProgram({ world: () => GOOD_WORLD }) },
      { programFor: isBaselineScript, uid: 0 },
    );
    for (const name of ['sched-a', 'sched-b', 'sched-c']) {
      serverIds.push(await h.server(host, { name }));
    }
    const baseline = BaselineViewSchema.parse(
      (await h.operator.post('/baselines', { name: 'scheduled', source: MINI })).body,
    );
    await h.operator.call('PUT', `/baselines/${baseline.id}/assignments`, {
      serverIds: [...serverIds],
      tags: [],
    });
    serverIds = [...serverIds];
  });
  after(async () => {
    await h.close();
  });

  const round = async () => {
    const scheduler = h.instance.app.get(CheckScheduler);
    const result = await scheduler.runOnce();
    await h.instance.app.get(CheckRunner).idle();
    return result;
  };

  it('does nothing at first, staggers the first checks within the first hour, and then repeats on the interval', async () => {
    assert.deepEqual((await round()).started.length <= serverIds.length, true);
    clock += 2 * HOUR;
    await round();
    const client = h.instance.isolated.database.client;
    const first = await client.checkRun.findMany({ where: { trigger: 'scheduled' } });
    assert.equal(first.length, 3, 'every server was checked once within the first hour');
    assert.ok(first.every((run) => run.startedById === null && run.state === 'completed'));
    // Nothing is due until the interval has passed.
    clock += 3 * HOUR;
    assert.deepEqual((await round()).started, []);
    clock += 4 * HOUR;
    assert.equal((await round()).started.length, 3);
    assert.equal(await client.checkRun.count(), 6);
    const finished = await eventsOf(h.instance, 'baseline.run.finished');
    assert.ok(finished.every((event) => event.actor === null));
    const started = await eventsOf(h.instance, 'baseline.run');
    assert.ok(
      started.every((event) => event.actor === null && event.details['trigger'] === 'scheduled'),
    );
  });

  it('is skipped while the vault is sealed, and leaves out a server whose secret has expired', async () => {
    clock += 7 * HOUR;
    assert.equal((await h.owner.post('/vault/seal')).status, 200);
    const sealed = await round();
    assert.equal(sealed.skipped, 'vault_not_open');
    assert.deepEqual(sealed.started, []);
    assert.equal((await h.owner.post('/vault/unseal', { passphrase: PASSPHRASE })).status, 200);

    const client = h.instance.isolated.database.client;
    const lone = await h.server(host, { name: 'sched-expired', access: false });
    const secret = await h.secret('short lived', 'ssh_password', LOGIN);
    await h.owner.post(`/servers/${lone}/access`, {
      method: 'password',
      username: 'runner',
      secretId: secret,
    });
    await client.secret.update({
      where: { id: secret },
      data: { expiresAt: new Date(clock - HOUR) },
    });
    const baselines = (await h.observer.get('/baselines')).body as {
      baselines: { id: string; name: string }[];
    };
    const scheduled = baselines.baselines.find((entry) => entry.name === 'scheduled');
    await h.operator.call('PUT', `/baselines/${scheduled?.id ?? ''}/assignments`, {
      serverIds: [...serverIds, lone],
      tags: [],
    });
    const before = await client.checkRun.count({ where: { serverId: lone } });
    await round();
    assert.equal(
      await client.checkRun.count({ where: { serverId: lone } }),
      before,
      'nothing was tried for it',
    );
  });
});
