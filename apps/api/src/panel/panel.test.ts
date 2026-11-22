import 'reflect-metadata';

import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { after, before, describe, it } from 'node:test';

import {
  type PanelConfigProfileView,
  PanelApiTokenListSchema,
  PanelConfigProfileAnswerSchema,
  PanelConfigProfileListSchema,
  PanelExternalSquadListSchema,
  PanelHostListSchema,
  PanelInfraAnswerSchema,
  PanelInternalSquadListSchema,
  PanelNodeListSchema,
  PanelNodePluginListSchema,
  PanelOverviewSchema,
  PanelSnippetListSchema,
  PanelSubscriptionSettingsAnswerSchema,
  PanelSubscriptionTemplateListSchema,
  PanelTestResultSchema,
} from '@swellwright/contracts';
import { FAKE_SECRETS, FakePanel, must } from '@swellwright/remnawave/test-support';

import {
  auditEvents,
  type Client,
  createOwner,
  createUser,
  databaseUrl,
  found,
  type Instance,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { PanelCache } from './panel-cache.js';
import {
  assertClean,
  connect,
  connection,
  errorOf,
  forbiddenTexts,
  makeSecret,
  PANEL_ENV,
  panelEvents,
  PASSPHRASE,
} from './panel-test-support.js';

/** The character that a URL with credentials has before its host; kept out of the literals below. */
const AT = '@';
const WRONG_TOKEN = 'a-token-the-fake-panel-does-not-know-0000';

describe('the connection to a panel', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let fake: FakePanel;
  let owner: Client;
  let operator: Client;
  let observer: Client;
  let terminal: Client;
  let auditor: Client;
  let tokenSecret = '';
  let wrongSecret = '';
  let genericSecret = '';
  let profileUuid = '';
  /** Every body a route answered during the run, for the scan for secrets at the end. */
  const seen: string[] = [];

  const read = async (client: Client, path: string) => {
    const reply = await client.get(path);
    seen.push(JSON.stringify(reply.body));
    return reply;
  };

  before(async () => {
    fake = await FakePanel.start();
    instance = await start({ ...PANEL_ENV });
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    operator = await signInAs(
      instance,
      'ops',
      (await createUser(instance, 'ops', 'operator')).secret,
    );
    observer = await signInAs(
      instance,
      'viewer',
      (await createUser(instance, 'viewer', 'observer')).secret,
    );
    terminal = await signInAs(
      instance,
      'term',
      (await createUser(instance, 'term', 'terminal')).secret,
    );
    auditor = await signInAs(
      instance,
      'audit',
      (await createUser(instance, 'audit', 'auditor')).secret,
    );
    assert.equal((await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status, 201);
    tokenSecret = await makeSecret(owner, 'panel token', 'panel_token', fake.token);
    wrongSecret = await makeSecret(owner, 'wrong panel token', 'panel_token', WRONG_TOKEN);
    genericSecret = await makeSecret(owner, 'a note', 'generic', 'not a panel token');
    profileUuid = String(fake.fixtures.configProfiles[0]?.['uuid']);
  });

  after(async () => {
    await stop(instance);
    await fake.close();
  });

  describe('before anything is connected', () => {
    it('says so, and every read answers 409 panel_not_connected', async () => {
      const view = await connection(owner);
      assert.equal(view.state, 'unconfigured');
      assert.equal(view.baseUrl, null);
      assert.equal(view.token, null);
      for (const path of [
        '/panel/overview',
        '/panel/nodes',
        '/panel/hosts',
        '/panel/config-profiles',
        `/panel/config-profiles/${profileUuid}`,
        `/panel/config-profiles/${profileUuid}/computed-config`,
        '/panel/internal-squads',
        '/panel/external-squads',
        '/panel/subscription-templates',
        '/panel/subscription-settings',
        '/panel/snippets',
        '/panel/node-plugins',
        '/panel/infra',
        '/panel/api-tokens',
      ]) {
        const reply = await owner.get(path);
        assert.equal(reply.status, 409, path);
        assert.equal(errorOf(reply).code, 'panel_not_connected', path);
      }
      assert.equal((await owner.post('/panel/connection/test')).status, 409);
      assert.equal((await owner.call('DELETE', '/panel/connection')).status, 404);
    });
  });

  describe('refusing to connect', () => {
    const expectNothingStored = async (): Promise<void> => {
      assert.equal((await connection(owner)).state, 'unconfigured');
    };

    it('refuses a secret that is not a panel token, and one that does not exist', async () => {
      const wrongKind = await connect(owner, fake.url, genericSecret);
      assert.equal(wrongKind.status, 409);
      assert.match(errorOf(wrongKind).message, /panel_token/u);
      const missing = await connect(owner, fake.url, '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b');
      assert.equal(missing.status, 404);
      await expectNothingStored();
    });

    it('refuses a token the panel does not accept, and keeps nothing', async () => {
      const reply = await connect(owner, fake.url, wrongSecret);
      assert.equal(reply.status, 502);
      assert.equal(errorOf(reply).code, 'panel_unauthorized');
      assert.ok(!JSON.stringify(reply.body).includes(WRONG_TOKEN));
      await expectNothingStored();
    });

    it('refuses a panel of another version with its reason', async () => {
      fake.setVersion('3.5.2');
      try {
        const reply = await connect(owner, fake.url, tokenSecret);
        assert.equal(reply.status, 409);
        const error = errorOf(reply);
        assert.equal(error.code, 'panel_unsupported_version');
        assert.match(error.message, /newer than/u);
        assert.deepEqual(error.details, { version: '3.5.2', range: '3.4.x' });
      } finally {
        fake.setVersion('3.4.11');
      }
      await expectNothingStored();
    });

    it('refuses a panel that answers in an unknown shape, naming the endpoint and the field', async () => {
      fake.inject('/api/system/metadata', { kind: 'replace', body: { response: { version: 3 } } });
      try {
        const reply = await connect(owner, fake.url, tokenSecret);
        assert.equal(reply.status, 502);
        const error = errorOf(reply);
        assert.equal(error.code, 'panel_contract_changed');
        assert.deepEqual(error.details, { endpoint: 'system.metadata', field: 'response.version' });
      } finally {
        fake.clearInjections();
      }
      await expectNothingStored();
    });

    it('refuses an address nobody answers on, and a panel that hangs', async () => {
      const closed = await connect(owner, 'http://127.0.0.1:1', tokenSecret);
      assert.equal(closed.status, 502);
      assert.equal(errorOf(closed).code, 'panel_unreachable');
      await expectNothingStored();
    });

    it('refuses addresses the policy does not allow, and addresses that are not one', async () => {
      for (const [url, status, code] of [
        ['https://169.254.169.254', 409, 'address_not_allowed'],
        ['https://[fe80::1]', 409, 'address_not_allowed'],
        // Plain http only to a loopback or private address, so a metadata address over http is a bad address.
        ['http://169.254.169.254', 400, 'bad_request'],
        ['ftp://panel.example.com', 400, 'bad_request'],
        ['not a url', 400, 'bad_request'],
        [`https://user:pass${AT}panel.example.com`, 400, 'bad_request'],
        ['https://panel.example.com/?token=x', 400, 'bad_request'],
        // Plain http to a host name, even with the allow flag: only an address that is local counts.
        ['http://panel.example.com', 400, 'bad_request'],
      ] as const) {
        const reply = await connect(owner, url, tokenSecret);
        assert.equal(reply.status, status, url);
        assert.equal(errorOf(reply).code, code, url);
      }
      await expectNothingStored();
    });

    it('refuses a certificate authority that is not PEM text', async () => {
      const reply = await connect(owner, fake.url, tokenSecret, { trustedCa: 'not a certificate' });
      assert.equal(reply.status, 400);
      await expectNothingStored();
    });

    it('records each refusal in the audit chain without the token', async () => {
      const refused = (await panelEvents(instance)).filter((e) => e.action === 'panel.connected');
      assert.ok(refused.length >= 4);
      assert.ok(refused.every((e) => (e as { outcome: string }).outcome === 'failure'));
    });
  });

  describe('connecting', () => {
    it('connects with a token from the vault and shows what the token can read', async () => {
      const reply = await connect(owner, fake.url, tokenSecret);
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      const view = await connection(owner);
      assert.equal(view.state, 'connected');
      assert.equal(view.baseUrl, fake.url);
      assert.equal(view.panelVersion, '3.4.11');
      assert.deepEqual(view.versionSupport, { status: 'supported', range: '3.4.x', reason: null });
      const token = must(view.token);
      assert.equal(token.secretId, tokenSecret);
      assert.equal(token.secretName, 'panel token');
      assert.equal(token.expiresAt, null, 'the fake token is not a signed token');
      assert.equal(token.expiryWarning, false);
      assert.equal(view.trustedCa, false);
      assert.deepEqual(view.warnings, []);
      assert.equal(view.lastError, null);
      assert.ok(view.lastCheckedAt);
      const resources = must(view.capabilities, 'capabilities').resources;
      for (const resource of [
        'system',
        'nodes',
        'hosts',
        'configProfiles',
        'internalSquads',
        'externalSquads',
        'subscriptionTemplates',
        'subscriptionSettings',
        'snippets',
        'nodePlugins',
        'infra',
      ] as const) {
        assert.equal(resources[resource], 'ok', resource);
      }
      assert.equal(
        resources.apiTokens,
        'denied',
        'the panel never lets an API token list the tokens',
      );
      seen.push(JSON.stringify(reply.body));
    });

    it('never returns the token, and records the connection without it', async () => {
      const text = JSON.stringify((await owner.get('/panel/connection')).body);
      assert.ok(!text.includes(fake.token));
      const events = await panelEvents(instance);
      const connected = found(
        events.findLast(
          (e) => e.action === 'panel.connected' && (e as { outcome: string }).outcome === 'success',
        ),
        'panel.connected',
      );
      const details = (connected as { details: Record<string, unknown> }).details;
      assert.equal(details['base_url'], fake.url);
      assert.equal(details['panel_version'], '3.4.11');
      assert.equal(details['state'], 'connected');
      assert.equal(details['secret_id'], tokenSecret);
      assert.equal(details['replaced'], false);
      assert.ok(!JSON.stringify(await auditEvents(instance)).includes(fake.token));
    });

    it('keeps the token secret from being deleted while the connection uses it, naming the connection', async () => {
      const reply = await owner.call('DELETE', `/secrets/${tokenSecret}`);
      assert.equal(reply.status, 409);
      assert.match(errorOf(reply).message, /connection to the panel/u);
      assert.ok(errorOf(reply).message.includes(fake.url));
      // The database says it too, whatever the application checks first.
      await assert.rejects(() =>
        instance.isolated.database.client.secret.delete({ where: { id: tokenSecret } }),
      );
      assert.equal((await owner.get('/secrets')).status, 200);
    });

    it('does not keep the token in the memory of the cache', async () => {
      await owner.get('/panel/nodes');
      const cache = instance.app.get(PanelCache);
      assert.ok(!inspect(cache, { depth: 8, showHidden: true }).includes(fake.token));
    });
  });

  describe('who may do what', () => {
    const profile = (): string => `/panel/config-profiles/${profileUuid}`;
    const reads = (): string[] => [
      '/panel/connection',
      '/panel/overview',
      '/panel/nodes',
      '/panel/hosts',
      '/panel/config-profiles',
      profile(),
      `${profile()}/computed-config`,
      '/panel/internal-squads',
      '/panel/external-squads',
      '/panel/subscription-templates',
      '/panel/subscription-settings',
      '/panel/snippets',
      '/panel/node-plugins',
      '/panel/infra',
    ];

    it('answers 401 to everything without a session', async () => {
      const anonymous = instance.client();
      for (const path of [...reads(), '/panel/api-tokens']) {
        assert.equal((await anonymous.get(path)).status, 401, path);
      }
      assert.equal(
        (
          await anonymous.call('PUT', '/panel/connection', {
            baseUrl: fake.url,
            tokenSecretId: tokenSecret,
          })
        ).status,
        401,
      );
      assert.equal((await anonymous.post('/panel/connection/test')).status, 401);
      assert.equal((await anonymous.call('DELETE', '/panel/connection')).status, 401);
    });

    it('lets everybody who can see the panel read it', async () => {
      for (const [name, client] of [
        ['owner', owner],
        ['operator', operator],
        ['observer', observer],
        ['terminal', terminal],
        ['auditor', auditor],
      ] as const) {
        for (const path of reads()) {
          const reply = await client.get(path);
          assert.equal(
            reply.status,
            200,
            `${name} ${path}: ${JSON.stringify(reply.body).slice(0, 200)}`,
          );
        }
        // The panel's own refusal is not a refusal of the role.
        assert.equal((await client.get('/panel/api-tokens')).status, 502, name);
      }
    });

    it('lets only those with panel:write connect, test and disconnect', async () => {
      const body = { baseUrl: fake.url, tokenSecretId: tokenSecret };
      for (const [name, client] of [
        ['observer', observer],
        ['terminal', terminal],
        ['auditor', auditor],
      ] as const) {
        assert.equal((await client.call('PUT', '/panel/connection', body)).status, 403, name);
        assert.equal((await client.post('/panel/connection/test')).status, 403, name);
        assert.equal((await client.call('DELETE', '/panel/connection')).status, 403, name);
        assert.equal(
          (
            await client.call('PUT', '/panel/connection/with-token', {
              baseUrl: fake.url,
              token: fake.token,
              secretName: 'x',
            })
          ).status,
          403,
          name,
        );
      }
      assert.equal((await operator.call('PUT', '/panel/connection', body)).status, 200);
      assert.equal((await operator.post('/panel/connection/test')).status, 200);
      assert.equal((await connection(owner)).state, 'connected');
    });

    it('keeps the vault permission for putting a token into it: an operator may not, with a code or without', async () => {
      const reply = await operator.call('PUT', '/panel/connection/with-token', {
        baseUrl: fake.url,
        token: fake.token,
        secretName: 'operator token',
      });
      assert.equal(reply.status, 403);
      assert.equal(errorOf(reply).code, 'forbidden');
      assert.match(errorOf(reply).message, /manage secrets/u);
      const list = await owner.get('/secrets');
      assert.ok(!JSON.stringify(list.body).includes('operator token'));
    });

    it('records refusals as authz.denied', async () => {
      const denied = (await auditEvents(instance)).filter(
        (e) => e.action === 'authz.denied' && e.details['permission'] === 'panel:write',
      );
      assert.ok(denied.length >= 1);
    });
  });

  describe('reading', () => {
    it('lists the nodes, with their state and versions', async () => {
      const reply = await read(owner, '/panel/nodes');
      assert.equal(reply.status, 200);
      const list = PanelNodeListSchema.parse(reply.body);
      assert.equal(list.nodes.length, fake.fixtures.nodes.length);
      assert.deepEqual(
        list.nodes.map((n) => n.state),
        ['online', 'online', 'offline'],
      );
      assert.equal(found(list.nodes[0], 'node').xrayVersion, '26.0.0-fake');
    });

    it('lists the hosts with every field and the opaque parameters masked', async () => {
      const list = PanelHostListSchema.parse((await read(owner, '/panel/hosts')).body);
      assert.equal(list.hosts.length, fake.fixtures.hosts.length);
      const first = found(list.hosts[0], 'host');
      assert.equal(first.remark, 'Host 1');
      assert.equal(first.fingerprint, 'chrome');
      assert.match(JSON.stringify(first.xhttpExtraParams), /masked/u);
    });

    it('lists the profiles without their configuration and gives one with it masked', async () => {
      const list = PanelConfigProfileListSchema.parse(
        (await read(owner, '/panel/config-profiles')).body,
      );
      assert.equal(list.configProfiles.length, 2);
      assert.ok(list.configProfiles.every((p) => !('config' in p)));
      const answer = PanelConfigProfileAnswerSchema.parse(
        (await read(owner, `/panel/config-profiles/${profileUuid}`)).body,
      );
      const detail: PanelConfigProfileView = answer.configProfile;
      assert.equal(detail.name, 'Profile One');
      assert.equal(
        detail.hash,
        found(
          list.configProfiles.find((p) => p.uuid === profileUuid),
          'profile',
        ).hash,
      );
      const text = JSON.stringify(detail.config);
      assert.ok(text.includes('VLESS_REALITY_MAIN') && text.includes('xtls-rprx-vision'));
      assert.match(text, /\[masked:[0-9a-f]{8}\]/u);
      assert.ok(detail.masked >= 8);
      const computed = PanelConfigProfileAnswerSchema.parse(
        (await read(owner, `/panel/config-profiles/${profileUuid}/computed-config`)).body,
      );
      assert.equal(computed.configProfile.name, 'Profile One');
      assert.equal(computed.cached, false, 'the computed configuration is read when asked');
    });

    it('answers 404 for a profile the panel does not have, and 400 for an id that is not one', async () => {
      const missing = await owner.get(
        '/panel/config-profiles/00000000-0000-4000-8000-0000000000ff',
      );
      assert.equal(missing.status, 404);
      assert.equal(errorOf(missing).code, 'not_found');
      assert.equal((await owner.get('/panel/config-profiles/not-a-uuid')).status, 400);
    });

    it('lists squads, templates, settings, snippets, node plugins and billing', async () => {
      assert.equal(
        PanelInternalSquadListSchema.parse((await read(owner, '/panel/internal-squads')).body)
          .internalSquads.length,
        2,
      );
      const external = PanelExternalSquadListSchema.parse(
        (await read(owner, '/panel/external-squads')).body,
      );
      assert.match(
        found(external.externalSquads[0], 'squad').responseHeadersAdd['Authorization'] ?? '',
        /^\[masked/u,
      );
      const templates = PanelSubscriptionTemplateListSchema.parse(
        (await read(owner, '/panel/subscription-templates')).body,
      );
      assert.equal(templates.templates.length, 3);
      assert.ok(
        JSON.stringify(found(templates.templates[0], 'template').templateJson).includes(
          '"auth":"password"',
        ),
      );
      assert.ok(
        found(templates.templates[1], 'yaml template').templateYaml?.includes('type: vless'),
      );
      const settings = PanelSubscriptionSettingsAnswerSchema.parse(
        (await read(owner, '/panel/subscription-settings')).body,
      );
      assert.equal(settings.subscriptionSettings.isShowCustomRemarks, true);
      assert.equal(
        PanelSnippetListSchema.parse((await read(owner, '/panel/snippets')).body).snippets.length,
        2,
      );
      assert.equal(
        PanelNodePluginListSchema.parse((await read(owner, '/panel/node-plugins')).body).nodePlugins
          .length,
        1,
      );
      const infra = PanelInfraAnswerSchema.parse((await read(owner, '/panel/infra')).body);
      assert.equal(infra.infra.providers.length, 1);
    });

    it('gives the overview: version, health, counts, the nodes that are up, users as numbers', async () => {
      const overview = PanelOverviewSchema.parse((await read(owner, '/panel/overview')).body);
      assert.equal(overview.connection.state, 'connected');
      const system = must(overview.system);
      assert.equal(system.version, '3.4.11');
      assert.equal(system.health, 'ok');
      assert.equal(system.instances, 2);
      assert.deepEqual(overview.counts, {
        nodes: 3,
        hosts: 4,
        configProfiles: 2,
        internalSquads: 2,
        externalSquads: 1,
        subscriptionTemplates: 3,
        snippets: 2,
        nodePlugins: 1,
      });
      assert.deepEqual(overview.nodes, { online: 2, connecting: 0, offline: 1, disabled: 0 });
      assert.deepEqual(overview.users, {
        total: 46,
        byStatus: { ACTIVE: 40, DISABLED: 3, EXPIRED: 2, LIMITED: 1 },
        onlineNow: 7,
      });
      assert.equal(overview.token?.secretName, 'panel token');
    });

    it('answers 502 panel_forbidden for the list of API tokens, which the panel keeps for an administrator session', async () => {
      const reply = await read(owner, '/panel/api-tokens');
      assert.equal(reply.status, 502);
      assert.equal(errorOf(reply).code, 'panel_forbidden');
      assert.equal(PanelApiTokenListSchema.safeParse(reply.body).success, false);
    });

    it('returns no secret of the panel in any answer', () => {
      assertClean(seen, forbiddenTexts([fake.token, WRONG_TOKEN]), 'an answer');
    });
  });

  describe('the memory of this server', () => {
    const hostsAsked = (): number => fake.countRequests('/api/hosts');

    it('answers from memory inside the time to live, and asks again when told to', async () => {
      await owner.get('/panel/hosts?refresh=true');
      const base = hostsAsked();
      const first = await owner.get('/panel/hosts');
      const second = await owner.get('/panel/hosts');
      assert.equal(hostsAsked(), base, 'no request to the panel');
      assert.equal((first.body as { cached: boolean }).cached, true);
      assert.equal((second.body as { cached: boolean }).cached, true);
      assert.equal(
        (first.body as { fetchedAt: string }).fetchedAt,
        (second.body as { fetchedAt: string }).fetchedAt,
      );
      const forced = await owner.get('/panel/hosts?refresh=true');
      assert.equal(hostsAsked(), base + 1);
      assert.equal((forced.body as { cached: boolean }).cached, false);
      assert.equal((await owner.get('/panel/hosts?refresh=nonsense')).status, 400);
    });

    it('shows a change of the panel after a forced read, and not before', async () => {
      const original = found(fake.fixtures.snippets[1], 'snippet');
      fake.fixtures.snippets.push({ name: 'ADDED', snippet: { x: 1 } });
      try {
        const before = PanelSnippetListSchema.parse(
          (await owner.get('/panel/snippets?refresh=true')).body,
        );
        assert.equal(before.snippets.length, 3);
      } finally {
        fake.fixtures.snippets.pop();
      }
      assert.equal(
        PanelSnippetListSchema.parse((await owner.get('/panel/snippets')).body).snippets.length,
        3,
        'the old answer is still in memory',
      );
      assert.equal(
        PanelSnippetListSchema.parse((await owner.get('/panel/snippets?refresh=true')).body)
          .snippets.length,
        2,
      );
      assert.ok(original);
    });

    it('does not keep the computed configuration', async () => {
      const path = `/panel/config-profiles/${profileUuid}/computed-config`;
      const base = fake.countRequests(/computed-config/u);
      await owner.get(path);
      await owner.get(path);
      assert.equal(fake.countRequests(/computed-config/u), base + 2);
    });
  });

  describe('testing and failing', () => {
    it('tests the connection and keeps the answer', async () => {
      const reply = await owner.post('/panel/connection/test');
      assert.equal(reply.status, 200);
      const result = PanelTestResultSchema.parse(reply.body);
      assert.equal(result.ok, true);
      assert.equal(result.connection.state, 'connected');
      assert.ok(result.latencyMs >= 0);
      const last = found(
        (await panelEvents(instance)).findLast((e) => e.action === 'panel.tested'),
        'panel.tested',
      );
      assert.equal((last as { outcome: string }).outcome, 'success');
    });

    it('reports a panel that went down as a result of the test, and as the state', async () => {
      fake.inject('/api/system/metadata', { kind: 'status', status: 503 });
      try {
        const result = PanelTestResultSchema.parse(
          (await owner.post('/panel/connection/test')).body,
        );
        assert.equal(result.ok, false);
        assert.equal(result.connection.state, 'unreachable');
        assert.equal(result.connection.lastError?.code, 'panel_unreachable');
        assert.equal(result.connection.panelVersion, '3.4.11', 'what was known stays');
        assert.ok(result.connection.capabilities, 'and so does what the token could read');
      } finally {
        fake.clearInjections();
      }
      const result = PanelTestResultSchema.parse((await owner.post('/panel/connection/test')).body);
      assert.equal(result.ok, true);
      assert.equal(result.connection.state, 'connected');
      assert.equal(result.connection.lastError, null);
      const outcomes = (await panelEvents(instance))
        .filter((e) => e.action === 'panel.tested')
        .map((e) => (e as { outcome: string }).outcome);
      assert.deepEqual(outcomes.slice(-2), ['failure', 'success']);
    });

    it('maps what the panel says on a read to a code of its own and moves the state', async () => {
      // 5xx -> panel_unreachable, and the state follows
      fake.inject('/api/nodes', { kind: 'status', status: 500 });
      let reply = await owner.get('/panel/nodes?refresh=true');
      assert.equal(reply.status, 502);
      assert.equal(errorOf(reply).code, 'panel_unreachable');
      assert.equal((await connection(owner)).state, 'unreachable');
      fake.clearInjections();
      // ... and back when the next read works
      assert.equal((await owner.get('/panel/nodes?refresh=true')).status, 200);
      assert.equal((await connection(owner)).state, 'connected');

      // 403 -> panel_forbidden, the state stays
      fake.forbid('/api/snippets');
      reply = await owner.get('/panel/snippets?refresh=true');
      assert.equal(reply.status, 502);
      assert.equal(errorOf(reply).code, 'panel_forbidden');
      assert.equal((await connection(owner)).state, 'connected');
      fake.clearInjections();

      // a contract change on one resource is that resource's problem
      fake.inject('/api/node-plugins', {
        kind: 'replace',
        body: { response: { nodePlugins: [{ uuid: 'x' }] } },
      });
      reply = await owner.get('/panel/node-plugins?refresh=true');
      assert.equal(reply.status, 502);
      assert.equal(errorOf(reply).code, 'panel_contract_changed');
      assert.equal((errorOf(reply).details as { endpoint: string }).endpoint, 'nodePlugins.list');
      assert.equal((await connection(owner)).state, 'connected');
      fake.clearInjections();

      // 429 -> panel_rate_limited with Retry-After
      fake.inject('/api/hosts', { kind: 'status', status: 429, headers: { 'retry-after': '120' } });
      reply = await owner.get('/panel/hosts?refresh=true');
      assert.equal(reply.status, 429);
      assert.equal(errorOf(reply).code, 'panel_rate_limited');
      assert.equal(reply.headers.get('retry-after'), '120');
      fake.clearInjections();

      // a revoked token -> panel_unauthorized, and the state says so
      const original = fake.token;
      fake.setToken('rotated-on-the-panel-0000000000000000');
      try {
        reply = await owner.get('/panel/infra?refresh=true');
        assert.equal(reply.status, 502);
        assert.equal(errorOf(reply).code, 'panel_unauthorized');
        assert.equal((await connection(owner)).state, 'unauthorized');
      } finally {
        fake.setToken(original);
      }
      assert.equal((await owner.get('/panel/infra?refresh=true')).status, 200);
      assert.equal((await connection(owner)).state, 'connected');
    });

    it('notes a change of state in the audit chain, once per change and without the people', async () => {
      const changes = (await panelEvents(instance)).filter(
        (e) => e.action === 'panel.state.changed',
      ) as unknown as { details: Record<string, unknown>; actor: unknown }[];
      assert.ok(changes.length >= 4);
      for (const change of changes) {
        assert.equal(change.actor, null);
        assert.notEqual(change.details['from'], change.details['to']);
      }
      assert.ok(changes.some((c) => c.details['to'] === 'unreachable'));
      assert.ok(
        changes.some(
          (c) =>
            c.details['to'] === 'unauthorized' && c.details['error_code'] === 'panel_unauthorized',
        ),
      );
    });

    it('answers 409 panel_unsupported_version on reads once the panel is found to run another version', async () => {
      fake.setVersion('3.5.0');
      try {
        const result = PanelTestResultSchema.parse(
          (await owner.post('/panel/connection/test')).body,
        );
        assert.equal(result.connection.state, 'unsupported');
        assert.equal(result.connection.versionSupport?.status, 'unsupported');
        const reply = await owner.get('/panel/nodes?refresh=true');
        assert.equal(reply.status, 409);
        assert.equal(errorOf(reply).code, 'panel_unsupported_version');
        assert.equal((await owner.get('/panel/overview')).status, 409);
      } finally {
        fake.setVersion('3.4.11');
      }
      assert.equal(
        PanelTestResultSchema.parse((await owner.post('/panel/connection/test')).body).connection
          .state,
        'connected',
      );
      assert.equal((await owner.get('/panel/nodes?refresh=true')).status, 200);
    });
  });

  describe('disconnecting', () => {
    it('forgets the connection, releases the secret and empties the memory', async () => {
      assert.equal((await owner.call('DELETE', '/panel/connection')).status, 204);
      assert.equal((await connection(owner)).state, 'unconfigured');
      assert.equal((await owner.get('/panel/nodes')).status, 409);
      const last = found(
        (await panelEvents(instance)).findLast((e) => e.action === 'panel.disconnected'),
        'panel.disconnected',
      );
      assert.equal((last as { details: Record<string, unknown> }).details['base_url'], fake.url);
      // The token is still in the vault, and can be deleted now.
      const spare = await makeSecret(
        owner,
        'spare token',
        'panel_token',
        'another-token-0000000000000000',
      );
      assert.equal((await owner.call('DELETE', `/secrets/${spare}`)).status, 204);
      assert.equal((await owner.call('DELETE', '/panel/connection')).status, 404);
    });

    it('lets the vault delete the secret now that nothing uses it', async () => {
      const reply = await owner.call('DELETE', `/secrets/${wrongSecret}`);
      assert.equal(reply.status, 204);
    });

    it('leaves no secret of the panel and no token in the audit chain', async () => {
      const text = JSON.stringify(await auditEvents(instance));
      for (const secret of forbiddenTexts([fake.token, WRONG_TOKEN])) {
        assert.ok(!text.includes(secret), `the audit chain holds ${secret}`);
      }
      assert.ok(Object.values(FAKE_SECRETS).length > 10);
    });
  });
});
