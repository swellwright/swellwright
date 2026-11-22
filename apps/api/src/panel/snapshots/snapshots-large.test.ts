import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { FakePanel, must } from '@swellwright/remnawave/test-support';

import { databaseUrl, type Instance, stop } from '../../test-support.js';
import { assertClean, errorOf } from '../panel-test-support.js';
import {
  boot,
  type Booted,
  connectTo,
  diffAgainst,
  listSnapshots,
  snapshotForbidden,
  takeSnapshot,
} from './snapshot-test-support.js';

describe('snapshots of a large panel', { skip: !databaseUrl }, () => {
  let fake: FakePanel;
  let booted: Booted;
  let instance: Instance;

  before(async () => {
    // 800 extra nodes and 800 extra hosts on top of the few that the fixtures have.
    fake = await FakePanel.start({ extraNodes: 800, extraHosts: 800 });
    booted = await boot(fake.token, { SW_PANEL_SNAPSHOT_INTERVAL_HOURS: '0' });
    instance = booted.instance;
    await connectTo(booted, fake.url);
  });
  after(async () => {
    await stop(instance);
    await fake.close();
  });

  it('is taken, kept compressed and compared in a moment, and finds the one node that changed', async () => {
    const started = Date.now();
    const snapshot = await takeSnapshot(booted.owner, 'large');
    assert.equal(snapshot.counts.nodes, 803);
    assert.equal(snapshot.counts.hosts, 804);
    assert.equal(snapshot.complete, true);
    assert.ok(
      snapshot.rawBytes > 500_000,
      `a large panel is a large snapshot (${String(snapshot.rawBytes)} bytes)`,
    );
    assert.ok(snapshot.sizeBytes < snapshot.rawBytes / 4, 'and it compresses well');

    const same = await diffAgainst(booted.owner, snapshot.id, 'live', '&refresh=true');
    assert.equal(same.identical, true);
    assert.equal(same.summary.objects.unchanged, snapshot.objectCount);

    const node = must(fake.fixtures.nodes[600]);
    node['address'] = '203.0.113.99';
    const host = must(fake.fixtures.hosts[700]);
    host['port'] = 8443;
    const changed = await diffAgainst(booted.owner, snapshot.id, 'live', '&refresh=true');
    assert.equal(changed.summary.objects.changed, 2);
    assert.deepEqual(changed.objects.map((o) => [o.kind, o.id]).sort(), [
      ['hosts', host['uuid']],
      ['nodes', node['uuid']],
    ]);
    assert.ok(
      Date.now() - started < 60_000,
      'a large panel is read, stored and compared in a moment',
    );

    const list = await listSnapshots(booted.owner);
    assert.equal(list.total, 1);
    assertClean(
      [JSON.stringify(changed), JSON.stringify(list)],
      snapshotForbidden([fake.token]),
      'a response about a large panel',
    );
  });
});

describe('the size limit of a snapshot', { skip: !databaseUrl }, () => {
  let fake: FakePanel;
  let booted: Booted;
  let instance: Instance;

  before(async () => {
    fake = await FakePanel.start({ extraNodes: 800, extraHosts: 3000 });
    booted = await boot(fake.token, {
      SW_PANEL_SNAPSHOT_INTERVAL_HOURS: '0',
      SW_PANEL_SNAPSHOT_MAX_MIB: '1',
    });
    instance = booted.instance;
    await connectTo(booted, fake.url);
  });
  after(async () => {
    await stop(instance);
    await fake.close();
  });

  it('refuses a snapshot that would hold more than the limit, says how much, and stores nothing', async () => {
    const reply = await booted.owner.post('/panel/snapshots', {});
    assert.equal(reply.status, 413, JSON.stringify(reply.body));
    const error = errorOf(reply);
    assert.equal(error.code, 'snapshot_too_large');
    assert.match(error.message, /limit is 1\.0 MiB/u);
    assert.equal((await listSnapshots(booted.owner)).total, 0);
    assert.equal(await instance.isolated.database.client.panelSnapshotContent.count(), 0);
    assert.equal(
      await instance.isolated.database.client.auditEvent.count({
        where: { action: 'panel.snapshot.created' },
      }),
      0,
      'nothing is recorded for a snapshot that was not taken',
    );
  });
});
