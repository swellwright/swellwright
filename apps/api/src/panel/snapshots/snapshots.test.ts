import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  CreatedTokenSchema,
  PANEL_SNAPSHOT_OBJECT_KINDS,
  PanelSnapshotSummarySchema,
} from '@swellwright/contracts';
import {
  addClient,
  addProfileInbound,
  changeHostAddress,
  changeRuntimeOnly,
  changeTemplateBody,
  FakePanel,
  removeNode,
  rotateRealityKey,
} from '@swellwright/remnawave/test-support';

import {
  auditEvents,
  type Client,
  createUser,
  databaseUrl,
  found,
  type Instance,
  type Reply,
  signInAs,
  stop,
} from '../../test-support.js';
import { assertClean, errorOf, panelEvents, PASSPHRASE } from '../panel-test-support.js';
import { PanelSnapshotsService } from './snapshots.service.js';
import {
  boot,
  type Booted,
  connectTo,
  diffAgainst,
  elevate,
  lapse,
  listSnapshots,
  SEEN,
  snapshotForbidden,
  takeSnapshot,
} from './snapshot-test-support.js';

/** The code of an error answer, for the permission matrix. */
const errorCode = (reply: Reply): string => errorOf(reply).code;

const T0 = Date.parse('2026-06-01T10:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('snapshots of the panel', { skip: !databaseUrl }, () => {
  let fake: FakePanel;
  let booted: Booted;
  let instance: Instance;
  let owner: Client;
  let operator: Client;
  let observer: Client;
  let service: PanelSnapshotsService;
  let now = T0;
  /** Every body a route answered and every file a test downloaded: scanned for secrets at the end. */
  const seen: string[] = [];
  const hostUuid = (): string => String(found(fake.fixtures.hosts[0], 'a host')['uuid']);

  const read = async (client: Client, path: string) => {
    const reply = await client.get(path);
    seen.push(JSON.stringify(reply.body));
    return reply;
  };

  /** Runs something with the vault sealed, and opens it again whatever happens. */
  const whileSealed = async (body: () => Promise<void>): Promise<void> => {
    await elevate(instance, owner, booted.ownerSecret);
    assert.equal((await owner.post('/vault/seal')).status, 200);
    try {
      await body();
    } finally {
      await elevate(instance, owner, booted.ownerSecret);
      const unsealed = await owner.post('/vault/unseal', { passphrase: PASSPHRASE });
      assert.equal(unsealed.status, 200, JSON.stringify(unsealed.body));
    }
  };

  before(async () => {
    fake = await FakePanel.start();
    booted = await boot(fake.token, {}, { snapshotClock: () => now });
    instance = booted.instance;
    owner = booted.owner;
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
    owner = await signInAs(instance, 'owner', booted.ownerSecret);
    service = instance.app.get(PanelSnapshotsService);
  });
  after(async () => {
    await stop(instance);
    await fake.close();
  });

  describe('before anything is connected', () => {
    it('lists nothing, says how the job and the retention are set, and refuses to take one', async () => {
      const list = await listSnapshots(owner);
      assert.deepEqual(list.snapshots, []);
      assert.equal(list.total, 0);
      assert.deepEqual(list.settings, {
        intervalHours: 24,
        keep: 4,
        keepDailyDays: 14,
        scheduling: true,
      });
      const refused = await owner.post('/panel/snapshots', {});
      assert.equal(refused.status, 409);
      assert.equal(errorOf(refused).code, 'panel_not_connected');
      assert.equal(await service.runDue(), 'unconfigured');
    });

    it('answers 404 for a snapshot that does not exist, in every route that takes one', async () => {
      const missing = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
      assert.equal((await owner.get(`/panel/snapshots/${missing}`)).status, 404);
      assert.equal((await owner.get(`/panel/snapshots/${missing}/diff?against=live`)).status, 404);
      assert.equal((await owner.get(`/panel/snapshots/${missing}/export`)).status, 404);
      assert.equal((await owner.call('DELETE', `/panel/snapshots/${missing}`)).status, 404);
      assert.equal((await owner.get('/panel/snapshots/not-a-uuid')).status, 400);
      assert.equal((await owner.get(`/panel/snapshots/${missing}/diff`)).status, 400);
      assert.equal(
        (await owner.get(`/panel/snapshots/${missing}/diff?against=tomorrow`)).status,
        400,
      );
    });
  });

  describe('taking a snapshot', () => {
    let first: Awaited<ReturnType<typeof takeSnapshot>>;

    before(async () => {
      await connectTo(booted, fake.url);
    });

    it('reads every kind from the panel, keeps it masked and compressed, and says what it holds', async () => {
      now += HOUR;
      first = await takeSnapshot(owner, 'first look');
      assert.equal(first.label, 'first look');
      assert.equal(first.kind, 'manual');
      assert.equal(first.createdAt, new Date(now).toISOString());
      assert.equal(first.createdBy?.name, 'owner');
      assert.equal(first.panelVersion, '3.4.11');
      assert.equal(first.panelUrl, fake.url);
      assert.equal(first.complete, true);
      assert.equal(first.objectCount, 21);
      assert.deepEqual(first.counts, {
        nodes: 3,
        hosts: 4,
        configProfiles: 2,
        internalSquads: 2,
        externalSquads: 1,
        subscriptionTemplates: 3,
        subscriptionSettings: 1,
        snippets: 2,
        nodePlugins: 1,
        infraProviders: 1,
        billingNodes: 1,
      });
      for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
        assert.equal(first.coverage[kind], 'ok', kind);
        assert.match(first.kindHashes[kind] ?? '', /^[0-9a-f]{64}$/u, kind);
      }
      assert.match(first.overallHash, /^[0-9a-f]{64}$/u);
      assert.ok(
        first.sizeBytes > 0 && first.sizeBytes < first.rawBytes,
        'the content is compressed',
      );
      assert.equal(first.changesSince, 0);
      assert.equal(first.checkedAt, first.createdAt);
      seen.push(JSON.stringify(first));
    });

    it('is the snapshot that every read route answers with, newest first, paged', async () => {
      const fetched = PanelSnapshotSummarySchema.parse(
        (await read(owner, `/panel/snapshots/${first.id}`)).body,
      );
      assert.deepEqual(fetched, first);
      now += HOUR;
      const second = await takeSnapshot(owner);
      assert.equal(second.label, null);
      assert.equal(second.overallHash, first.overallHash, 'the panel did not change in between');
      const list = await listSnapshots(owner);
      assert.deepEqual(
        list.snapshots.map((s) => s.id),
        [second.id, first.id],
      );
      assert.equal(list.total, 2);
      const page = await listSnapshots(owner, '?limit=1&offset=1');
      assert.deepEqual(
        page.snapshots.map((s) => s.id),
        [first.id],
      );
      assert.equal(page.total, 2);
      assert.equal((await owner.get('/panel/snapshots?limit=0')).status, 400);
      assert.equal((await owner.get('/panel/snapshots?limit=101')).status, 400);
      seen.push(JSON.stringify(list));
    });

    it('records a strict event with the counts and the hash, and nothing of any object', async () => {
      const created = (await panelEvents(instance)).filter(
        (e) => e.action === 'panel.snapshot.created',
      );
      assert.equal(created.length, 2);
      const event = found(created[0], 'the first event');
      assert.equal(event.outcome, 'success');
      assert.equal(event.actor?.name, 'owner');
      assert.equal(event.object?.type, 'panel_snapshot');
      assert.equal(event.object.id, first.id);
      assert.equal(event.details['kind'], 'manual');
      assert.equal(event.details['label'], 'first look');
      assert.equal(event.details['nodes'], 3);
      assert.equal(event.details['config_profiles'], 2);
      assert.equal(event.details['object_count'], 21);
      assert.equal(event.details['complete'], true);
      assert.equal(event.details['overall_hash'], first.overallHash);
      assert.equal(event.details['panel_version'], '3.4.11');
    });

    it('leaves out a kind the token cannot read, says so, and is still a snapshot', async () => {
      fake.forbid('/api/hosts');
      try {
        now += HOUR;
        const partial = await takeSnapshot(owner, 'no hosts');
        assert.equal(partial.complete, false);
        assert.equal(partial.coverage.hosts, 'denied');
        assert.equal(partial.coverage.nodes, 'ok');
        assert.equal(partial.counts.hosts, 0);
        assert.equal(partial.kindHashes.hosts, undefined);
        assert.equal(partial.objectCount, 17);
        assert.notEqual(partial.overallHash, first.overallHash);
        // It compares with a complete one, on the kinds that both hold.
        const result = await diffAgainst(owner, first.id, partial.id);
        assert.equal(result.identical, true);
        assert.deepEqual(result.notes, [{ code: 'kind_not_covered', kinds: ['hosts'] }]);
        await owner.call('DELETE', `/panel/snapshots/${partial.id}`);
      } finally {
        fake.clearInjections();
      }
    });

    it('leaves out a kind the panel answers in a shape it does not know', async () => {
      fake.inject('/api/snippets', { kind: 'replace', body: { response: { snippets: 'nope' } } });
      try {
        now += HOUR;
        const partial = await takeSnapshot(owner);
        assert.equal(partial.coverage.snippets, 'failed');
        assert.equal(partial.counts.snippets, 0);
        await owner.call('DELETE', `/panel/snapshots/${partial.id}`);
      } finally {
        fake.clearInjections();
      }
    });

    it('refuses when the token cannot read anything', async () => {
      fake.forbid(
        '/api/nodes',
        '/api/hosts',
        '/api/config-profiles',
        '/api/internal-squads',
        '/api/external-squads',
        '/api/subscription-templates',
        '/api/subscription-settings',
        '/api/snippets',
        '/api/node-plugins',
        '/api/infra-billing/providers',
        '/api/infra-billing/nodes',
      );
      try {
        const reply = await owner.post('/panel/snapshots', {});
        assert.equal(reply.status, 502);
        assert.equal(errorOf(reply).code, 'panel_forbidden');
      } finally {
        fake.clearInjections();
      }
    });

    it('answers with the code of what went wrong with the panel, and stores nothing', async () => {
      const total = (await listSnapshots(owner)).total;
      const trouble: [string, () => void, number, string][] = [
        [
          'the panel is down',
          () => {
            fake.inject('/api/system/metadata', { kind: 'status', status: 503 });
          },
          502,
          'panel_unreachable',
        ],
        [
          'the panel answers in a shape nobody knows',
          () => {
            fake.inject('/api/system/metadata', {
              kind: 'replace',
              body: { response: { nope: 1 } },
            });
          },
          502,
          'panel_contract_changed',
        ],
        [
          'the panel runs another version',
          () => {
            fake.setVersion('3.9.0');
          },
          409,
          'panel_unsupported_version',
        ],
      ];
      for (const [what, arrange, status, code] of trouble) {
        arrange();
        try {
          const reply = await owner.post('/panel/snapshots', {});
          assert.equal(reply.status, status, `${what}: ${JSON.stringify(reply.body)}`);
          assert.equal(errorOf(reply).code, code, what);
        } finally {
          fake.clearInjections();
          fake.setVersion('3.4.11');
          // The state follows what reads found: put it back for the next one.
          assert.equal((await owner.post('/panel/connection/test')).status, 200);
        }
      }
      assert.equal((await listSnapshots(owner)).total, total);
    });

    it('answers 401 from the panel as panel_unauthorized, then works again with the token back', async () => {
      const original = fake.token;
      fake.setToken('the-panel-now-wants-another-token-0000000000');
      try {
        const reply = await owner.post('/panel/snapshots', {});
        assert.equal(reply.status, 502);
        assert.equal(errorOf(reply).code, 'panel_unauthorized');
      } finally {
        fake.setToken(original);
        assert.equal((await owner.post('/panel/connection/test')).status, 200);
      }
    });

    it('answers 423 while the vault is sealed', async () => {
      await whileSealed(async () => {
        const reply = await owner.post('/panel/snapshots', {});
        assert.equal(reply.status, 423, JSON.stringify(reply.body));
        // Reading what is stored needs no token.
        assert.equal((await owner.get('/panel/snapshots')).status, 200);
        assert.equal((await owner.get(`/panel/snapshots/${first.id}/export`)).status, 200);
        // What the server remembers of the panel needs no token; asking the panel again does.
        const diff = await owner.get(`/panel/snapshots/${first.id}/diff?against=live&refresh=true`);
        assert.equal(diff.status, 423, JSON.stringify(diff.body));
      });
    });

    it('limits the length of a label', async () => {
      assert.equal((await owner.post('/panel/snapshots', { label: 'x'.repeat(101) })).status, 400);
      assert.equal((await owner.post('/panel/snapshots', { label: '   ' })).status, 400);
    });
  });

  describe('exporting', () => {
    it('is a file of masked JSON that names the snapshot, with every object and its hash', async () => {
      const id = found((await listSnapshots(owner)).snapshots.at(-1), 'the oldest').id;
      const reply = await owner.get(`/panel/snapshots/${id}/export`);
      assert.equal(reply.status, 200);
      assert.match(
        reply.headers.get('content-disposition') ?? '',
        /^attachment; filename="swellwright-panel-snapshot-2026-06-01-[0-9a-f]{8}\.json"$/u,
      );
      assert.match(reply.headers.get('content-type') ?? '', /^application\/json/u);
      const body = reply.body as {
        format: string;
        version: number;
        masked: boolean;
        snapshot: { id: string };
        kinds: Record<string, { id: string; hash: string; config: unknown }[]>;
      };
      seen.push(JSON.stringify(body));
      assert.equal(body.format, 'swellwright.panel-snapshot');
      assert.equal(body.version, 1);
      assert.equal(body.masked, true);
      assert.equal(body.snapshot.id, id);
      assert.equal(body.kinds['nodes']?.length, 3);
      for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
        for (const item of body.kinds[kind] ?? []) {
          assert.match(item.hash, /^[0-9a-f]{64}$/u);
          assert.ok(item.config !== undefined);
        }
      }
      assert.match(JSON.stringify(body), /\[masked:[0-9a-f]{8}\]/u);
    });
  });

  describe('comparing', () => {
    let base: Awaited<ReturnType<typeof takeSnapshot>>;

    before(async () => {
      now += HOUR;
      base = await takeSnapshot(owner, 'base');
    });

    it('says "no differences" as a result when the panel is as it was, and keeps it as the answer to "since"', async () => {
      const result = await diffAgainst(owner, base.id, 'live', '&refresh=true');
      assert.equal(result.identical, true);
      assert.deepEqual(result.objects, []);
      assert.equal(result.to.type, 'live');
      assert.equal(result.to.overallHash, base.overallHash);
      assert.deepEqual(result.summary.objects, { added: 0, removed: 0, changed: 0, unchanged: 21 });
      assert.equal(result.from.id, base.id);
      // The same snapshot against itself is as plain.
      const itself = await diffAgainst(owner, base.id, base.id);
      assert.equal(itself.identical, true);
      assert.equal(itself.to.type, 'snapshot');
    });

    it('finds what was edited in the panel, and counts what it keeps out as unchanged', async () => {
      changeHostAddress(fake.fixtures, 0, '192.0.2.250');
      const profile = addProfileInbound(fake.fixtures, 0, 'LATE_INBOUND', 9101);
      const nodeUuid = removeNode(fake.fixtures, 2);
      changeTemplateBody(fake.fixtures, 0, 22808);
      rotateRealityKey(fake.fixtures);
      addClient(fake.fixtures);
      changeRuntimeOnly(fake.fixtures);
      const result = await diffAgainst(owner, base.id, 'live', '&refresh=true');
      seen.push(JSON.stringify(result));
      assert.equal(result.identical, false);
      const byKind = (kind: string) => result.objects.filter((o) => o.kind === kind);
      assert.deepEqual(
        byKind('hosts').map((o) => [o.id, o.status]),
        [[hostUuid(), 'changed']],
      );
      assert.deepEqual(byKind('hosts')[0]?.changes, [
        { path: 'address', op: 'changed', before: '192.0.2.11', after: '192.0.2.250' },
      ]);
      assert.deepEqual(
        byKind('nodes').map((o) => [o.id, o.status]),
        [[nodeUuid, 'removed']],
      );
      assert.equal(byKind('subscriptionTemplates').length, 1);
      assert.equal(byKind('subscriptionTemplates')[0]?.status, 'changed');
      const changedProfile = found(byKind('configProfiles')[0], 'the changed profile');
      assert.equal(changedProfile.status, 'changed');
      const paths = changedProfile.changes.map((c) => c.path);
      assert.ok(paths.includes('config.inbounds[tag=LATE_INBOUND]'), paths.join(', '));
      // The rotated key shows as a masked change, with fingerprints and never a value.
      const rotated = changedProfile.changes.filter((c) => c.masked === true && c.hidden !== true);
      assert.ok(rotated.length >= 1);
      for (const change of rotated) {
        assert.match(String(change.before), /^\[masked:[0-9a-f]{8}\]$/u);
        assert.match(String(change.after), /^\[masked:[0-9a-f]{8}\]$/u);
      }
      // The new client is counted and nothing else of it is shown.
      const clients = changedProfile.changes.find((c) => c.hidden === true);
      assert.deepEqual([clients?.before, clients?.after], [{ items: 1 }, { items: 2 }]);
      // Nothing is left over from what only the runtime did: no node is listed as changed.
      assert.equal(byKind('nodes').filter((o) => o.status === 'changed').length, 0);
      assert.deepEqual(result.summary.objects, { added: 0, removed: 1, changed: 3, unchanged: 17 });
      assert.deepEqual(result.summary.byKind.hosts, {
        added: 0,
        removed: 0,
        changed: 1,
        unchanged: 3,
      });
      assert.ok(result.summary.fieldChanges >= 5);
      assert.ok(profile.length > 0, 'the inbound that was added has an id');
    });

    it('keeps the answer to "what changed since" on the snapshot, for the overview', async () => {
      const row = (await listSnapshots(owner)).snapshots.find((s) => s.id === base.id);
      assert.equal(row?.changesSince, 4);
      assert.ok(row.checkedAt !== null);
    });

    it('answers from the memory of the server unless it is told to ask the panel again', async () => {
      const before = fake.countRequests('/api/nodes');
      // The previous request read the panel (refresh), so this one is answered from memory.
      await diffAgainst(owner, base.id, 'live');
      assert.equal(fake.countRequests('/api/nodes'), before);
      await diffAgainst(owner, base.id, 'live', '&refresh=true');
      assert.equal(fake.countRequests('/api/nodes'), before + 1);
    });

    it('compares two snapshots without asking the panel, in either direction', async () => {
      now += HOUR;
      const later = await takeSnapshot(owner, 'after the edits');
      const requests = fake.requests.length;
      const forward = await diffAgainst(owner, base.id, later.id);
      const backward = await diffAgainst(owner, later.id, base.id);
      assert.equal(fake.requests.length, requests, 'the panel was not asked');
      assert.equal(forward.to.id, later.id);
      assert.equal(forward.summary.objects.removed, backward.summary.objects.added);
      assert.equal(forward.summary.objects.changed, backward.summary.objects.changed);
      assert.equal(forward.summary.objects.changed, 3);
      const listed = await diffAgainst(owner, base.id, later.id, '&includeUnchanged=true');
      const { added, removed, changed, unchanged } = listed.summary.objects;
      assert.equal(listed.objects.length, added + removed + changed + unchanged);
      assert.ok(listed.objects.some((o) => o.status === 'unchanged'));
      // And the new snapshot is the same as the panel now.
      const now2 = await diffAgainst(owner, later.id, 'live', '&refresh=true');
      assert.equal(now2.identical, true);
    });

    it('tells that the panel was updated between the two', async () => {
      fake.setVersion('3.4.12');
      try {
        now += HOUR;
        const updated = await takeSnapshot(owner, 'updated panel');
        const result = await diffAgainst(owner, base.id, updated.id);
        assert.ok(result.notes.some((n) => n.code === 'panel_version_differs'));
        await owner.call('DELETE', `/panel/snapshots/${updated.id}`);
      } finally {
        fake.setVersion('3.4.11');
      }
    });

    it('refuses to compare with a panel it is not a snapshot of', async () => {
      const other = await instance.isolated.database.client.panelSnapshot.create({
        data: {
          panelUrl: 'https://other-panel.example.com',
          kind: 'manual',
          counts: {},
          coverage: {},
          objectCount: 0,
          overallHash: '0'.repeat(64),
          kindHashes: {},
          maskKeyId: 'abc',
          rawBytes: 0,
          sizeBytes: 0,
        },
      });
      for (const path of [
        `/panel/snapshots/${other.id}/diff?against=live`,
        `/panel/snapshots/${base.id}/diff?against=${other.id}`,
      ]) {
        const reply = await owner.get(path);
        assert.equal(reply.status, 409, path);
        assert.equal(errorOf(reply).code, 'snapshot_other_panel');
      }
      // It is not in the list of the connected panel, but it is not lost.
      assert.ok(!(await listSnapshots(owner)).snapshots.some((s) => s.id === other.id));
      await instance.isolated.database.client.panelSnapshot.delete({ where: { id: other.id } });
    });
  });

  describe('who may do what', () => {
    it('lets a role that may only read list, read, compare and export, and not take or delete', async () => {
      const id = found((await listSnapshots(observer)).snapshots[0], 'a snapshot').id;
      assert.equal((await observer.get(`/panel/snapshots/${id}`)).status, 200);
      assert.equal((await observer.get(`/panel/snapshots/${id}/diff?against=live`)).status, 200);
      assert.equal((await observer.get(`/panel/snapshots/${id}/export`)).status, 200);
      const create = await observer.post('/panel/snapshots', {});
      assert.equal(create.status, 403);
      assert.equal(errorCode(create), 'forbidden');
      const remove = await observer.call('DELETE', `/panel/snapshots/${id}`);
      assert.equal(remove.status, 403);
      assert.equal(errorCode(remove), 'forbidden');
      assert.equal(
        (await listSnapshots(owner)).snapshots.some((s) => s.id === id),
        true,
      );
    });

    it('lets an operator take one, and asks for a fresh code to delete', async () => {
      now += HOUR;
      const taken = await takeSnapshot(operator, 'by the operator');
      assert.equal(taken.createdBy?.name, 'ops');
      await lapse(instance);
      const stale = await operator.call('DELETE', `/panel/snapshots/${taken.id}`);
      assert.equal(stale.status, 403);
      assert.equal(errorCode(stale), 'step_up_required');
      assert.equal(
        (await owner.get(`/panel/snapshots/${taken.id}`)).status,
        200,
        'it is still there',
      );
    });

    it('may be read with an API token that has panel:read, and cannot be taken or deleted with one', async () => {
      await elevate(instance, owner, booted.ownerSecret);
      const created = CreatedTokenSchema.parse(
        (await owner.post('/tokens', { name: 'snapshots', permissions: ['panel:read'] })).body,
      );
      const headers = { authorization: `Bearer ${created.token}` };
      const cli = instance.client();
      const list = await cli.call('GET', '/panel/snapshots', undefined, headers);
      assert.equal(list.status, 200);
      const id = found((await listSnapshots(owner)).snapshots[0], 'a snapshot').id;
      assert.equal(
        (await cli.call('GET', `/panel/snapshots/${id}/diff?against=live`, undefined, headers))
          .status,
        200,
      );
      assert.equal(
        (await cli.call('GET', `/panel/snapshots/${id}/export`, undefined, headers)).status,
        200,
      );
      assert.equal((await cli.call('POST', '/panel/snapshots', {}, headers)).status, 401);
      assert.equal(
        (await cli.call('DELETE', `/panel/snapshots/${id}`, undefined, headers)).status,
        401,
      );
    });
  });

  describe('deleting', () => {
    it('removes the snapshot and its content, and says who did it', async () => {
      await elevate(instance, owner, booted.ownerSecret);
      now += HOUR;
      const doomed = await takeSnapshot(owner, 'doomed');
      const db = instance.isolated.database.client;
      assert.equal(await db.panelSnapshotContent.count({ where: { snapshotId: doomed.id } }), 1);
      const reply = await owner.call('DELETE', `/panel/snapshots/${doomed.id}`);
      assert.equal(reply.status, 204);
      assert.equal(await db.panelSnapshotContent.count({ where: { snapshotId: doomed.id } }), 0);
      assert.equal((await owner.get(`/panel/snapshots/${doomed.id}`)).status, 404);
      const deleted = (await panelEvents(instance)).filter(
        (e) => e.action === 'panel.snapshot.deleted' && e.object?.id === doomed.id,
      );
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0]?.actor?.name, 'owner');
      assert.equal(deleted[0].details['reason'], 'user');
      assert.equal((await owner.call('DELETE', `/panel/snapshots/${doomed.id}`)).status, 404);
    });

    it('keeps the history when the connection is replaced, and shows all of it while nothing is connected', async () => {
      const total = (await listSnapshots(owner)).total;
      assert.ok(total > 0);
      await elevate(instance, owner, booted.ownerSecret);
      // The same panel again (a rotated token would do the same): the snapshots stay.
      await connectTo(booted, fake.url);
      assert.equal((await listSnapshots(owner)).total, total);
      assert.equal((await owner.call('DELETE', '/panel/connection')).status, 204);
      assert.equal((await listSnapshots(owner)).total, total);
      assert.equal((await owner.post('/panel/snapshots', {})).status, 409);
      await connectTo(booted, fake.url);
    });
  });

  describe('when the stored content is damaged', () => {
    it('says so, and does not compare or export what it cannot trust', async () => {
      const db = instance.isolated.database.client;
      const victim = found((await listSnapshots(owner)).snapshots[0], 'a snapshot');
      const stored = await db.panelSnapshotContent.findUnique({ where: { snapshotId: victim.id } });
      assert.ok(stored, 'the content of the snapshot is stored');
      const damaged = Buffer.from(stored.data);
      damaged[damaged.length - 12] = (damaged[damaged.length - 12] ?? 0) ^ 0xff;
      await db.panelSnapshotContent.update({
        where: { snapshotId: victim.id },
        data: { data: new Uint8Array(damaged) },
      });
      try {
        for (const path of [
          `/panel/snapshots/${victim.id}/export`,
          `/panel/snapshots/${victim.id}/diff?against=live`,
        ]) {
          const reply = await owner.get(path);
          assert.equal(reply.status, 409, path);
          assert.equal(errorOf(reply).code, 'snapshot_corrupt');
        }
        // The summary does not need the content.
        assert.equal((await owner.get(`/panel/snapshots/${victim.id}`)).status, 200);
      } finally {
        await db.panelSnapshotContent.update({
          where: { snapshotId: victim.id },
          data: { data: new Uint8Array(stored.data) },
        });
      }
      assert.equal((await owner.get(`/panel/snapshots/${victim.id}/export`)).status, 200);
    });
  });

  describe('retention', () => {
    it('keeps the newest ones, the newest of each of the last 14 days, and an anchor of a change', async () => {
      const db = instance.isolated.database.client;
      // Start from nothing, with an old anchor that must survive.
      await db.panelSnapshot.deleteMany();
      const anchor = await db.panelSnapshot.create({
        data: {
          panelUrl: fake.url,
          kind: 'before_change',
          createdAt: new Date(T0 - 400 * DAY),
          counts: {},
          coverage: {},
          objectCount: 0,
          overallHash: '1'.repeat(64),
          kindHashes: {},
          maskKeyId: 'abc',
          rawBytes: 0,
          sizeBytes: 0,
        },
      });
      now = T0 + 100 * DAY;
      // Six snapshots in one day: only the newest four stay (KEEP is 4), and the newest of the day is one of them.
      for (let i = 0; i < 6; i += 1) {
        now += HOUR;
        await takeSnapshot(owner, `same day ${String(i)}`);
      }
      let rows = await listSnapshots(owner);
      assert.equal(rows.total, 5, 'four and the anchor... the anchor is of the same panel');
      assert.deepEqual(
        rows.snapshots.map((s) => s.label),
        ['same day 5', 'same day 4', 'same day 3', 'same day 2', null],
      );
      assert.equal(rows.snapshots.at(-1)?.id, anchor.id);
      // Twenty days, one snapshot a day: the last fourteen days stay, the older ones go.
      for (let day = 1; day <= 20; day += 1) {
        now += DAY;
        await takeSnapshot(owner, `day ${String(day)}`);
      }
      rows = await listSnapshots(owner, '?limit=100');
      const labels = rows.snapshots.map((s) => s.label);
      for (let day = 7; day <= 20; day += 1) {
        assert.ok(labels.includes(`day ${String(day)}`), `day ${String(day)} is kept`);
      }
      for (let day = 1; day <= 6; day += 1) {
        assert.ok(!labels.includes(`day ${String(day)}`), `day ${String(day)} is removed`);
      }
      assert.ok(
        !labels.includes('same day 2'),
        'what was beyond the count and older than 14 days is removed',
      );
      assert.ok(
        rows.snapshots.some((s) => s.id === anchor.id),
        'the anchor of a change is never removed',
      );
      const removals = (await panelEvents(instance)).filter(
        (e) => e.action === 'panel.snapshot.deleted' && e.details['reason'] === 'retention',
      );
      assert.ok(removals.length >= 8);
      for (const event of removals) {
        assert.equal(event.actor, null);
        assert.equal(event.outcome, 'success');
      }
    });
  });

  describe('the background job', () => {
    before(async () => {
      await instance.isolated.database.client.panelSnapshot.deleteMany();
    });

    it('takes a snapshot when none was taken, as nobody, and is not due again at once', async () => {
      now = T0 + 300 * DAY;
      assert.equal(await service.runDue(), 'created');
      const [first] = (await listSnapshots(owner)).snapshots;
      assert.equal(first?.kind, 'scheduled');
      assert.equal(first.createdBy, null);
      assert.equal(first.label, null);
      const event = found(
        (await panelEvents(instance)).filter((e) => e.action === 'panel.snapshot.created').at(-1),
        'the event',
      );
      assert.equal(event.actor, null);
      assert.equal(event.details['kind'], 'scheduled');
      assert.equal(await service.runDue(), 'not_due');
      now += 23 * HOUR;
      assert.equal(await service.runDue(), 'not_due');
    });

    it('does not take another when the panel did not change, and says it was checked', async () => {
      const before = await listSnapshots(owner);
      const events = (await auditEvents(instance)).length;
      now += 2 * HOUR;
      assert.equal(await service.runDue(), 'unchanged');
      const after = await listSnapshots(owner);
      assert.equal(after.total, before.total, 'no new row');
      const latest = found(after.snapshots[0], 'the latest');
      assert.equal(latest.checkedAt, new Date(now).toISOString());
      assert.equal(latest.changesSince, 0);
      assert.equal(
        (await auditEvents(instance)).length,
        events,
        'nothing is recorded for a panel that is the same',
      );
      // The check counts as a look at the panel: the next one is due an interval later.
      now += 23 * HOUR;
      assert.equal(await service.runDue(), 'not_due');
    });

    it('takes a new one when the panel changed', async () => {
      changeHostAddress(fake.fixtures, 1, '192.0.2.251');
      now += 2 * HOUR;
      assert.equal(await service.runDue(), 'created');
      const list = await listSnapshots(owner);
      assert.equal(list.total, 2);
      const [latest, previous] = list.snapshots;
      assert.notEqual(latest?.overallHash, previous?.overallHash);
      assert.equal(latest?.kind, 'scheduled');
      const result = await diffAgainst(
        owner,
        found(previous, 'previous').id,
        found(latest, 'latest').id,
      );
      assert.equal(result.summary.objects.changed, 1);
    });

    it('does nothing while the vault is sealed, and does not break', async () => {
      await whileSealed(async () => {
        now += 2 * DAY;
        assert.equal(await service.runDue(), 'sealed');
      });
      assert.equal(await service.runDue(), 'unchanged');
    });

    it('does not break when the panel does not answer, and takes the next round', async () => {
      fake.inject('/api/system/metadata', { kind: 'status', status: 503 });
      try {
        now += 2 * DAY;
        assert.equal(await service.runDue(), 'failed');
      } finally {
        fake.clearInjections();
        assert.equal((await owner.post('/panel/connection/test')).status, 200);
      }
      assert.equal(await service.runDue(), 'unchanged');
    });
  });

  describe('at the end', () => {
    it('has not let a secret into any answer, file or record of the audit chain', async () => {
      const forbidden = snapshotForbidden([fake.token]);
      assertClean([...seen, ...SEEN], forbidden, 'a response');
      assertClean(
        (await auditEvents(instance)).map((event) => JSON.stringify(event)),
        forbidden,
        'a record of the audit chain',
      );
      assert.ok(seen.length + SEEN.length > 20, 'a good many answers were scanned');
    });
  });
});
