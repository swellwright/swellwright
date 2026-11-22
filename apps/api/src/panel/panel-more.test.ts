import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { inspect } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '@nestjs/common';
import {
  PanelApiTokenListSchema,
  PanelHostListSchema,
  PanelNodeListSchema,
  PanelOverviewSchema,
  SecretListSchema,
} from '@swellwright/contracts';
import { FakePanel, type FakePanelOptions, must } from '@swellwright/remnawave/test-support';

import {
  auditEvents,
  type Client,
  codeFor,
  createOwner,
  createUser,
  databaseUrl,
  forgetLastStep,
  found,
  type Instance,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { PanelMonitorService } from './panel-monitor.service.js';
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
  tokenExpiringIn,
} from './panel-test-support.js';

interface Booted {
  readonly instance: Instance;
  readonly owner: Client;
  readonly ownerSecret: string;
}

/** An instance with an owner who is signed in and a vault that is open. */
async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const instance = await start({ ...PANEL_ENV, ...env });
  const { secret } = await createOwner(instance);
  const owner = await signInAs(instance, 'owner', secret);
  assert.equal((await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status, 201);
  return { instance, owner, ownerSecret: secret };
}

describe('pasting a token into the wizard', { skip: !databaseUrl }, () => {
  let booted: Booted;
  let fake: FakePanel;

  before(async () => {
    fake = await FakePanel.start();
    booted = await boot();
  });
  after(async () => {
    await stop(booted.instance);
    await fake.close();
  });

  const withToken = (token: string, name: string, extra: Record<string, unknown> = {}) =>
    booted.owner.call('PUT', '/panel/connection/with-token', {
      baseUrl: fake.url,
      token,
      secretName: name,
      ...extra,
    });

  it('keeps the token in the vault and the connection together, after the panel accepted it', async () => {
    const reply = await withToken(fake.token, 'pasted token');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const view = await connection(booted.owner);
    assert.equal(view.state, 'connected');
    assert.equal(must(view.token).secretName, 'pasted token');
    const secrets = SecretListSchema.parse((await booted.owner.get('/secrets')).body).secrets;
    const secret = found(
      secrets.find((s) => s.name === 'pasted token'),
      'the secret',
    );
    assert.equal(secret.type, 'panel_token');
    assert.equal(must(view.token).secretId, secret.id);
    assert.ok(!JSON.stringify(reply.body).includes(fake.token));
    const events = await auditEvents(booted.instance);
    assert.ok(events.some((e) => e.action === 'secret.created' && e.object?.id === secret.id));
    assert.ok(
      events.some((e) => e.action === 'panel.connected' && e.details['secret_id'] === secret.id),
    );
    assert.ok(!JSON.stringify(events).includes(fake.token));
    // And it works: the connection reads with the token the vault holds.
    assert.equal((await booted.owner.get('/panel/nodes')).status, 200);
  });

  it('does not store a token the panel refuses, and keeps the connection it had', async () => {
    const before = (await connection(booted.owner)).token?.secretId;
    const reply = await withToken('a-token-nobody-knows-0000000000000', 'refused token');
    assert.equal(reply.status, 502);
    assert.equal(errorOf(reply).code, 'panel_unauthorized');
    const secrets = SecretListSchema.parse((await booted.owner.get('/secrets')).body).secrets;
    assert.ok(!secrets.some((s) => s.name === 'refused token'), 'no secret was made');
    assert.equal((await connection(booted.owner)).token?.secretId, before);
  });

  it('is one transaction: a taken name leaves the old connection and makes no secret', async () => {
    const before = await connection(booted.owner);
    const reply = await withToken(fake.token, 'pasted token');
    assert.equal(reply.status, 409);
    const after = await connection(booted.owner);
    assert.equal(after.token?.secretId, before.token?.secretId);
    assert.equal(after.createdAt, before.createdAt);
    const connected = (await panelEvents(booted.instance)).filter(
      (e) => e.action === 'panel.connected' && e.outcome === 'success',
    );
    assert.equal(connected.length, 1);
  });

  it('needs a fresh authenticator code', async () => {
    await booted.instance.isolated.database.client.session.updateMany({
      data: { elevatedUntil: new Date(0) },
    });
    const stale = await withToken(fake.token, 'needs a code');
    assert.equal(stale.status, 403);
    assert.equal(errorOf(stale).code, 'step_up_required');
    await forgetLastStep(booted.instance);
    assert.equal(
      (await booted.owner.post('/auth/step-up', { code: codeFor(booted.ownerSecret) })).status,
      200,
    );
    assert.equal((await withToken(fake.token, 'needs a code')).status, 200);
  });

  it('refuses an address the policy does not allow before it asks the panel', async () => {
    const reply = await booted.owner.call('PUT', '/panel/connection/with-token', {
      baseUrl: 'https://169.254.169.254',
      token: fake.token,
      secretName: 'metadata token',
    });
    assert.equal(reply.status, 409);
    assert.equal(errorOf(reply).code, 'address_not_allowed');
    const secrets = SecretListSchema.parse((await booted.owner.get('/secrets')).body).secrets;
    assert.ok(!secrets.some((s) => s.name === 'metadata token'));
  });

  it('remembers a certificate authority of its own, and can drop it again', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
    const secretId = (await connection(booted.owner)).token?.secretId ?? '';
    assert.equal((await connect(booted.owner, fake.url, secretId, { trustedCa: pem })).status, 200);
    const view = await connection(booted.owner);
    assert.equal(view.trustedCa, true);
    assert.ok(
      !JSON.stringify(view).includes('MIIBfake'),
      'the view says there is one, it does not repeat it',
    );
    assert.equal((await connect(booted.owner, fake.url, secretId)).status, 200);
    assert.equal((await connection(booted.owner)).trustedCa, false);
  });
});

describe('a sealed vault', { skip: !databaseUrl }, () => {
  let booted: Booted;
  let fake: FakePanel;
  let secretId = '';

  before(async () => {
    fake = await FakePanel.start();
    booted = await boot();
    secretId = await makeSecret(booted.owner, 'panel token', 'panel_token', fake.token);
    assert.equal((await connect(booted.owner, fake.url, secretId)).status, 200);
  });
  after(async () => {
    await stop(booted.instance);
    await fake.close();
  });

  it('answers 423 where a token is needed, and from memory where it is not', async () => {
    assert.equal((await booted.owner.get('/panel/nodes')).status, 200);
    assert.equal((await booted.owner.post('/vault/seal')).status, 200);
    for (const [label, reply] of [
      ['connect', await connect(booted.owner, fake.url, secretId)],
      [
        'with-token',
        await booted.owner.call('PUT', '/panel/connection/with-token', {
          baseUrl: fake.url,
          token: fake.token,
          secretName: 'x',
        }),
      ],
      ['test', await booted.owner.post('/panel/connection/test')],
      ['forced read', await booted.owner.get('/panel/nodes?refresh=true')],
      ['a kind not in memory', await booted.owner.get('/panel/infra?refresh=true')],
    ] as const) {
      assert.equal(reply.status, 423, label);
      assert.equal(errorOf(reply).code, 'vault_sealed', label);
    }
    const cached = await booted.owner.get('/panel/hosts');
    assert.equal(cached.status, 200, 'what was read stays readable');
    assert.equal(PanelHostListSchema.parse(cached.body).cached, true);
    // Disconnecting needs no token.
    assert.equal((await connection(booted.owner)).state, 'connected');
  });

  it('is skipped by the background check, which changes nothing', async () => {
    const before = await connection(booted.owner);
    fake.setVersion('3.9.9');
    try {
      await booted.instance.app.get(PanelMonitorService).runOnce();
    } finally {
      fake.setVersion('3.4.11');
    }
    const after = await connection(booted.owner);
    assert.equal(after.state, 'connected');
    assert.equal(after.lastCheckedAt, before.lastCheckedAt);
    assert.equal((await booted.owner.call('DELETE', '/panel/connection')).status, 204);
  });
});

describe('what a token can read and when it expires', { skip: !databaseUrl }, () => {
  let booted: Booted;
  const panels: FakePanel[] = [];

  before(async () => {
    booted = await boot();
  });
  after(async () => {
    await stop(booted.instance);
    for (const panel of panels) {
      await panel.close();
    }
  });

  async function connectTo(
    options: FakePanelOptions,
    name: string,
    prepare: (panel: FakePanel) => void = () => undefined,
  ): Promise<FakePanel> {
    const panel = await FakePanel.start(options);
    panels.push(panel);
    prepare(panel);
    const id = await makeSecret(booted.owner, name, 'panel_token', panel.token);
    const reply = await connect(booted.owner, panel.url, id);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return panel;
  }

  it('is degraded, with a warning, when the token cannot read some of it, and the overview still works', async () => {
    await connectTo({}, 'limited token', (p) => {
      p.forbid('/api/hosts');
    });
    const view = await connection(booted.owner);
    assert.equal(view.state, 'degraded');
    const capabilities = must(view.capabilities);
    assert.equal(capabilities.resources.hosts, 'denied');
    assert.equal(capabilities.resources.nodes, 'ok');
    assert.ok(
      view.warnings.some((w) => w.code === 'capabilities_limited' && w.message.includes('hosts')),
    );
    const hosts = await booted.owner.get('/panel/hosts');
    assert.equal(hosts.status, 502);
    assert.equal(errorOf(hosts).code, 'panel_forbidden');
    const overview = PanelOverviewSchema.parse((await booted.owner.get('/panel/overview')).body);
    assert.equal(overview.counts.hosts, null);
    assert.equal(overview.counts.nodes, 3);
    assert.equal(overview.connection.state, 'degraded');
  });

  it('lists the tokens of the panel when it lets the token do it, never with a token value', async () => {
    await connectTo({ adminSession: true }, 'admin session token');
    const view = await connection(booted.owner);
    assert.equal(view.capabilities?.resources.apiTokens, 'ok');
    const reply = await booted.owner.get('/panel/api-tokens');
    assert.equal(reply.status, 200);
    const list = PanelApiTokenListSchema.parse(reply.body);
    assert.equal(list.apiTokens.length, 1);
    assert.deepEqual(Object.keys(found(list.apiTokens[0], 'token')).sort(), [
      'createdAt',
      'daysLeft',
      'expireAt',
      'hash',
      'name',
      'scopes',
      'updatedAt',
      'uuid',
    ]);
  });

  it('reads the expiry of a signed token and warns from fourteen days before', async () => {
    const expiring = tokenExpiringIn(10);
    await connectTo({ token: expiring }, 'expiring token');
    let view = await connection(booted.owner);
    assert.equal(view.state, 'degraded');
    const token = must(view.token);
    assert.ok(token.expiresAt);
    assert.ok(must(token.daysLeft) >= 9 && must(token.daysLeft) <= 10, String(token.daysLeft));
    assert.equal(token.expiryWarning, true);
    assert.ok(view.warnings.some((w) => w.code === 'token_expiring'));
    assert.equal(view.lastError, null);
    const overview = PanelOverviewSchema.parse((await booted.owner.get('/panel/overview')).body);
    assert.equal(overview.token?.expiryWarning, true);
    assert.ok(overview.warnings.some((w) => w.code === 'token_expiring'));
    assert.ok(!JSON.stringify(overview).includes(expiring));

    await connectTo({ token: tokenExpiringIn(100) }, 'long token');
    view = await connection(booted.owner);
    assert.equal(view.state, 'connected');
    assert.equal(view.token?.expiryWarning, false);
    assert.deepEqual(view.warnings, []);

    await connectTo({ token: tokenExpiringIn(-2) }, 'expired token');
    view = await connection(booted.owner);
    assert.ok((view.token?.daysLeft ?? 0) < 0);
    assert.ok(
      view.warnings.some((w) => w.code === 'token_expiring' && w.message.includes('expired')),
    );

    // A token that carries no expiry says nothing about one.
    await connectTo({}, 'plain token');
    assert.equal((await connection(booted.owner)).token?.expiresAt, null);
  });

  it('reads a long list of nodes and hosts', async () => {
    await connectTo({ extraNodes: 800, extraHosts: 800 }, 'big panel');
    const nodes = PanelNodeListSchema.parse((await booted.owner.get('/panel/nodes')).body);
    assert.equal(nodes.nodes.length, 803);
    const hosts = PanelHostListSchema.parse((await booted.owner.get('/panel/hosts')).body);
    assert.equal(hosts.hosts.length, 804);
  });

  it('gives up on a panel that is too slow, with its own code', async () => {
    const slow = await FakePanel.start();
    slow.inject('/api/system/metadata', { kind: 'hang' });
    const timed = await boot({ SW_PANEL_TIMEOUT_SECONDS: '1' });
    try {
      const secret = await makeSecret(timed.owner, 'slow token', 'panel_token', slow.token);
      const reply = await connect(timed.owner, slow.url, secret);
      assert.equal(reply.status, 504);
      assert.equal(errorOf(reply).code, 'panel_timeout');
      assert.equal((await connection(timed.owner)).state, 'unconfigured');
    } finally {
      await stop(timed.instance);
      await slow.close();
    }
  });
});

describe('limits and joining', { skip: !databaseUrl }, () => {
  let booted: Booted;
  let fake: FakePanel;

  before(async () => {
    fake = await FakePanel.start();
    booted = await boot({
      SW_PANEL_CACHE_TTL_SECONDS: '0',
      SW_PANEL_REFRESH_RATE_LIMIT_PER_MINUTE: '3',
      SW_PANEL_TEST_RATE_LIMIT_PER_MINUTE: '3',
    });
    const secret = await makeSecret(booted.owner, 'panel token', 'panel_token', fake.token);
    assert.equal((await connect(booted.owner, fake.url, secret)).status, 200);
  });
  after(async () => {
    await stop(booted.instance);
    await fake.close();
  });

  it('joins reads of the same kind that arrive together, even without a memory', async () => {
    fake.requests.length = 0;
    fake.inject('/api/hosts', { kind: 'delay', ms: 200 });
    const replies = await Promise.all(
      Array.from({ length: 6 }, () => booted.owner.get('/panel/hosts')),
    );
    fake.clearInjections();
    assert.ok(replies.every((r) => r.status === 200));
    assert.equal(fake.countRequests('/api/hosts'), 1, 'one request to the panel for six callers');
    // Without a memory the next read asks again.
    await booted.owner.get('/panel/hosts');
    assert.equal(fake.countRequests('/api/hosts'), 2);
  });

  it('limits how often one person may force a read, and says when to try again', async () => {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await booted.owner.get('/panel/snippets?refresh=true')).status, 200, String(i));
    }
    const limited = await booted.owner.get('/panel/snippets?refresh=true');
    assert.equal(limited.status, 429);
    assert.equal(errorOf(limited).code, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    // Reading without refresh is not limited.
    assert.equal((await booted.owner.get('/panel/snippets')).status, 200);
  });

  it('limits how often one person may connect or test', async () => {
    // Two used so far by connecting in `before`; the limit is three a minute.
    assert.equal((await booted.owner.post('/panel/connection/test')).status, 200);
    assert.equal((await booted.owner.post('/panel/connection/test')).status, 200);
    const limited = await booted.owner.post('/panel/connection/test');
    assert.equal(limited.status, 429);
    assert.equal(errorOf(limited).code, 'rate_limited');
  });
});

describe('the computed configuration has a budget of its own', { skip: !databaseUrl }, () => {
  let booted: Booted;
  let fake: FakePanel;
  let path = '';

  before(async () => {
    fake = await FakePanel.start();
    booted = await boot({
      SW_PANEL_CACHE_TTL_SECONDS: '0',
      SW_PANEL_REFRESH_RATE_LIMIT_PER_MINUTE: '2',
      SW_PANEL_COMPUTED_RATE_LIMIT_PER_MINUTE: '3',
    });
    const secret = await makeSecret(booted.owner, 'panel token', 'panel_token', fake.token);
    assert.equal((await connect(booted.owner, fake.url, secret)).status, 200);
    path = `/panel/config-profiles/${String(must(fake.fixtures.configProfiles[0])['uuid'])}/computed-config`;
  });
  after(async () => {
    await stop(booted.instance);
    await fake.close();
  });

  it('is read after a burst of forced reads of other objects has used up the refresh budget', async () => {
    assert.equal((await booted.owner.get('/panel/snippets?refresh=true')).status, 200);
    assert.equal((await booted.owner.get('/panel/hosts?refresh=true')).status, 200);
    const burst = await booted.owner.get('/panel/nodes?refresh=true');
    assert.equal(burst.status, 429, 'the refresh budget is spent');
    assert.equal(errorOf(burst).code, 'rate_limited');
    const base = fake.countRequests(/computed-config/u);
    const first = await booted.owner.get(path);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(fake.countRequests(/computed-config/u), base + 1, 'it asked the panel');
  });

  it('does not use up the refresh budget with its own reads, and is limited by its own budget', async () => {
    // Two of three were left: reading it twice more is allowed, and the third read after that is not.
    assert.equal((await booted.owner.get(path)).status, 200);
    assert.equal((await booted.owner.get(path)).status, 200);
    const over = await booted.owner.get(path);
    assert.equal(over.status, 429);
    assert.equal(errorOf(over).code, 'rate_limited');
    assert.ok(Number(over.headers.get('retry-after')) > 0);
    // Reading the profile itself, from memory or not, is not limited by it, and still not kept for the computed one.
    assert.equal((await booted.owner.get(path.replace('/computed-config', ''))).status, 200);
    assert.equal(
      fake.countRequests(/computed-config/u) >= 3,
      true,
      'the refused read did not reach the panel',
    );
  });

  it('counts per person: another user has a budget of their own', async () => {
    const other = await signInAs(
      booted.instance,
      'second',
      (await createUser(booted.instance, 'second', 'operator')).secret,
    );
    assert.equal((await other.get(path)).status, 200);
  });
});

describe(
  'the computed configuration does not take the refresh budget either',
  { skip: !databaseUrl },
  () => {
    it('leaves a person their forced reads after they have read it as often as they like', async () => {
      const fake = await FakePanel.start();
      const booted = await boot({
        SW_PANEL_CACHE_TTL_SECONDS: '0',
        SW_PANEL_REFRESH_RATE_LIMIT_PER_MINUTE: '2',
        SW_PANEL_COMPUTED_RATE_LIMIT_PER_MINUTE: '50',
      });
      try {
        const secret = await makeSecret(booted.owner, 'panel token', 'panel_token', fake.token);
        assert.equal((await connect(booted.owner, fake.url, secret)).status, 200);
        const path = `/panel/config-profiles/${String(must(fake.fixtures.configProfiles[0])['uuid'])}/computed-config`;
        for (let i = 0; i < 10; i += 1) {
          assert.equal((await booted.owner.get(path)).status, 200, String(i));
        }
        assert.equal((await booted.owner.get('/panel/snippets?refresh=true')).status, 200);
        assert.equal((await booted.owner.get('/panel/hosts?refresh=true')).status, 200);
        assert.equal((await booted.owner.get('/panel/nodes?refresh=true')).status, 429);
      } finally {
        await stop(booted.instance);
        await fake.close();
      }
    });
  },
);

describe('the background check', { skip: !databaseUrl }, () => {
  let booted: Booted;
  let fake: FakePanel;

  before(async () => {
    fake = await FakePanel.start();
    booted = await boot();
    const secret = await makeSecret(booted.owner, 'panel token', 'panel_token', fake.token);
    assert.equal((await connect(booted.owner, fake.url, secret)).status, 200);
  });
  after(async () => {
    await stop(booted.instance);
    await fake.close();
  });

  const changes = async () =>
    (await panelEvents(booted.instance)).filter((e) => e.action === 'panel.state.changed');
  const check = (): Promise<void> => booted.instance.app.get(PanelMonitorService).runOnce();

  it('changes the state and writes to the audit chain only when the state changed', async () => {
    const first = await connection(booted.owner);
    await sleep(20);
    await check();
    const second = await connection(booted.owner);
    assert.equal(second.state, 'connected');
    assert.ok((second.lastCheckedAt ?? '') > (first.lastCheckedAt ?? ''), 'it looked');
    assert.equal((await changes()).length, 0, 'and said nothing');

    fake.setVersion('3.5.0');
    await check();
    assert.equal((await connection(booted.owner)).state, 'unsupported');
    await check();
    assert.equal((await changes()).length, 1, 'once for the change, not once per look');
    const event = found((await changes())[0], 'the change');
    assert.deepEqual(
      { from: event.details['from'], to: event.details['to'] },
      { from: 'connected', to: 'unsupported' },
    );
    assert.equal(event.actor, null);
    assert.equal(event.details['error_code'], 'panel_unsupported_version');

    fake.setVersion('3.4.11');
    await check();
    assert.equal((await connection(booted.owner)).state, 'connected');
    assert.equal((await changes()).length, 2);
  });

  it('follows a token that was revoked and a panel that went away', async () => {
    const token = fake.token;
    fake.setToken('revoked-and-replaced-0000000000000000');
    await check();
    const view = await connection(booted.owner);
    assert.equal(view.state, 'unauthorized');
    assert.equal(view.lastError?.code, 'panel_unauthorized');
    fake.setToken(token);
    await check();
    assert.equal((await connection(booted.owner)).state, 'connected');

    fake.inject('/api/system/metadata', { kind: 'drop' });
    await check();
    assert.equal((await connection(booted.owner)).state, 'unreachable');
    fake.clearInjections();
    await check();
    assert.equal((await connection(booted.owner)).state, 'connected');
    const states = (await changes()).map(
      (e) => `${String(e.details['from'])}>${String(e.details['to'])}`,
    );
    assert.deepEqual(states.slice(2), [
      'connected>unauthorized',
      'unauthorized>connected',
      'connected>unreachable',
      'unreachable>connected',
    ]);
  });

  it('does nothing when no panel is connected', async () => {
    assert.equal((await booted.owner.call('DELETE', '/panel/connection')).status, 204);
    const before = (await auditEvents(booted.instance)).length;
    await check();
    assert.equal((await auditEvents(booted.instance)).length, before);
  });
});

describe('the background check on a timer', { skip: !databaseUrl }, () => {
  it('runs by itself at the configured interval', async () => {
    const fake = await FakePanel.start();
    const booted = await boot({ SW_PANEL_CHECK_INTERVAL_MINUTES: '0.02' });
    try {
      const secret = await makeSecret(booted.owner, 'panel token', 'panel_token', fake.token);
      assert.equal((await connect(booted.owner, fake.url, secret)).status, 200);
      fake.setVersion('3.7.0');
      let state = 'connected';
      for (let i = 0; i < 40 && state === 'connected'; i += 1) {
        await sleep(250);
        state = (await connection(booted.owner)).state;
      }
      assert.equal(state, 'unsupported');
    } finally {
      await stop(booted.instance);
      await fake.close();
    }
  });
});

describe('the address policy of this installation', { skip: !databaseUrl }, () => {
  it('refuses plain http everywhere unless it is allowed', async () => {
    const fake = await FakePanel.start();
    const booted = await boot({ SW_PANEL_ALLOW_HTTP: 'false' });
    try {
      const secret = await makeSecret(booted.owner, 'panel token', 'panel_token', fake.token);
      const reply = await connect(booted.owner, fake.url, secret);
      assert.equal(reply.status, 400);
      assert.match(errorOf(reply).message, /https/u);
    } finally {
      await stop(booted.instance);
      await fake.close();
    }
  });

  it('refuses a loopback address unless it is allowed', async () => {
    const fake = await FakePanel.start();
    const booted = await boot({ SW_PANEL_ALLOW_LOOPBACK: 'false' });
    try {
      const secret = await makeSecret(booted.owner, 'panel token', 'panel_token', fake.token);
      const reply = await connect(booted.owner, fake.url, secret);
      assert.equal(reply.status, 409);
      assert.equal(errorOf(reply).code, 'address_not_allowed');
      assert.equal(fake.requests.length, 0, 'the panel was never asked');
    } finally {
      await stop(booted.instance);
      await fake.close();
    }
  });
});

describe('what reaches the log', { skip: !databaseUrl }, () => {
  it('holds no token, whatever goes wrong', async () => {
    const fake = await FakePanel.start();
    const logs: string[] = [];
    const say =
      (level: string) =>
      (message: unknown, ...rest: unknown[]): void => {
        logs.push(
          `${level} ${[message, ...rest].map((part) => inspect(part, { depth: 6 })).join(' ')}`,
        );
      };
    const collector = {
      log: say('log'),
      warn: say('warn'),
      error: say('error'),
      debug: say('debug'),
      verbose: say('verbose'),
      fatal: say('fatal'),
    };
    const booted = await boot();
    Logger.overrideLogger(collector);
    try {
      const secret = await makeSecret(booted.owner, 'panel token', 'panel_token', fake.token);
      await connect(booted.owner, fake.url, secret);
      fake.inject('/api/nodes', { kind: 'status', status: 500 });
      await booted.owner.get('/panel/nodes?refresh=true');
      fake.clearInjections();
      fake.inject('/api/hosts', { kind: 'raw', body: `{"response":"${fake.token}"}` });
      await booted.owner.get('/panel/hosts?refresh=true');
      fake.clearInjections();
      const original = fake.token;
      fake.setToken('another-token-0000000000000000000000');
      await booted.owner.post('/panel/connection/test');
      await booted.instance.app.get(PanelMonitorService).runOnce();
      fake.setToken(original);
      await booted.instance.app.get(PanelMonitorService).runOnce();
      assert.ok(
        logs.length >= 2,
        'the state changes were logged, so the check looked at something',
      );
      assertClean(
        logs,
        forbiddenTexts([fake.token, 'another-token-0000000000000000000000']),
        'the log',
      );
    } finally {
      Logger.overrideLogger(false);
      await stop(booted.instance);
      await fake.close();
    }
  });
});
