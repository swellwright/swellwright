import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

import { Logger } from '@nestjs/common';
import {
  PanelConsoleCatalogueSchema,
  PanelConsoleOperationDetailSchema,
  PanelConsoleResultSchema,
} from '@swellwright/contracts';
import {
  fakeAccessTexts,
  FakePanel,
  FAKE_SECRETS,
  fakePersonalTexts,
  must,
} from '@swellwright/remnawave/test-support';

import { AuditService } from '../../audit/audit.service.js';
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
} from '../../test-support.js';
import {
  assertClean,
  connect,
  errorOf,
  forbiddenTexts,
  makeSecret,
  PANEL_ENV,
  PASSPHRASE,
} from '../panel-test-support.js';

interface Booted {
  readonly instance: Instance;
  readonly owner: Client;
  readonly ownerSecret: string;
  readonly operator: Client;
  readonly observer: Client;
  readonly auditor: Client;
  readonly terminal: Client;
}

/** An instance with every kind of user signed in and a vault that is open. */
async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const instance = await start({ ...PANEL_ENV, ...env });
  const { secret } = await createOwner(instance);
  const owner = await signInAs(instance, 'owner', secret);
  const operator = await signInAs(
    instance,
    'ops',
    (await createUser(instance, 'ops', 'operator')).secret,
  );
  const observer = await signInAs(
    instance,
    'viewer',
    (await createUser(instance, 'viewer', 'observer')).secret,
  );
  const auditor = await signInAs(
    instance,
    'audit',
    (await createUser(instance, 'audit', 'auditor')).secret,
  );
  const terminal = await signInAs(
    instance,
    'term',
    (await createUser(instance, 'term', 'terminal')).secret,
  );
  assert.equal((await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status, 201);
  return { instance, owner, ownerSecret: secret, operator, observer, auditor, terminal };
}

/** The character a URL with credentials has before its host; kept out of the literals. */
const AT = '@';
const PATH = '/panel/api-console/requests';
const send = (client: Client, body: unknown) => client.post(PATH, body);

/** Lets the elevation of every session lapse, as if the step-up window had run out. */
async function lapse(instance: Instance): Promise<void> {
  await instance.isolated.database.client.session.updateMany({
    data: { elevatedUntil: new Date(Date.now() - 1000) },
  });
}

/** The audit events of the console, oldest first. */
async function consoleEvents(instance: Instance) {
  return (await auditEvents(instance)).filter((e) => e.action === 'panel.console.request');
}

describe('the API console', { skip: !databaseUrl }, () => {
  let b: Booted;
  let fake: FakePanel;
  let profileUuid = '';
  /** Every body a route answered during the run, for the scan at the end. */
  const seen: string[] = [];

  const ask = async (client: Client, body: unknown) => {
    const reply = await send(client, body);
    seen.push(JSON.stringify(reply.body));
    return reply;
  };
  const result = (reply: { body: unknown }) => PanelConsoleResultSchema.parse(reply.body);

  before(async () => {
    fake = await FakePanel.start();
    b = await boot();
    profileUuid = String(fake.fixtures.configProfiles[0]?.['uuid']);
  });
  after(async () => {
    await stop(b.instance);
    await fake.close();
  });

  describe('the catalogue', () => {
    it('is readable by everyone who may read the panel, before anything is connected', async () => {
      for (const client of [b.owner, b.operator, b.observer, b.auditor, b.terminal]) {
        const reply = await client.get('/panel/api-console/operations');
        assert.equal(reply.status, 200);
        const catalogue = PanelConsoleCatalogueSchema.parse(reply.body);
        assert.equal(catalogue.specVersion, '3.4.11');
        assert.deepEqual(catalogue.counts, {
          total: 218,
          get: 94,
          open: 59,
          userData: 28,
          blocked: 7,
          write: 124,
        });
        assert.equal(catalogue.operations.length, 218);
        assert.equal(catalogue.settings.userDataEnabled, false);
        assert.equal(catalogue.settings.ratePerMinute, 30);
        assert.equal(catalogue.settings.maxBodyKib, 1024);
      }
      assert.equal(fake.requests.length, 0, 'the panel is not asked for its own catalogue');
      assert.equal((await b.instance.client().get('/panel/api-console/operations')).status, 401);
    });

    it('gives an operation with its schemas, and 404 for one that is not in it', async () => {
      const reply = await b.observer.get(
        '/panel/api-console/operations/ConfigProfileController_getConfigProfileByUuid',
      );
      assert.equal(reply.status, 200);
      const detail = PanelConsoleOperationDetailSchema.parse(reply.body);
      assert.equal(detail.path, '/api/config-profiles/{uuid}');
      assert.equal(detail.availability, 'open');
      assert.ok(JSON.stringify(detail.responseSchema).includes('"properties"'));
      const write = PanelConsoleOperationDetailSchema.parse(
        (await b.observer.get('/panel/api-console/operations/NodesController_createNode')).body,
      );
      assert.equal(write.availability, 'write');
      assert.ok(write.requestBodySchema !== null, 'the body a write needs can be read, greyed');
      const missing = await b.observer.get('/panel/api-console/operations/Nope_nope');
      assert.equal(missing.status, 404);
      assert.equal(errorOf(missing).code, 'console_operation_unknown');
    });
  });

  describe('before a panel is connected', () => {
    it('asks for a panel first', async () => {
      const reply = await ask(b.owner, { operationId: 'NodesController_getNodes' });
      assert.equal(reply.status, 409);
      assert.equal(errorOf(reply).code, 'panel_not_connected');
    });
  });

  describe('with a panel connected', () => {
    before(async () => {
      const secret = await makeSecret(b.owner, 'panel token', 'panel_token', fake.token);
      assert.equal((await connect(b.owner, fake.url, secret)).status, 200);
      fake.requests.length = 0;
    });

    it('lets only the owner and the operator send, and nobody who is not signed in', async () => {
      const body = { operationId: 'NodesController_getNodes' };
      for (const client of [b.owner, b.operator]) {
        const reply = await ask(client, body);
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
      }
      for (const client of [b.observer, b.auditor, b.terminal]) {
        const reply = await ask(client, body);
        assert.equal(reply.status, 403);
        assert.equal(errorOf(reply).code, 'forbidden');
      }
      assert.equal((await send(b.instance.client(), body)).status, 401);
      assert.equal(
        fake.countRequests('/api/nodes'),
        2,
        'only the two allowed requests reached the panel',
      );
    });

    it('sends a GET to the path of the operation with the token, and returns the answer masked', async () => {
      fake.requests.length = 0;
      const reply = await ask(b.owner, {
        operationId: 'ConfigProfileController_getConfigProfileByUuid',
        pathParams: { uuid: profileUuid },
      });
      assert.equal(reply.status, 200);
      const answer = result(reply);
      assert.equal(answer.status, 200);
      assert.equal(answer.method, 'get');
      assert.equal(answer.path, '/api/config-profiles/{uuid}');
      assert.equal(answer.bodyFormat, 'json');
      assert.equal(answer.maskProfile, 'standard');
      assert.equal(answer.masked, true);
      assert.ok(answer.maskedCount >= 4);
      assert.equal(answer.truncated, false);
      assert.ok(answer.durationMs >= 0 && answer.attempts === 1);
      assert.deepEqual(Object.keys(answer.headers).sort(), ['content-length', 'content-type']);
      assert.deepEqual(
        fake.requests.map((r) => [r.method, r.path, r.authorization]),
        [['GET', `/api/config-profiles/${profileUuid}`, 'valid']],
      );
      const parsed = JSON.parse(answer.body) as { response: { name: string } };
      assert.equal(parsed.response.name, 'Profile One');
      for (const secret of Object.values(FAKE_SECRETS).flat()) {
        assert.ok(!answer.body.includes(secret), `the answer holds ${secret}`);
      }
    });

    it('returns a 404 or a 403 of the panel as a result, not as an error', async () => {
      const missing = result(
        await ask(b.owner, {
          operationId: 'NodesController_getNode',
          pathParams: { uuid: '00000000-0000-4000-8000-0000000fffff' },
        }),
      );
      assert.equal(missing.status, 404);
      const admin = result(await ask(b.owner, { operationId: 'ApiTokensController_getScopes' }));
      assert.equal(admin.status, 403);
      assert.match(admin.body, /Forbidden/u);
    });

    it('fills nothing from a person into the path but a checked value, and says what is wrong field by field', async () => {
      fake.requests.length = 0;
      const bad = await ask(b.owner, {
        operationId: 'NodesController_getNode',
        pathParams: { uuid: '../../etc/passwd' },
        query: { refresh: 'true' },
      });
      assert.equal(bad.status, 400);
      const error = errorOf(bad);
      assert.equal(error.code, 'validation_failed');
      const issues = (error.details as { issues: { path: string; message: string }[] }).issues;
      assert.deepEqual(issues.map((i) => i.path).sort(), ['pathParams.uuid', 'query.refresh']);
      assert.ok(!JSON.stringify(error).includes('etc/passwd'), 'the value is not repeated');
      // The shapes of an attack on the path, one by one: none reaches the panel.
      for (const uuid of [
        '..',
        '%2e%2e%2f',
        `${profileUuid}/../x`,
        `${profileUuid}?x=1`,
        `user${AT}evil.example.com`,
        '//evil.example.com',
        `${profileUuid}\r\nX-Injected: 1`,
      ]) {
        const reply = await ask(b.owner, {
          operationId: 'NodesController_getNode',
          pathParams: { uuid },
        });
        assert.equal(reply.status, 400, JSON.stringify(uuid));
      }
      assert.equal(fake.requests.length, 0);
    });

    it('refuses an operation that is not in the catalogue, a write and a read that is never sent, without asking the panel', async () => {
      fake.requests.length = 0;
      const unknown = await ask(b.owner, { operationId: 'NodesController_noSuchThing' });
      assert.equal(unknown.status, 404);
      assert.equal(errorOf(unknown).code, 'console_operation_unknown');
      // A free-form URL or header is not a thing the request has.
      for (const extra of [
        { url: 'https://evil.example.com/' },
        { headers: { a: 'b' } },
        { method: 'POST' },
      ]) {
        const reply = await ask(b.owner, { operationId: 'NodesController_getNodes', ...extra });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
      }
      assert.equal(fake.countRequests('/api/nodes'), 3, 'an extra field is dropped, never obeyed');
      assert.ok(fake.requests.every((r) => r.method === 'GET' && r.path.startsWith('/api/nodes')));
      fake.requests.length = 0;
      const write = await ask(b.owner, { operationId: 'NodesController_createNode' });
      assert.equal(write.status, 403);
      assert.equal(errorOf(write).code, 'console_operation_blocked');
      assert.deepEqual((errorOf(write).details as { reason: string }).reason, 'write_operation');
      for (const [operationId, reason] of [
        ['KeygenController_generateKey', 'secret_material'],
        ['SystemController_getX25519Keypairs', 'secret_material'],
        ['SubscriptionsController_getConnectionKeysByUserId', 'secret_material'],
        ['SubscriptionController_getSubscription', 'secret_material'],
        ['PasskeyController_passkeyRegistrationOptions', 'side_effect'],
        ['AuthController_passkeyAuthenticationOptions', 'side_effect'],
      ] as const) {
        const reply = await ask(b.owner, {
          operationId,
          pathParams: { shortUuid: 'x', userId: 1 },
        });
        assert.equal(reply.status, 403, operationId);
        assert.equal(errorOf(reply).code, 'console_operation_blocked');
        assert.equal((errorOf(reply).details as { reason: string }).reason, reason);
      }
      assert.equal(fake.requests.length, 0, 'nothing was sent to the panel');
    });

    it('keeps the operations about people off by default, with a code of its own, and says so in the record', async () => {
      fake.requests.length = 0;
      for (const operationId of [
        'UsersController_getUsers',
        'HwidUserDevicesController_getAllUsers',
        'UserSubscriptionRequestHistoryController_getSubscriptionRequestHistory',
        'SubscriptionsController_getAllSubscriptions',
      ]) {
        const reply = await ask(b.owner, { operationId });
        assert.equal(reply.status, 403, operationId);
        assert.equal(errorOf(reply).code, 'console_user_data_disabled');
      }
      assert.equal(fake.requests.length, 0);
      const denied = (await consoleEvents(b.instance)).filter((e) => e.outcome === 'denied');
      assert.ok(denied.length >= 4);
      assert.ok(denied.some((e) => e.details['reason'] === 'user_data_disabled'));
    });

    it('records every request: who, which operation, the path with its placeholders, the status, and no value', async () => {
      const before = (await consoleEvents(b.instance)).length;
      await ask(b.owner, {
        operationId: 'ConfigProfileController_getConfigProfileByUuid',
        pathParams: { uuid: profileUuid },
      });
      await ask(b.operator, { operationId: 'HostsController_getHosts' });
      const events = (await consoleEvents(b.instance)).slice(before);
      assert.equal(events.length, 2);
      const [first, second] = events;
      assert.equal(must(first).actor?.name, 'owner');
      assert.equal(must(second).actor?.name, 'ops');
      assert.equal(must(first).outcome, 'success');
      assert.deepEqual(
        must(first).details['operation_id'],
        'ConfigProfileController_getConfigProfileByUuid',
      );
      assert.equal(must(first).details['path'], '/api/config-profiles/{uuid}');
      assert.equal(must(first).details['status'], 200);
      assert.equal(typeof must(first).details['duration_ms'], 'number');
      assert.ok(Number(must(first).details['masked_count']) >= 4);
      assert.equal(must(first).details['about_people'], false);
      assert.equal(must(first).details['query_keys'], '');
      // Nothing of the request or the answer is in the log: not the identifier of the profile, not a secret, not a token.
      const text = JSON.stringify(events);
      assert.ok(!text.includes(profileUuid), 'the identifier of the object asked for');
      assertClean([text], forbiddenTexts([fake.token]), 'the audit records');
    });

    it('records the names of the query parameters and never their values', async () => {
      const before = (await consoleEvents(b.instance)).length;
      await ask(b.owner, {
        operationId: 'InfraBillingController_getInfraBillingRecords',
        query: { start: 0, size: 7 },
      });
      const event = must((await consoleEvents(b.instance)).slice(before)[0]);
      assert.equal(event.details['query_keys'], 'start,size');
      assert.ok(!JSON.stringify(event).includes('"size":7'));
    });
  });

  describe('what the panel does wrong', () => {
    let other: FakePanel;
    let c: Booted;

    before(async () => {
      other = await FakePanel.start();
      c = await boot({ SW_PANEL_MAX_RESPONSE_MIB: '1', SW_PANEL_TIMEOUT_SECONDS: '1' });
      const secret = await makeSecret(c.owner, 'panel token', 'panel_token', other.token);
      assert.equal((await connect(c.owner, other.url, secret)).status, 200);
    });
    after(async () => {
      await stop(c.instance);
      await other.close();
    });

    it('maps a refused token, a slow panel, a panel that asks to wait and one that is gone', async () => {
      const body = { operationId: 'HostsController_getHosts' };
      other.inject('/api/hosts', { kind: 'hang' }, 1);
      const slow = await send(c.owner, body);
      assert.equal(slow.status, 504);
      assert.equal(errorOf(slow).code, 'panel_timeout');

      other.inject('/api/hosts', {
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '600' },
      });
      const limited = await send(c.owner, body);
      assert.equal(limited.status, 429);
      assert.equal(errorOf(limited).code, 'panel_rate_limited');
      assert.equal(limited.headers.get('retry-after'), '600');
      other.clearInjections();

      const original = other.token;
      other.setToken('another-token-0000000000000000000000');
      const refused = await send(c.owner, body);
      assert.equal(refused.status, 502);
      assert.equal(errorOf(refused).code, 'panel_unauthorized');
      other.setToken(original);

      const events = (await consoleEvents(c.instance)).filter((e) => e.outcome === 'failure');
      assert.deepEqual(
        events.map((e) => e.details['error_code']),
        ['panel_timeout', 'panel_rate_limited', 'panel_unauthorized'],
      );
    });

    it('refuses an answer that is too large to read, and one that is not text', async () => {
      other.inject('/api/hosts', { kind: 'large', bytes: 3 * 1024 * 1024 }, 1);
      const large = await send(c.owner, { operationId: 'HostsController_getHosts' });
      assert.equal(large.status, 502);
      assert.equal(errorOf(large).code, 'console_response_too_large');
      other.inject(
        '/api/hosts',
        { kind: 'raw', contentType: 'application/octet-stream', body: 'binary' },
        1,
      );
      const binary = await send(c.owner, { operationId: 'HostsController_getHosts' });
      assert.equal(binary.status, 502);
      assert.equal(errorOf(binary).code, 'console_response_unsupported');
    });
  });

  describe('the limit per user', () => {
    let limited: Booted;
    let panel: FakePanel;

    before(async () => {
      panel = await FakePanel.start();
      limited = await boot({ SW_PANEL_CONSOLE_RATE_PER_MINUTE: '3' });
      const secret = await makeSecret(limited.owner, 'panel token', 'panel_token', panel.token);
      assert.equal((await connect(limited.owner, panel.url, secret)).status, 200);
      panel.requests.length = 0;
    });
    after(async () => {
      await stop(limited.instance);
      await panel.close();
    });

    it('counts the requests that reach the panel, not the ones that are refused before', async () => {
      for (let i = 0; i < 6; i += 1) {
        assert.equal(
          (
            await send(limited.owner, {
              operationId: 'NodesController_getNode',
              pathParams: { uuid: 'x' },
            })
          ).status,
          400,
        );
        assert.equal(
          (await send(limited.owner, { operationId: 'KeygenController_generateKey' })).status,
          403,
        );
      }
      for (let i = 0; i < 3; i += 1) {
        assert.equal(
          (await send(limited.owner, { operationId: 'NodesController_getNodes' })).status,
          200,
          String(i),
        );
      }
      const over = await send(limited.owner, { operationId: 'NodesController_getNodes' });
      assert.equal(over.status, 429);
      assert.equal(errorOf(over).code, 'rate_limited');
      assert.ok(Number(over.headers.get('retry-after')) > 0);
      // Another person has a limit of their own.
      assert.equal(
        (await send(limited.operator, { operationId: 'NodesController_getNodes' })).status,
        200,
      );
      assert.equal(panel.countRequests('/api/nodes'), 4);
    });
  });

  describe('the size of an answer', () => {
    it('is cut after masking, and the answer says so', async () => {
      const panel = await FakePanel.start({ extraNodes: 150 });
      const small = await boot({ SW_PANEL_CONSOLE_MAX_BODY_KIB: '16' });
      try {
        const secret = await makeSecret(small.owner, 'panel token', 'panel_token', panel.token);
        assert.equal((await connect(small.owner, panel.url, secret)).status, 200);
        const reply = await send(small.owner, { operationId: 'NodesController_getNodes' });
        assert.equal(reply.status, 200);
        const answer = result(reply);
        assert.equal(answer.truncated, true);
        assert.ok(Buffer.byteLength(answer.body) <= 16 * 1024);
        assert.ok(answer.bodyBytes > 16 * 1024);
        assert.equal(
          PanelConsoleCatalogueSchema.parse(
            (await small.owner.get('/panel/api-console/operations')).body,
          ).settings.maxBodyKib,
          16,
        );
      } finally {
        await stop(small.instance);
        await panel.close();
      }
    });
  });

  describe('the operations about people, when the installation allows them', () => {
    let people: Booted;
    let panel: FakePanel;

    before(async () => {
      panel = await FakePanel.start();
      people = await boot({ SW_PANEL_CONSOLE_USER_DATA: 'true' });
      const secret = await makeSecret(people.owner, 'panel token', 'panel_token', panel.token);
      assert.equal((await connect(people.owner, panel.url, secret)).status, 200);
      panel.requests.length = 0;
    });
    after(async () => {
      await stop(people.instance);
      await panel.close();
    });

    it('says in the catalogue that they can be sent', async () => {
      const catalogue = PanelConsoleCatalogueSchema.parse(
        (await people.owner.get('/panel/api-console/operations')).body,
      );
      assert.equal(catalogue.settings.userDataEnabled, true);
    });

    it('wants the permission to reveal secrets, which the operator does not have, and the second factor', async () => {
      const body = { operationId: 'UsersController_getUsers' };
      const operator = await send(people.operator, body);
      assert.equal(operator.status, 403);
      assert.equal(errorOf(operator).code, 'forbidden');
      await lapse(people.instance);
      const lapsed = await send(people.owner, body);
      assert.equal(lapsed.status, 403);
      assert.equal(errorOf(lapsed).code, 'step_up_required');
      assert.equal(panel.requests.length, 0, 'nothing reached the panel without both');
      // The operations that are not about people do not ask for a code.
      assert.equal(
        (await send(people.owner, { operationId: 'HostsController_getHosts' })).status,
        200,
      );
      await forgetLastStep(people.instance);
      assert.equal(
        (await people.owner.post('/auth/step-up', { code: codeFor(people.ownerSecret) })).status,
        200,
      );
      const reply = await send(people.owner, body);
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
    });

    it('returns them with the people hidden and the numbers left, and records the call before it is delivered', async () => {
      panel.requests.length = 0;
      const everything: string[] = [];
      for (const [operationId, extra] of [
        ['UsersController_getUsers', {}],
        ['UsersController_getUserById', { pathParams: { userId: 1 } }],
        ['UsersController_getUserByUsername', { pathParams: { username: 'fake-user-one' } }],
        ['HwidUserDevicesController_getAllUsers', {}],
        ['UserSubscriptionRequestHistoryController_getSubscriptionRequestHistory', {}],
        ['SubscriptionsController_getAllSubscriptions', {}],
      ] as const) {
        const reply = await send(people.owner, { operationId, ...extra });
        assert.equal(reply.status, 200, `${operationId}: ${JSON.stringify(reply.body)}`);
        const answer = result(reply);
        assert.equal(answer.maskProfile, 'personal', operationId);
        assert.equal(answer.masked, true);
        everything.push(JSON.stringify(reply.body));
      }
      assertClean(everything, fakePersonalTexts(), 'the answers about people');
      const users = JSON.parse(
        result(await send(people.owner, { operationId: 'UsersController_getUsers' })).body,
      ) as { response: { users: { id: number; status: string }[] } };
      assert.deepEqual(
        users.response.users.map((u) => u.id),
        [1, 2],
      );
      assert.equal(users.response.users[0]?.status, 'ACTIVE');
      // The record says the call was about people, and holds none of them.
      const events = (await consoleEvents(people.instance)).filter(
        (e) => e.details['about_people'] === true && e.outcome === 'success',
      );
      assert.ok(events.length >= 6);
      assertClean([JSON.stringify(events)], [...fakePersonalTexts(), panel.token], 'the records');
      // The path parameters of the calls (a user name, a number) are not in the record either.
      assert.ok(!JSON.stringify(events).includes('fake-user-one'));
      assert.ok(events.every((e) => !Object.values(e.details).includes('fake-user-one')));
    });

    it('still keeps the access material of users out of the answers of operations that are not about people', async () => {
      const settings = result(
        await send(people.owner, { operationId: 'RemnawaveSettingsController_getSettings' }),
      );
      assertClean(
        [settings.body],
        [...fakeAccessTexts(), 'fake.admin@example.com'],
        'the settings',
      );
      assert.equal(settings.maskProfile, 'standard');
    });

    it('does not deliver an answer about people when it cannot be recorded', async () => {
      const audit = people.instance.app.get(AuditService);
      const failing = mock.method(audit, 'record', () =>
        Promise.reject(new Error('the log is down')),
      );
      try {
        const reply = await send(people.owner, { operationId: 'UsersController_getUsers' });
        assert.equal(reply.status, 500);
        assert.ok(!JSON.stringify(reply.body).includes('FAKE'));
        assert.ok(!JSON.stringify(reply.body).includes('fake-user'));
        // A read of the panel's own objects is not a change: a record that cannot be written does not stop it.
        assert.equal(
          (await send(people.owner, { operationId: 'HostsController_getHosts' })).status,
          200,
        );
      } finally {
        failing.mock.restore();
      }
    });
  });

  describe('the sealed vault', () => {
    it('answers 423 and does not ask the panel', async () => {
      const panel = await FakePanel.start();
      const sealed = await boot();
      try {
        const secret = await makeSecret(sealed.owner, 'panel token', 'panel_token', panel.token);
        assert.equal((await connect(sealed.owner, panel.url, secret)).status, 200);
        panel.requests.length = 0;
        assert.equal((await sealed.owner.post('/vault/seal')).status, 200);
        const reply = await send(sealed.owner, { operationId: 'NodesController_getNodes' });
        assert.equal(reply.status, 423);
        assert.equal(errorOf(reply).code, 'vault_sealed');
        assert.equal(panel.requests.length, 0);
      } finally {
        await stop(sealed.instance);
        await panel.close();
      }
    });
  });

  describe('what is left behind', () => {
    it('holds no secret of the panel and no token in any answer, record or log line', async () => {
      const panel = await FakePanel.start();
      const logs: string[] = [];
      const say =
        (level: string) =>
        (message: unknown, ...rest: unknown[]): void => {
          logs.push(
            `${level} ${[message, ...rest].map((part) => inspect(part, { depth: 6 })).join(' ')}`,
          );
        };
      const booted = await boot();
      Logger.overrideLogger({
        log: say('log'),
        warn: say('warn'),
        error: say('error'),
        debug: say('debug'),
        verbose: say('verbose'),
        fatal: say('fatal'),
      });
      try {
        const secret = await makeSecret(booted.owner, 'panel token', 'panel_token', panel.token);
        await connect(booted.owner, panel.url, secret);
        const uuid = String(panel.fixtures.configProfiles[0]?.['uuid']);
        const replies = [
          await send(booted.owner, {
            operationId: 'ConfigProfileController_getConfigProfileByUuid',
            pathParams: { uuid },
          }),
          await send(booted.owner, { operationId: 'RemnawaveSettingsController_getSettings' }),
          await send(booted.owner, { operationId: 'SnippetsController_getSnippets' }),
          await send(booted.owner, {
            operationId: 'NodesController_getNode',
            pathParams: { uuid: 'bad' },
          }),
          await send(booted.owner, { operationId: 'UsersController_getUsers' }),
        ];
        panel.inject('/api/hosts', { kind: 'raw', body: `{"response":"${panel.token}"}` }, 1);
        replies.push(await send(booted.owner, { operationId: 'HostsController_getHosts' }));
        const records = JSON.stringify(await auditEvents(booted.instance));
        const texts = [...replies.map((r) => JSON.stringify(r.body)), records, ...logs];
        assert.ok(logs.length >= 0);
        // Not a secret of the panel, not the access material of a user, not the token: in no answer, record or log line,
        // even for the panel that echoed the token back in an answer.
        assertClean(
          texts,
          [...forbiddenTexts([panel.token]), ...fakeAccessTexts()],
          'what the console left behind',
        );
        assert.ok(replies.at(-1)?.status === 200);
        assert.match(JSON.stringify(replies.at(-1)?.body), /masked/u);
      } finally {
        Logger.overrideLogger(false);
        await stop(booted.instance);
        await panel.close();
      }
    });
  });

  it('has seen no secret of the panel in any answer of the run', () => {
    assertClean(seen, forbiddenTexts([fake.token]), 'the answers');
    assertClean(seen, fakeAccessTexts(), 'the answers');
  });
});
