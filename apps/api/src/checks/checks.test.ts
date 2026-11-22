import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ConventionLastRunSchema,
  ConventionPackValidationSchema,
  ConventionPackVersionListSchema,
  ConventionPackViewSchema,
  ConventionRuleCatalogSchema,
  ConventionRunSchema,
  CreatedTokenSchema,
  ImpactReportSchema,
  type ImpactReport,
  ImpactTargetSchema,
  ReconciliationReportSchema,
} from '@swellwright/contracts';
import { DnsQueryError, type DnsQuery } from '@swellwright/conventions';
import {
  applyChecksScenario,
  CHECKS_ZONE,
  FakePanel,
  must,
} from '@swellwright/remnawave/test-support';

import {
  PANEL_ENV,
  PASSPHRASE,
  assertClean,
  connect,
  errorOf,
  forbiddenTexts,
  makeSecret,
} from '../panel/panel-test-support.js';
import {
  auditEvents,
  type Client,
  codeFor,
  createOwner,
  createUser,
  databaseUrl,
  forgetLastStep,
  type Instance,
  signInAs,
  start,
  stop,
} from '../test-support.js';

/** A fake DNS over a table, with names that fail on purpose, and a count of what was asked. */
function fakeDns(
  zone: Readonly<Record<string, readonly string[]>> = CHECKS_ZONE,
  failing: Readonly<Record<string, 'timeout' | 'error'>> = {},
) {
  const asked: string[] = [];
  const query: DnsQuery = (name, type) => {
    asked.push(`${name}/${type}`);
    const failure = failing[name];
    if (failure !== undefined) {
      return Promise.reject(new DnsQueryError(failure));
    }
    const records = zone[name];
    if (type !== 'A' || records === undefined) {
      return Promise.reject(new DnsQueryError('none'));
    }
    return Promise.resolve({ records: [...records], ttl: 300 });
  };
  return { query, asked };
}

interface Booted {
  readonly instance: Instance;
  readonly owner: Client;
  readonly secret: string;
  readonly fake: FakePanel;
  readonly dns: ReturnType<typeof fakeDns>;
  readonly tokens: string[];
}

/** An instance with an owner, an open vault, and a fake panel with things wrong in it connected. */
async function boot(
  env: Record<string, string> = {},
  dnsOptions: Parameters<typeof fakeDns> = [],
  connectPanel = true,
): Promise<Booted> {
  const fake = await FakePanel.start();
  applyChecksScenario(fake.fixtures);
  const dns = fakeDns(...dnsOptions);
  const instance = await start({ ...PANEL_ENV, ...env }, { dnsQuery: dns.query });
  const { secret } = await createOwner(instance);
  const owner = await signInAs(instance, 'owner', secret);
  assert.equal((await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status, 201);
  if (connectPanel) {
    const id = await makeSecret(owner, 'panel token', 'panel_token', fake.token);
    const connected = await connect(owner, fake.url, id);
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
  }
  return { instance, owner, secret, fake, dns, tokens: [fake.token] };
}

async function shutdown(booted: Booted): Promise<void> {
  await stop(booted.instance);
  await booted.fake.close();
}

/** Lets the elevation of every session lapse, as if the step-up window had run out. */
async function lapse(instance: Instance): Promise<void> {
  await instance.isolated.database.client.session.updateMany({
    data: { elevatedUntil: new Date(Date.now() - 1000) },
  });
}

const PACK_YAML = `format: swellwright.conventions/v1
name: Test conventions
rules:
  host.remark-pattern:
    params:
      pattern: "Host [1-4]"
  host.state:
    enabled: false
`;

const at = <T>(list: readonly T[], index: number): T =>
  must(list[index], `element ${String(index)}`);

const get = (client: Client, path: string) => client.get(`/panel/checks${path}`);

describe('the convention linter over the API', { skip: !databaseUrl }, () => {
  let booted: Booted;
  before(async () => {
    booted = await boot();
  });
  after(async () => {
    await shutdown(booted);
  });

  it('runs the built-in pack over the fleet and finds what is wrong in it', async () => {
    const reply = await get(booted.owner, '/convention');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const run = ConventionRunSchema.parse(reply.body);
    assert.equal(run.pack.source, 'built-in');
    const seen = new Set(run.findings.map((finding) => `${finding.ruleId}/${finding.code}`));
    for (const expected of [
      'host.vless-route-id/reserved',
      'host.inbound-exists/missing_inbound',
      'host.remark-unique/duplicate',
      'host.sni-explicit/missing',
      'host.sni-in-inbound-names/not_listed',
      'host.serving-node/no_node',
      'node.has-host/no_host',
      'node.version-skew/node_version',
      'profile.snippet-exists/missing',
      'profile.shared/shared',
      'squad.inbound-exists/missing',
      'squad.external-template-exists/missing_template',
      'template.body-present/unreadable',
    ]) {
      assert.ok(seen.has(expected), `no ${expected}; found ${[...seen].join(', ')}`);
    }
    assert.ok(run.summary.error > 0 && run.summary.warning > 0);
    assert.equal(run.summary.total, run.findings.length);
    assert.equal(run.checked.nodes, 5);
    assert.equal(run.checked.hosts, 7);
    assert.deepEqual(run.failed, []);
    assert.deepEqual(run.skipped, []);
    // Every finding names its object, its rule, a message with its key and the fields; none leaves a placeholder open.
    for (const finding of run.findings) {
      assert.doesNotMatch(finding.message, /\{\{/u);
      assert.ok(finding.messageKey.startsWith('findings.'));
    }
    const drift = run.findings.find(
      (finding) =>
        finding.ruleId === 'host.sni-in-inbound-names' && finding.object.name === 'Host 3',
    );
    assert.equal(drift?.object.name, 'Host 3');
    assert.deepEqual(must(drift).fields, ['/sni']);
    assert.equal(must(drift).fix?.op, 'replace');
  });

  it('answers from the memory of this server, and asks the panel again when told to', async () => {
    const before = booted.fake.countRequests('/api/nodes');
    const cached = ConventionRunSchema.parse((await get(booted.owner, '/convention')).body);
    assert.equal(cached.cached, true);
    assert.equal(booted.fake.countRequests('/api/nodes'), before);
    const fresh = ConventionRunSchema.parse(
      (await get(booted.owner, '/convention?refresh=true')).body,
    );
    assert.equal(fresh.cached, false);
    assert.equal(booted.fake.countRequests('/api/nodes'), before + 1);
  });

  it('sends the panel nothing but GET requests, whatever the checks do', async () => {
    await get(booted.owner, '/reconciliation');
    await booted.owner.post('/panel/impact', {
      kind: 'node',
      uuid: must(booted.fake.fixtures.nodes[0])['uuid'],
      change: { isDisabled: true },
    });
    assert.deepEqual([...new Set(booted.fake.requests.map((request) => request.method))], ['GET']);
  });

  it('says what the last run found without running anything, and forgets it when the pack changes', async () => {
    const nodesBefore = booted.fake.countRequests('/api/nodes');
    const last = ConventionLastRunSchema.parse((await get(booted.owner, '/convention/last')).body);
    assert.notEqual(last.ranAt, null);
    assert.ok((last.summary?.total ?? 0) > 0);
    assert.equal(last.pack?.source, 'built-in');
    assert.equal(booted.fake.countRequests('/api/nodes'), nodesBefore);
  });

  it('lists the rules with their parameters and how the pack sets them', async () => {
    const catalog = ConventionRuleCatalogSchema.parse((await get(booted.owner, '/rules')).body);
    assert.ok(catalog.rules.length >= 28);
    const pattern = must(catalog.rules.find((rule) => rule.id === 'host.remark-pattern'));
    assert.equal(pattern.effective.active, false);
    assert.equal(pattern.effective.inactive, 'needs_params');
    assert.ok(
      catalog.reconciliationChecks.some((check) => check.id === 'host.address' && check.enabled),
    );
    assert.ok(
      catalog.rules.every(
        (rule) =>
          rule.title.length > 0 && rule.params.every((param) => param.description.length > 0),
      ),
    );
  });

  it('never returns a secret of the panel, nor writes one to the log of what happened', async () => {
    const texts = [
      JSON.stringify((await get(booted.owner, '/convention')).body),
      JSON.stringify((await get(booted.owner, '/reconciliation')).body),
      JSON.stringify((await get(booted.owner, '/rules')).body),
      JSON.stringify(await auditEvents(booted.instance)),
    ];
    assertClean(texts, forbiddenTexts(booted.tokens), 'a response of the checks');
  });
});

describe('who may do what with the checks', { skip: !databaseUrl }, () => {
  let booted: Booted;
  let observer: Client;
  let operator: Client;
  let operatorSecret: string;
  before(async () => {
    booted = await boot();
    const o = await createUser(booted.instance, 'obs', 'observer');
    observer = await signInAs(booted.instance, 'obs', o.secret);
    const p = await createUser(booted.instance, 'op', 'operator');
    operatorSecret = p.secret;
    operator = await signInAs(booted.instance, 'op', p.secret);
  });
  after(async () => {
    await shutdown(booted);
  });

  it('lets a role that reads the panel read the results, check a pack and calculate an impact', async () => {
    for (const path of [
      '/rules',
      '/convention',
      '/convention/last',
      '/convention-pack',
      '/convention-pack/versions',
      '/reconciliation',
    ]) {
      assert.equal((await get(observer, path)).status, 200, path);
    }
    const validated = await observer.post('/panel/checks/convention-pack/validate', {
      yaml: PACK_YAML,
    });
    assert.equal(validated.status, 200);
    const uuid = String(must(booted.fake.fixtures.hosts[0])['uuid']);
    assert.equal(
      (await observer.post('/panel/impact', { kind: 'host', uuid, change: { remark: 'x' } }))
        .status,
      200,
    );
  });

  it('refuses a stranger, and an API token that lacks the permission', async () => {
    const stranger = booted.instance.client();
    assert.equal((await get(stranger, '/convention')).status, 401);
    assert.equal(
      (await stranger.post('/panel/impact', { kind: 'host', uuid: 'x', change: {} })).status,
      401,
    );
    await forgetLastStep(booted.instance);
    const minted = await booted.owner.post('/tokens', {
      name: 'servers only',
      permissions: ['servers:read'],
    });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const token = CreatedTokenSchema.parse(minted.body).token;
    const bare = booted.instance.client();
    const denied = await bare.call('GET', '/panel/checks/convention', undefined, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(denied.status, 403);
  });

  it('lets an API token with panel:read run the checks, and compares no inventory when it may not read servers', async () => {
    await forgetLastStep(booted.instance);
    const minted = await booted.owner.post('/tokens', {
      name: 'panel reader',
      permissions: ['panel:read'],
    });
    const token = CreatedTokenSchema.parse(minted.body).token;
    const bare = booted.instance.client();
    const headers = { authorization: `Bearer ${token}` };
    assert.equal(
      (await bare.call('GET', '/panel/checks/convention', undefined, headers)).status,
      200,
    );
    const report = ReconciliationReportSchema.parse(
      (await bare.call('GET', '/panel/checks/reconciliation', undefined, headers)).body,
    );
    assert.equal(report.inventory.available, false);
    assert.equal(report.inventory.reason, 'no_permission');
    assert.ok(
      !report.rows.some((row) => row.check === 'node.server' || row.check === 'server.node'),
    );
    // A token cannot change the pack: that route is for a session, with a second factor.
    const put = await bare.call(
      'PUT',
      '/panel/checks/convention-pack',
      { yaml: PACK_YAML },
      headers,
    );
    assert.ok(put.status === 401 || put.status === 403, String(put.status));
  });

  it('keeps changing the pack from a role that cannot write the panel, and asks the one that can for a code', async () => {
    const denied = await observer.call('PUT', '/panel/checks/convention-pack', { yaml: PACK_YAML });
    assert.equal(denied.status, 403);
    assert.equal(errorOf(denied).code, 'forbidden');
    assert.equal((await observer.call('DELETE', '/panel/checks/convention-pack')).status, 403);
    await lapse(booted.instance);
    const early = await operator.call('PUT', '/panel/checks/convention-pack', { yaml: PACK_YAML });
    assert.equal(early.status, 403);
    assert.equal(errorOf(early).code, 'step_up_required');
    assert.equal((await operator.call('DELETE', '/panel/checks/convention-pack')).status, 403);
    // Nothing was saved by the refused calls.
    assert.equal(
      ConventionPackVersionListSchema.parse(
        (await get(booted.owner, '/convention-pack/versions')).body,
      ).versions.length,
      0,
    );
    await forgetLastStep(booted.instance);
    assert.equal(
      (await operator.post('/auth/step-up', { code: codeFor(operatorSecret) })).status,
      200,
    );
    const saved = await operator.call('PUT', '/panel/checks/convention-pack', { yaml: PACK_YAML });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  });
});

describe('the convention pack over the API', { skip: !databaseUrl }, () => {
  let booted: Booted;
  before(async () => {
    booted = await boot();
  });
  after(async () => {
    await shutdown(booted);
  });

  const put = (body: Record<string, unknown>) =>
    booted.owner.call('PUT', '/panel/checks/convention-pack', body);
  const validate = async (body: Record<string, unknown>) =>
    ConventionPackValidationSchema.parse(
      (await booted.owner.post('/panel/checks/convention-pack/validate', body)).body,
    );

  it('shows the built-in pack, as a document and as YAML to start an own one from', async () => {
    const view = ConventionPackViewSchema.parse((await get(booted.owner, '/convention-pack')).body);
    assert.equal(view.pack.source, 'built-in');
    assert.equal(view.pack.version, null);
    assert.equal(view.active, true);
    assert.match(view.yaml, /^# ?|rules:/mu);
    assert.ok(Object.keys(view.document.rules ?? {}).length >= 28);
    assert.equal(
      (await validate({ yaml: view.yaml })).valid,
      true,
      'the built-in pack passes its own validation',
    );
  });

  it('validates without saving: the line of a syntax error, the path of a wrong value, an unknown rule as a warning', async () => {
    const syntax = await validate({ yaml: 'format: x\nname: [unclosed\n' });
    assert.equal(syntax.valid, false);
    assert.ok((at(syntax.issues, 0).line ?? 0) >= 1);
    const wrong = await validate({
      document: {
        format: 'swellwright.conventions/v1',
        name: 'p',
        rules: { 'host.state': { severity: 'fatal' } },
      },
    });
    assert.equal(wrong.valid, false);
    assert.ok(
      wrong.issues.some((issue) => issue.severity === 'error' && issue.path.includes('host.state')),
    );
    const unknown = await validate({
      document: { format: 'swellwright.conventions/v1', name: 'p', rules: { 'host.nothing': {} } },
    });
    assert.equal(unknown.valid, true, 'an unknown rule is a warning, not an error');
    assert.ok(
      unknown.issues.some(
        (issue) => issue.severity === 'warning' && issue.path.includes('host.nothing'),
      ),
    );
    const unsafe = await validate({
      yaml: 'format: swellwright.conventions/v1\nname: p\nrules:\n  host.remark-pattern:\n    params:\n      pattern: "(?=x)x"\n',
    });
    assert.equal(unsafe.valid, false);
    assert.match(at(unsafe.issues, 0).path, /params\.pattern/u);
    assert.equal((await get(booted.owner, '/convention-pack/versions')).status, 200);
    assert.equal(
      ConventionPackVersionListSchema.parse(
        (await get(booted.owner, '/convention-pack/versions')).body,
      ).versions.length,
      0,
      'validating saves nothing',
    );
  });

  it('refuses a pack that is not valid, with the issues, and a body that is not a pack at all', async () => {
    const reply = await put({
      yaml: 'format: swellwright.conventions/v1\nname: p\nrules:\n  host.state:\n    severity: fatal\n',
    });
    assert.equal(reply.status, 400);
    assert.equal(errorOf(reply).code, 'validation_failed');
    const details = errorOf(reply).details as { issues: { path: string }[] };
    assert.ok(details.issues.some((issue) => issue.path.includes('host.state')));
    assert.equal((await put({})).status, 400);
    assert.equal((await put({ yaml: 'a', document: {} })).status, 400);
    assert.equal(
      (await put({ yaml: 'x'.repeat(300_000) })).status,
      400,
      'a pack above the size limit',
    );
  });

  it('refuses hostile packs: a regex that needs back-references, nesting without end, aliases', async () => {
    for (const yaml of [
      'format: swellwright.conventions/v1\nname: p\nrules:\n  host.remark-pattern:\n    params:\n      pattern: "(a)\\\\1"\n',
      `format: swellwright.conventions/v1\nname: p\nrules:\n  host.state:\n    params:\n      report: ${'['.repeat(60)}${']'.repeat(60)}\n`,
      'format: swellwright.conventions/v1\nname: &a p\ndescription: *a\n',
    ]) {
      const reply = await put({ yaml });
      assert.equal(reply.status, 400, yaml.slice(0, 80));
    }
    assert.equal(
      ConventionPackVersionListSchema.parse(
        (await get(booted.owner, '/convention-pack/versions')).body,
      ).versions.length,
      0,
    );
  });

  it('saves a pack as version 1, runs with it, and keeps what the user wrote', async () => {
    const reply = await put({ yaml: PACK_YAML, comment: 'first' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const view = ConventionPackViewSchema.parse(reply.body);
    assert.equal(view.pack.version, 1);
    assert.equal(view.pack.source, 'custom');
    assert.equal(view.createdBy, 'owner');
    assert.equal(view.comment, 'first');
    assert.equal(view.yaml, PACK_YAML);
    const run = ConventionRunSchema.parse((await get(booted.owner, '/convention')).body);
    assert.equal(run.pack.version, 1);
    assert.equal(run.pack.name, 'Test conventions');
    assert.ok(
      !run.findings.some((finding) => finding.ruleId === 'host.state'),
      'a rule the pack switched off does not run',
    );
    assert.ok(
      run.findings.some(
        (finding) => finding.ruleId === 'host.remark-pattern' && finding.object.name === 'Host 6',
      ),
      'the pattern of the pack is applied',
    );
    const last = ConventionLastRunSchema.parse((await get(booted.owner, '/convention/last')).body);
    assert.equal(last.pack?.version, 1);
    const catalog = ConventionRuleCatalogSchema.parse((await get(booted.owner, '/rules')).body);
    assert.equal(
      must(catalog.rules.find((rule) => rule.id === 'host.remark-pattern')).effective.active,
      true,
    );
    assert.equal(
      must(catalog.rules.find((rule) => rule.id === 'host.state')).effective.inactive,
      'disabled',
    );
  });

  it('does not make a new version of what is saved again unchanged, and does of every change, even a comment', async () => {
    const before = (await auditEvents(booted.instance)).filter(
      (event) => event.action === 'panel.convention_pack.saved',
    ).length;
    const same = ConventionPackViewSchema.parse((await put({ yaml: PACK_YAML })).body);
    assert.equal(same.pack.version, 1);
    assert.equal(
      (await auditEvents(booted.instance)).filter(
        (event) => event.action === 'panel.convention_pack.saved',
      ).length,
      before,
    );
    const second = ConventionPackViewSchema.parse(
      (await put({ yaml: `# a note\n${PACK_YAML}`, comment: 'second' })).body,
    );
    assert.equal(second.pack.version, 2);
    assert.equal(
      second.pack.hash,
      same.pack.hash,
      'the document is the same, only the text differs',
    );
    const versions = ConventionPackVersionListSchema.parse(
      (await get(booted.owner, '/convention-pack/versions')).body,
    ).versions;
    assert.deepEqual(
      versions.map((v) => [v.version, v.active]),
      [
        [2, true],
        [1, false],
      ],
    );
    assert.equal(at(versions, 0).comment, 'second');
    assert.equal(at(versions, 0).createdBy, 'owner');
  });

  it('refuses a save from an editor that started from an older version, and one that thought there was none', async () => {
    const stale = await put({
      yaml: PACK_YAML.replace('Test conventions', 'Stale'),
      expectedVersion: 1,
    });
    assert.equal(stale.status, 409);
    assert.equal(errorOf(stale).code, 'conflict');
    assert.deepEqual(errorOf(stale).details, { activeVersion: 2 });
    assert.equal(
      (await put({ yaml: PACK_YAML.replace('Test conventions', 'Stale'), expectedVersion: null }))
        .status,
      409,
    );
    const fine = await put({
      yaml: PACK_YAML.replace('Test conventions', 'Third'),
      expectedVersion: 2,
    });
    assert.equal(fine.status, 200);
    assert.equal(ConventionPackViewSchema.parse(fine.body).pack.version, 3);
  });

  it('shows an old version from the history, and a version that does not exist is 404', async () => {
    const first = ConventionPackViewSchema.parse(
      (await get(booted.owner, '/convention-pack?version=1')).body,
    );
    assert.equal(first.pack.version, 1);
    assert.equal(first.active, false);
    assert.equal((await get(booted.owner, '/convention-pack?version=99')).status, 404);
    assert.equal((await get(booted.owner, '/convention-pack?version=0')).status, 400);
  });

  it('goes back to the built-in pack, keeps the history, and says so when none is active', async () => {
    assert.equal((await booted.owner.call('DELETE', '/panel/checks/convention-pack')).status, 204);
    assert.equal(
      ConventionPackViewSchema.parse((await get(booted.owner, '/convention-pack')).body).pack
        .source,
      'built-in',
    );
    assert.equal(
      ConventionRunSchema.parse((await get(booted.owner, '/convention')).body).pack.source,
      'built-in',
    );
    assert.equal(
      ConventionPackVersionListSchema.parse(
        (await get(booted.owner, '/convention-pack/versions')).body,
      ).versions.length,
      3,
    );
    assert.equal((await booted.owner.call('DELETE', '/panel/checks/convention-pack')).status, 404);
    // Saving again continues the numbering.
    assert.equal(
      ConventionPackViewSchema.parse((await put({ yaml: PACK_YAML })).body).pack.version,
      4,
    );
  });

  it('records every change in the audit chain, in the same transaction, without the document or the text', async () => {
    const events = (await auditEvents(booted.instance)).filter((event) =>
      event.action.startsWith('panel.convention_pack.'),
    );
    assert.deepEqual(
      events.map((event) => event.action),
      [
        'panel.convention_pack.saved',
        'panel.convention_pack.saved',
        'panel.convention_pack.saved',
        'panel.convention_pack.reset',
        'panel.convention_pack.saved',
      ],
    );
    assert.equal(at(events, 0).actor?.name, 'owner');
    assert.equal(at(events, 0).details['version'], 1);
    assert.equal(at(events, 0).details['previous_version'], null);
    assert.equal(at(events, 1).details['previous_version'], 1);
    assert.equal(at(events, 3).details['version'], 3);
    assert.match(String(at(events, 0).details['hash']), /^[0-9a-f]{64}$/u);
    assert.equal(at(events, 0).details['rules'], 2);
    const text = JSON.stringify(events);
    assert.ok(!text.includes('Host [1-4]'), 'the pattern is not in the audit log');
    assert.ok(!text.includes('first'), 'neither is the comment');
  });

  it('keeps the pack through a reconnect of the panel (a new connection row), and loses nothing when the token is rotated', async () => {
    const id = await makeSecret(booted.owner, 'rotated token', 'panel_token', booted.fake.token);
    assert.equal((await connect(booted.owner, booted.fake.url, id)).status, 200);
    assert.equal(
      ConventionPackViewSchema.parse((await get(booted.owner, '/convention-pack')).body).pack
        .version,
      4,
    );
    assert.equal(
      ConventionRunSchema.parse((await get(booted.owner, '/convention')).body).pack.version,
      4,
    );
  });

  it('runs the built-in pack, and says so, when the saved one is no longer acceptable to this release', async () => {
    await booted.instance.isolated.database.client.conventionPack.updateMany({
      where: { active: true },
      data: {
        document: {
          format: 'swellwright.conventions/v1',
          name: 'x',
          rules: { 'host.state': { severity: 'fatal' } },
        },
      },
    });
    assert.equal(
      ConventionRunSchema.parse((await get(booted.owner, '/convention')).body).pack.source,
      'built-in',
    );
    const view = await get(booted.owner, '/convention-pack');
    assert.equal(view.status, 409);
    assert.equal(errorOf(view).code, 'conflict');
    // The editor can still save a corrected one.
    assert.equal(
      (await put({ yaml: PACK_YAML.replace('Test conventions', 'Mended') })).status,
      200,
    );
  });
});

describe('reconciliation over the API', { skip: !databaseUrl }, () => {
  let booted: Booted;
  before(async () => {
    booted = await boot({}, [CHECKS_ZONE, { 'node-3.example.com': 'timeout' }]);
  });
  after(async () => {
    await shutdown(booted);
  });

  const report = async (query = '') =>
    ReconciliationReportSchema.parse((await get(booted.owner, `/reconciliation${query}`)).body);

  it('finds the address that drifted from the node that serves the host', async () => {
    const result = await report();
    const drift = result.rows.filter(
      (row) => row.check === 'host.address' && row.status === 'drift',
    );
    assert.deepEqual(drift.map((row) => row.subject.name).sort(), ['Host 2', 'Host 4']);
    const host2 = must(drift.find((row) => row.subject.name === 'Host 2'));
    assert.equal(host2.actual, '192.0.2.99');
    assert.equal(host2.expected, 'node-2.example.com');
    assert.equal(host2.fix?.path, '/address');
    assert.equal(host2.fix.to, 'node-2.example.com');
    const ok = result.rows.find(
      (row) => row.check === 'host.address' && row.subject.name === 'Host 1',
    );
    assert.equal(ok?.status, 'ok');
  });

  it('says a name that did not answer in time is unknown, and does not fail the report', async () => {
    const result = await report();
    const node3 = result.rows.filter(
      (row) => row.check === 'node.dns' && row.subject.name === 'Node 3',
    );
    assert.equal(at(node3, 0).status, 'unknown');
    assert.equal(at(node3, 0).reasonKey, 'reconciliation.reasons.dns_timeout');
    assert.equal(result.dns.failed >= 1, true);
    const node1 = result.rows.find(
      (row) => row.check === 'node.dns' && row.subject.name === 'Node 1',
    );
    assert.equal(node1?.status, 'ok');
    assert.equal(must(node1).ttlSeconds, 300);
  });

  it('reports a disabled node whose name still resolves', async () => {
    const result = await report();
    assert.ok(
      result.rows.some(
        (row) =>
          row.check === 'node.disabled-resolving' &&
          row.subject.name === 'Node 5' &&
          row.status === 'drift',
      ),
    );
  });

  it('compares the nodes with the inventory: unmanaged nodes, servers the panel does not know, and a match by what a name resolves to', async () => {
    for (const body of [
      { name: 'srv-two', address: 'server-2.example.org' },
      { name: 'srv-lost', address: '203.0.113.9' },
      { name: 'srv-retired', address: '203.0.113.10', state: 'retired' },
      { name: 'srv-one', address: 'node-1.example.com' },
    ]) {
      assert.equal((await booted.owner.post('/servers', body)).status, 201);
    }
    const result = await report('?refresh=true');
    assert.equal(result.inventory.available, true);
    assert.equal(result.inventory.servers, 4);
    const matched = result.rows.filter((row) => row.check === 'node.server' && row.status === 'ok');
    assert.deepEqual(matched.map((row) => [row.subject.name, row.counterpart?.name]).sort(), [
      ['Node 1', 'srv-one'],
      ['Node 2', 'srv-two'],
    ]);
    assert.ok(matched.some((row) => row.reasonKey.endsWith('matched_by_dns')));
    const unmanaged = result.rows
      .filter((row) => row.check === 'node.server' && row.status === 'missing')
      .map((row) => row.subject.name);
    assert.ok(unmanaged.includes('Node 4'));
    const extra = result.rows
      .filter((row) => row.check === 'server.node')
      .map((row) => row.subject.name);
    assert.deepEqual(extra, ['srv-lost'], 'a retired server is not reported');
  });

  it('keeps the answers of DNS for a short time, and looks again when the panel is asked again', async () => {
    await report('?refresh=true');
    const askedAbout = (name: string): number =>
      booted.dns.asked.filter((entry) => entry.startsWith(`${name}/`)).length;
    const asked = askedAbout('node-1.example.com');
    await report();
    assert.equal(askedAbout('node-1.example.com'), asked, 'an answer that was certain is kept');
    assert.ok(
      askedAbout('node-3.example.com') > 0,
      'a name that timed out is not kept: it is asked again',
    );
    await report('?refresh=true');
    assert.ok(askedAbout('node-1.example.com') > asked, 'refresh looks the names up again');
  });

  it('writes nothing, to the panel or to the audit log', async () => {
    const before = (await auditEvents(booted.instance)).length;
    await report();
    assert.equal((await auditEvents(booted.instance)).length, before);
    assert.deepEqual([...new Set(booted.fake.requests.map((r) => r.method))], ['GET']);
  });

  it('is rate limited per user', async () => {
    const limited = await boot({ SW_CHECKS_RATE_LIMIT_PER_MINUTE: '2' });
    try {
      assert.equal((await get(limited.owner, '/reconciliation')).status, 200);
      assert.equal((await get(limited.owner, '/reconciliation')).status, 200);
      const refused = await get(limited.owner, '/reconciliation');
      assert.equal(refused.status, 429);
      assert.equal(errorOf(refused).code, 'rate_limited');
      assert.ok(refused.headers.get('retry-after'));
    } finally {
      await shutdown(limited);
    }
  });

  it('looks up no more names than the cap and says which rows are undecided because of it', async () => {
    const capped = await boot({ SW_CHECKS_DNS_MAX_NAMES: '2' });
    try {
      const result = ReconciliationReportSchema.parse(
        (await get(capped.owner, '/reconciliation')).body,
      );
      assert.equal(result.dns.capped, true);
      assert.ok(result.dns.skipped > 0);
      assert.equal(result.dns.resolved <= 2, true);
      assert.ok(result.rows.some((row) => row.reasonKey.endsWith('dns_skipped_cap')));
    } finally {
      await shutdown(capped);
    }
  });

  it('follows the settings of the pack: another address expectation, and lookups switched off', async () => {
    const yaml =
      'format: swellwright.conventions/v1\nname: strict\nreconciliation:\n  hostAddress: node-address\n  hostSni: node-address\n  hostPort: inbound\n  dns:\n    enabled: false\n';
    assert.equal(
      (await booted.owner.call('PUT', '/panel/checks/convention-pack', { yaml })).status,
      200,
    );
    const result = await report('?refresh=true');
    assert.equal(result.settings.hostAddress, 'node-address');
    assert.equal(result.dns.enabled, false);
    assert.equal(result.dns.names, 0);
    assert.ok(result.rows.some((row) => row.check === 'host.sni'));
    assert.ok(result.rows.some((row) => row.check === 'host.port'));
    assert.ok(
      result.rows
        .filter((row) => row.check === 'node.dns')
        .every((row) => row.reasonKey.endsWith('dns_disabled')),
    );
  });
});

describe('the impact calculator over the API', { skip: !databaseUrl }, () => {
  let booted: Booted;
  let profileOne: string;
  before(async () => {
    booted = await boot();
    profileOne = String(must(booted.fake.fixtures.configProfiles[0])['uuid']);
  });
  after(async () => {
    await shutdown(booted);
  });

  const impact = async (body: Record<string, unknown>): Promise<ImpactReport> => {
    const reply = await booted.owner.post('/panel/impact', body);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return ImpactReportSchema.parse(reply.body);
  };

  /** The configuration as the console shows it (masked), with one inbound changed. */
  async function editedConfig(): Promise<Record<string, unknown>> {
    const answer = (await booted.owner.get(`/panel/config-profiles/${profileOne}`)).body as {
      configProfile: { config: { inbounds: Record<string, unknown>[] } };
    };
    const config = structuredClone(answer.configProfile.config);
    at(config.inbounds, 0)['sniffing'] = {
      enabled: true,
      routeOnly: true,
    };
    return config;
  }

  it('shows that editing one inbound of a shared profile restarts every node of the profile', async () => {
    const report = await impact({
      kind: 'configProfile',
      uuid: profileOne,
      change: { config: await editedConfig() },
    });
    assert.deepEqual(
      report.restarts.map((r) => r.node.name),
      ['Node 1', 'Node 2', 'Node 3', 'Node 4'],
    );
    assert.ok(
      report.restarts.every((r) => r.rule === 'profile.config-edit' && r.action === 'restart'),
    );
    assert.equal(report.risk.level, 'high');
    assert.equal(report.saferWay?.code, 'clone_profile');
    assert.deepEqual(report.inbounds?.changed, ['VLESS_REALITY_MAIN']);
    assert.equal(at(report.rules, 0).basis, 'observed');
    assert.ok(report.users.onlineOnRestartedNodes !== null);
  });

  it('takes the change as a JSON Patch as well, with the same answer', async () => {
    const asObject = await impact({
      kind: 'configProfile',
      uuid: profileOne,
      change: { config: await editedConfig() },
    });
    const asPatch = await impact({
      kind: 'configProfile',
      uuid: profileOne,
      change: [
        {
          op: 'add',
          path: '/config/inbounds/0/sniffing',
          value: { enabled: true, routeOnly: true },
        },
      ],
    });
    assert.deepEqual(asPatch.restarts, asObject.restarts);
    assert.deepEqual(asPatch.risk, asObject.risk);
  });

  it('calculates every kind of object the panel edits', async () => {
    const f = booted.fake.fixtures;
    const node = must(f.nodes[0]);
    const host = must(f.hosts[0]);
    const squad = must(f.internalSquads[0]);
    const template = must(f.templates[0]);
    const disabled = await impact({
      kind: 'node',
      uuid: node['uuid'],
      change: { isDisabled: true },
    });
    assert.deepEqual(
      disabled.restarts.map((r) => [r.action, r.rule]),
      [['stop', 'node.disable']],
    );
    const edited = await impact({ kind: 'host', uuid: host['uuid'], change: { address: '' } });
    assert.ok(
      edited.findings.introduced.some((finding) => finding.ruleId === 'host.address-policy'),
    );
    assert.equal(edited.risk.level, 'high');
    const squadReport = await impact({
      kind: 'internalSquad',
      uuid: squad['uuid'],
      change: { name: 'Renamed' },
    });
    assert.deepEqual(
      squadReport.rules.map((r) => r.id),
      ['squad.metadata-only'],
    );
    const body = await impact({
      kind: 'subscriptionTemplate',
      uuid: template['uuid'],
      change: { name: 'Renamed' },
    });
    assert.deepEqual(body.restarts, []);
  });

  it('answers 404 for an object the panel does not have, and 400 for a change that cannot be applied', async () => {
    const missing = await booted.owner.post('/panel/impact', {
      kind: 'host',
      uuid: '00000000-0000-4000-8000-0000000fffff',
      change: { remark: 'x' },
    });
    assert.equal(missing.status, 404);
    const patch = await booted.owner.post('/panel/impact', {
      kind: 'configProfile',
      uuid: profileOne,
      change: [{ op: 'remove', path: '/nothing' }],
    });
    assert.equal(patch.status, 400);
    assert.equal(errorOf(patch).code, 'validation_failed');
    assert.match(errorOf(patch).message, /patch cannot be applied/u);
    for (const bad of [
      { kind: 'user', uuid: profileOne, change: {} },
      { kind: 'host', uuid: 'not-a-uuid', change: {} },
      { kind: 'host', uuid: profileOne },
      { kind: 'host', uuid: profileOne, change: [] },
      { kind: 'host', uuid: profileOne, change: 'x' },
    ]) {
      assert.equal(
        (await booted.owner.post('/panel/impact', bad)).status,
        400,
        JSON.stringify(bad),
      );
    }
  });

  it('never repeats a value of the proposal, never returns a secret of the panel, and is not recorded in the audit log', async () => {
    const before = (await auditEvents(booted.instance)).length;
    const literal = 'PROPOSED-LITERAL-SECRET-5521';
    const config = await editedConfig();
    (
      at(config['inbounds'] as Record<string, unknown>[], 0)['streamSettings'] as {
        realitySettings: Record<string, unknown>;
      }
    ).realitySettings['privateKey'] = literal;
    const reply = await booted.owner.post('/panel/impact', {
      kind: 'configProfile',
      uuid: profileOne,
      change: { config },
    });
    assert.equal(reply.status, 200);
    const text = JSON.stringify(reply.body);
    assert.ok(!text.includes(literal));
    assert.match(text, /secret_changed/u);
    assertClean(
      [text, JSON.stringify(await auditEvents(booted.instance))],
      [...forbiddenTexts(booted.tokens), literal],
      'the impact answer',
    );
    assert.equal((await auditEvents(booted.instance)).length, before);
  });

  it('gives the form an editor starts from, masked, and takes it back as the empty change', async () => {
    const f = booted.fake.fixtures;
    const asked = [
      ['configProfile', profileOne],
      ['internalSquad', String(must(f.internalSquads[0])['uuid'])],
      ['host', String(must(f.hosts[0])['uuid'])],
      ['node', String(must(f.nodes[0])['uuid'])],
    ] as const;
    for (const [kind, uuid] of asked) {
      const reply = await booted.owner.get(`/panel/impact/target?kind=${kind}&uuid=${uuid}`);
      assert.equal(reply.status, 200, `${kind}: ${JSON.stringify(reply.body)}`);
      const form = ImpactTargetSchema.parse(reply.body);
      assert.equal(form.target.uuid, uuid);
      assert.equal(form.target.kind, kind);
      assertClean([JSON.stringify(reply.body)], forbiddenTexts(booted.tokens), `the form of a ${kind}`);
      const back = await impact({ kind, uuid, change: form.editable });
      assert.equal(back.changed, false, kind);
      assert.deepEqual(back.restarts, [], kind);
    }
    // A profile carries the keys of its inbounds: they are masked, and the form says so.
    const profile = ImpactTargetSchema.parse(
      (await booted.owner.get(`/panel/impact/target?kind=configProfile&uuid=${profileOne}`)).body,
    );
    assert.equal(profile.masked, true);
  });

  it('answers 404 for a form of an object the panel does not have, and 400 for a question that is not one', async () => {
    const missing = await booted.owner.get(
      '/panel/impact/target?kind=host&uuid=00000000-0000-4000-8000-0000000fffff',
    );
    assert.equal(missing.status, 404);
    for (const query of [
      'kind=user&uuid=00000000-0000-4000-8000-0000000fffff',
      'kind=host&uuid=not-a-uuid',
      'kind=host',
      '',
    ]) {
      assert.equal(
        (await booted.owner.get(`/panel/impact/target?${query}`)).status,
        400,
        query,
      );
    }
  });

  it('does not answer for a kind the token cannot read, and says which', async () => {
    const limited = await boot({ SW_PANEL_CACHE_TTL_SECONDS: '0' });
    try {
      limited.fake.forbid('/api/config-profiles');
      await limited.owner.get('/panel/checks/convention?refresh=true');
      const reply = await limited.owner.post('/panel/impact', {
        kind: 'configProfile',
        uuid: profileOne,
        change: { name: 'x' },
      });
      assert.equal(reply.status, 502);
      assert.equal(errorOf(reply).code, 'panel_forbidden');
      // The linter runs without it and lists the rules it had to skip.
      const run = ConventionRunSchema.parse(
        (await limited.owner.get('/panel/checks/convention?refresh=true')).body,
      );
      assert.ok(
        run.skipped.some(
          (entry) =>
            entry.ruleId === 'profile.snippet-exists' && entry.missing.includes('configProfiles'),
        ),
      );
      assert.ok(run.findings.length > 0);
    } finally {
      await shutdown(limited);
    }
  });
});

describe('the checks without a panel', { skip: !databaseUrl }, () => {
  let booted: Booted;
  before(async () => {
    booted = await boot({}, [], false);
  });
  after(async () => {
    await shutdown(booted);
  });

  it('say that nothing is connected, but still show the rules and the pack', async () => {
    for (const path of ['/convention', '/reconciliation']) {
      const reply = await get(booted.owner, path);
      assert.equal(reply.status, 409, path);
      assert.equal(errorOf(reply).code, 'panel_not_connected');
    }
    const impact = await booted.owner.post('/panel/impact', {
      kind: 'host',
      uuid: '00000000-0000-4000-8000-0000000fffff',
      change: {},
    });
    assert.equal(impact.status, 409);
    assert.equal(
      ConventionLastRunSchema.parse((await get(booted.owner, '/convention/last')).body).ranAt,
      null,
    );
    assert.equal((await get(booted.owner, '/rules')).status, 200);
    assert.equal((await get(booted.owner, '/convention-pack')).status, 200);
  });
});
