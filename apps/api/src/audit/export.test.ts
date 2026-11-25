import 'reflect-metadata';

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  AUDIT_EXPORT_FORMAT,
  AuditCheckpointSchema,
  AuditCheckpointVerificationSchema,
  AuditExportSchema,
} from '@swellwright/contracts';

import { auditVerify } from '../admin.js';
import {
  AUTH_KEY,
  auditEvents,
  type Client,
  codeFor,
  createOwner,
  createUser,
  databaseUrl,
  errorCode,
  forgetLastStep,
  found,
  type Instance,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { chainHash } from './chain.js';
import {
  checkpointKey,
  checkpointSignatureValid,
  makeCheckpoint,
  parseCheckpoint,
} from './checkpoint.js';
import { findEventHash, verifyExportText } from './export-file.js';

const INSTANCE_KEY = Buffer.from(AUTH_KEY, 'base64');

/** The file an export makes: the header line and one event per line, from every page. */
async function download(
  client: Client,
  pageSize: number,
): Promise<{ text: string; pages: number; head: number | null }> {
  const lines = [JSON.stringify({ format: AUDIT_EXPORT_FORMAT, version: 1 })];
  let from = 1;
  let through: number | undefined;
  for (let pages = 1; ; pages += 1) {
    const bound = through === undefined ? '' : `&through=${String(through)}`;
    const reply = await client.get(
      `/audit/export?from=${String(from)}&limit=${String(pageSize)}${bound}`,
    );
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const page = AuditExportSchema.parse(reply.body);
    // Every continuation is bounded by the head the first page saw.
    through ??= page.head?.seq;
    lines.push(...page.events.map((e) => JSON.stringify(e)));
    if (page.nextFrom === null) {
      return { text: `${lines.join('\n')}\n`, pages, head: through ?? null };
    }
    assert.ok(page.nextFrom > from, 'the export advances');
    from = page.nextFrom;
  }
}

/** The file of an export, as `download` makes it. */
async function downloadText(client: Client, pageSize: number): Promise<string> {
  return (await download(client, pageSize)).text;
}

describe('checkpoints', () => {
  const key = checkpointKey(INSTANCE_KEY);
  const head = { seq: 42, hash: 'ab'.repeat(32) };
  const at = new Date('2026-11-19T10:00:00.000Z');

  it('are made and read back, and only this instance can sign them', () => {
    const text = makeCheckpoint(key, head, at);
    assert.match(text, /^swa1\.42\.[0-9a-f]{64}\.\d+\.[A-Za-z0-9_-]{43}$/u);
    const parsed = found(parseCheckpoint(text) ?? undefined, 'the checkpoint');
    assert.equal(parsed.seq, 42);
    assert.equal(parsed.hash, head.hash);
    assert.equal(parsed.issuedAt.getTime(), at.getTime());
    assert.equal(checkpointSignatureValid(key, parsed), true);
    assert.equal(checkpointSignatureValid(checkpointKey(Buffer.alloc(32, 9)), parsed), false);
  });

  it('cannot be changed: not the number, not the hash, not the time', () => {
    const [prefix, seq, hash, time, signature] = makeCheckpoint(key, head, at).split('.');
    const altered = [
      [prefix, '43', hash, time, signature],
      [prefix, seq, 'cd'.repeat(32), time, signature],
      [prefix, seq, hash, String(at.getTime() + 1000), signature],
    ];
    for (const parts of altered) {
      const parsed = found(parseCheckpoint(parts.join('.')) ?? undefined, 'altered checkpoint');
      assert.equal(checkpointSignatureValid(key, parsed), false, parts.join('.'));
    }
  });

  it('are refused when they are not checkpoints', () => {
    const good = makeCheckpoint(key, head, at);
    const zero = `swa1.0.${'a'.repeat(64)}.1700000000000.${'A'.repeat(43)}`;
    for (const bad of ['', 'swa1', 'swa2.1.x.1.y', zero, `${good}.extra`]) {
      assert.equal(parseCheckpoint(bad), null, bad);
    }
  });
});

describe('exporting and checking the audit log', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let ownerSecret: string;
  let observerSecret: string;
  let auditorSecret: string;

  const db = () => instance.isolated.database.client;
  const table = () => `"${instance.isolated.schema}"."audit_events"`;
  const withoutTrigger = async (work: () => Promise<void>): Promise<void> => {
    await db().$executeRawUnsafe(
      `ALTER TABLE ${table()} DISABLE TRIGGER "audit_events_append_only"`,
    );
    try {
      await work();
    } finally {
      await db().$executeRawUnsafe(
        `ALTER TABLE ${table()} ENABLE TRIGGER "audit_events_append_only"`,
      );
    }
  };
  const checkpoint = async () =>
    AuditCheckpointSchema.parse((await owner.post('/audit/checkpoints')).body);
  const verifyCheckpoint = async (text: string) =>
    AuditCheckpointVerificationSchema.parse(
      (await owner.post('/audit/checkpoints/verify', { checkpoint: text })).body,
    );

  before(async () => {
    instance = await start();
    ({ secret: ownerSecret } = await createOwner(instance));
    ({ secret: observerSecret } = await createUser(instance, 'observer', 'observer'));
    ({ secret: auditorSecret } = await createUser(instance, 'auditor', 'auditor'));
    await createUser(instance, 'someone', 'operator');
    owner = await signInAs(instance, 'owner', ownerSecret);
  });
  after(async () => {
    await stop(instance);
  });

  it('needs the permission and a fresh second factor', async () => {
    const observer = await signInAs(instance, 'observer', observerSecret);
    const denied = await observer.get('/audit/export');
    assert.equal(denied.status, 403);
    assert.equal(errorCode(denied), 'forbidden');
    const auditor = await signInAs(instance, 'auditor', auditorSecret);
    assert.equal((await auditor.get('/audit/export')).status, 200, 'the auditor may export');

    await db().session.updateMany({ data: { elevatedUntil: new Date(Date.now() - 1000) } });
    const needsCode = await owner.get('/audit/export');
    assert.equal(needsCode.status, 403);
    assert.equal(errorCode(needsCode), 'step_up_required');
    await forgetLastStep(instance);
    assert.equal((await owner.post('/auth/step-up', { code: codeFor(ownerSecret) })).status, 200);
    assert.equal((await owner.get('/audit/export')).status, 200);
  });

  it('hands over every event with its hashes, in order, page by page', async () => {
    const all = await auditEvents(instance);
    const first = AuditExportSchema.parse((await owner.get('/audit/export?limit=3')).body);
    assert.equal(first.format, 'swellwright-audit-export');
    assert.deepEqual(first.events, all.slice(0, 3));
    assert.equal(first.nextFrom, 4);
    assert.ok(first.head);

    const lines = (await downloadText(owner, 4)).trim().split('\n');
    const exported = lines.slice(1).map((l) => (JSON.parse(l) as { seq: number }).seq);
    assert.deepEqual(
      exported,
      exported.map((_, i) => i + 1),
      'no gaps and no repeats across pages',
    );
    assert.ok(exported.length >= all.length);

    // A page past the end is empty, not an error; a limit outside the bounds is refused.
    const past = AuditExportSchema.parse((await owner.get('/audit/export?from=99999')).body);
    assert.deepEqual(past.events, []);
    assert.equal(past.nextFrom, null);
    assert.equal((await owner.get('/audit/export?limit=0')).status, 400);
    assert.equal((await owner.get('/audit/export?limit=5001')).status, 400);

    // Every page is recorded, with where it started and how many events it carried, and nothing of the content.
    const records = (await auditEvents(instance)).filter((e) => e.action === 'audit.exported');
    assert.ok(records.length >= 5);
    const record = found(records.at(-1), 'the last record');
    assert.equal(typeof record.details['from'], 'number');
    assert.equal(typeof record.details['count'], 'number');
    assert.equal(record.actor?.name, 'owner');
  });

  it('ends at the head of its first page, even one event per page while events keep coming', async () => {
    const exported = () =>
      auditEvents(instance).then((all) => all.filter((e) => e.action === 'audit.exported').length);
    const before = await exported();
    const { text, pages, head } = await download(owner, 1);
    const seqs = text
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    assert.ok(head !== null);
    assert.deepEqual(
      seqs,
      Array.from({ length: head }, (_, i) => i + 1),
      'exactly the events up to the first head, none of those written while it ran',
    );
    assert.equal(pages, head);
    assert.equal((await exported()) - before, pages, 'one record per page');
    assert.equal(verifyExportText(text).ok, true);

    // A continuation past its own head is empty, and a head that is not in the log is refused.
    const past = AuditExportSchema.parse(
      (await owner.get(`/audit/export?from=${String(head + 1)}&through=${String(head)}`)).body,
    );
    assert.deepEqual(past.events, []);
    assert.equal(past.nextFrom, null);
    assert.equal(past.head?.seq, head);
    const bounded = AuditExportSchema.parse(
      (await owner.get(`/audit/export?from=2&limit=2&through=3`)).body,
    );
    assert.deepEqual(
      bounded.events.map((e) => e.seq),
      [2, 3],
    );
    assert.equal(bounded.nextFrom, null);
    assert.equal(bounded.head?.seq, 3);
    for (const bad of ['through=0', 'through=-1', 'through=x', 'through=99999999']) {
      const reply = await owner.get(`/audit/export?${bad}`);
      assert.equal(reply.status, 400, bad);
    }
  });

  it('can be checked offline, and a file that was changed is found', async () => {
    const text = await downloadText(owner, 50);
    const result = verifyExportText(text);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.error, null);
    assert.equal(result.first, 1);
    assert.ok(result.checked > 5);

    const lines = text.trim().split('\n');
    const edit = (index: number, change: (event: Record<string, unknown>) => void): string => {
      const copy = [...lines];
      const event = JSON.parse(found(copy[index], 'line')) as Record<string, unknown>;
      change(event);
      copy[index] = JSON.stringify(event);
      return `${copy.join('\n')}\n`;
    };
    // A changed field, a removed event, a swapped order and a changed link are all found, with the place.
    const content = verifyExportText(edit(3, (e) => (e['outcome'] = 'failure')));
    assert.deepEqual(content.problem, { seq: 3, reason: 'content' });
    const removed = verifyExportText([...lines.slice(0, 4), ...lines.slice(5)].join('\n'));
    assert.deepEqual(removed.problem, { seq: 4, reason: 'missing' });
    const swapped = verifyExportText(
      [...lines.slice(0, 3), lines[4], lines[3], ...lines.slice(5)].join('\n'),
    );
    assert.equal(swapped.ok, false);
    const relinked = verifyExportText(edit(4, (e) => (e['prevHash'] = 'f'.repeat(64))));
    assert.deepEqual(relinked.problem, { seq: 4, reason: 'link' });

    // Not an export at all.
    assert.match(verifyExportText('').error ?? '', /empty/u);
    assert.match(verifyExportText('{"format":"other","version":1}\n').error ?? '', /header/u);
    assert.match(
      verifyExportText(`${found(lines[0], 'the header')}\nnot json\n`).error ?? '',
      /Line 2/u,
    );

    // A later part of the log is checked from its first event on.
    assert.equal(verifyExportText([lines[0], ...lines.slice(5)].join('\n')).ok, true);
    const third = JSON.parse(found(lines[3], 'line 3')) as { hash: string };
    assert.equal(findEventHash(text, 3), third.hash);
    assert.equal(findEventHash(text, 99999), null);
  });

  it('makes a checkpoint of the head that carries a signature from the instance key', async () => {
    const made = await checkpoint();
    const events = await auditEvents(instance);
    const head = found(events.at(-1), 'head');
    // The checkpoint names the head as it was; its own record comes after.
    assert.equal(head.action, 'audit.checkpoint.created');
    assert.equal(made.seq, head.seq - 1);
    assert.equal(made.hash, found(events.at(-2), 'previous').hash);
    const parsed = found(parseCheckpoint(made.checkpoint) ?? undefined, 'checkpoint');
    assert.equal(checkpointSignatureValid(checkpointKey(INSTANCE_KEY), parsed), true);
    assert.deepEqual(head.details, { seq: made.seq });
  });

  it('checks the log against a checkpoint: intact, and how much was added since', async () => {
    const { checkpoint: text } = await checkpoint();
    const first = await verifyCheckpoint(text);
    assert.equal(first.ok, true);
    assert.equal(first.result, 'ok');
    assert.ok(first.eventsSince !== null && first.eventsSince >= 1, 'its own creation came after');
    await owner.post('/audit/verify-chain');
    const later = await verifyCheckpoint(text);
    assert.ok(later.eventsSince !== null && later.eventsSince > first.eventsSince);
    const recorded = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'audit.checkpoint.verified'),
      'the record of the check',
    );
    assert.equal(recorded.outcome, 'success');
    assert.equal(recorded.details['result'], 'ok');
  });

  it('answers a made-up or damaged checkpoint without trusting it', async () => {
    const { checkpoint: text } = await checkpoint();
    assert.equal((await verifyCheckpoint('nonsense')).result, 'malformed');
    const foreign = makeCheckpoint(
      checkpointKey(Buffer.alloc(32, 5)),
      { seq: 1, hash: '00'.repeat(32) },
      new Date(),
    );
    const notOurs = await verifyCheckpoint(foreign);
    assert.equal(notOurs.ok, false);
    assert.equal(notOurs.result, 'not_ours');
    assert.equal(notOurs.seq, null, 'nothing a forger wrote is repeated back as fact');
    const parts = text.split('.');
    parts[1] = String(Number(parts[1]) - 1);
    assert.equal((await verifyCheckpoint(parts.join('.'))).result, 'not_ours');
    const failed = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'audit.checkpoint.verified'),
      'the record',
    );
    assert.equal(failed.outcome, 'failure');
  });

  it('finds a history that was rewritten consistently, which a plain chain check passes', async () => {
    const { checkpoint: text, seq } = await checkpoint();
    assert.equal((await verifyCheckpoint(text)).result, 'ok');

    // Someone who can write to the database changes an event and recomputes every hash after it.
    await withoutTrigger(async () => {
      const rows = await db().auditEvent.findMany({
        where: { seq: { gte: BigInt(seq - 2) } },
        orderBy: { seq: 'asc' },
      });
      const before = await db().auditEvent.findUniqueOrThrow({ where: { seq: BigInt(seq - 3) } });
      let previous = before.hash;
      for (const [index, row] of rows.entries()) {
        const outcome =
          index === 0 ? (row.outcome === 'failure' ? 'success' : 'failure') : row.outcome;
        const hash = chainHash({ ...row, outcome, prevHash: previous });
        await db().auditEvent.update({
          where: { seq: row.seq },
          data: { outcome, prevHash: previous, hash },
        });
        previous = hash;
      }
    });
    const chain = (await owner.post('/audit/verify-chain')).body as { ok: boolean };
    assert.equal(chain.ok, true, 'the rewritten chain is a valid chain');
    const result = await verifyCheckpoint(text);
    assert.equal(result.ok, false);
    assert.equal(result.result, 'hash_differs');
    assert.equal(result.seq, seq);
  });

  it('finds a tail that was cut off, which leaves a valid chain', async () => {
    const { checkpoint: text, seq } = await checkpoint();
    await withoutTrigger(async () => {
      await db().auditEvent.deleteMany({ where: { seq: { gt: BigInt(seq - 5) } } });
    });
    const chain = (await owner.post('/audit/verify-chain')).body as { ok: boolean };
    assert.equal(chain.ok, true, 'the shorter chain is still a valid chain');
    const result = await verifyCheckpoint(text);
    assert.equal(result.result, 'event_missing');
    assert.equal(result.eventsSince, null);
  });

  it('needs the permission to note the head, but not a second factor', async () => {
    const observer = await signInAs(instance, 'observer', observerSecret);
    assert.equal((await observer.post('/audit/checkpoints')).status, 403);
    const auditor = await signInAs(instance, 'auditor', auditorSecret);
    assert.equal(
      (await auditor.post('/audit/checkpoints')).status,
      200,
      'the auditor may note the head',
    );
  });
});

describe('the command line', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let dir: string;

  before(async () => {
    instance = await start();
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    dir = await mkdtemp(join(tmpdir(), 'sw-audit-cli-'));
  });
  after(async () => {
    await stop(instance);
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (args: string[], authKey: Buffer | null = INSTANCE_KEY) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await auditVerify(
      args,
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      authKey ?? undefined,
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('finds the checkpoint event whatever the order of its fields and the spaces between them', async () => {
    const text = await downloadText(owner, 100);
    const lines = text.trim().split('\n');
    const third = JSON.parse(found(lines[3], 'line 3')) as Record<string, unknown>;
    // `seq` last, members in another order, legal whitespace: the same event to a JSON reader.
    const { seq, ...rest } = third;
    const reordered = JSON.stringify(
      { ...Object.fromEntries(Object.entries(rest).reverse()), seq },
      null,
      0,
    )
      .replace('{', '{ ')
      .replace(/,"/gu, ' , "');
    const rewritten = `${[...lines.slice(0, 3), reordered, ...lines.slice(4)].join('\n')}\n`;
    assert.equal(verifyExportText(rewritten).ok, true);
    assert.equal(findEventHash(rewritten, 3), third['hash']);

    const file = join(dir, 'reordered.jsonl');
    await writeFile(file, rewritten);
    const checkpoint = makeCheckpoint(
      checkpointKey(INSTANCE_KEY),
      { seq: 3, hash: String(third['hash']) },
      new Date(),
    );
    const agreed = await run([file, '--checkpoint', checkpoint]);
    assert.equal(agreed.code, 0, agreed.out + agreed.err);
    assert.match(agreed.out, /agrees with the checkpoint/u);

    // A changed event is still found, also when its fields were reordered.
    const changed = reordered.replace(
      `"outcome":"${String(third['outcome'])}"`,
      '"outcome":"denied"',
    );
    assert.notEqual(changed, reordered);
    const tampered = `${[...lines.slice(0, 3), changed, ...lines.slice(4)].join('\n')}\n`;
    assert.equal(verifyExportText(tampered).ok, false);
  });

  it('verifies an exported file and a checkpoint without the database', async () => {
    const file = join(dir, 'export.jsonl');
    await writeFile(file, await downloadText(owner, 100));
    const plain = await run([file]);
    assert.equal(plain.code, 0, plain.out + plain.err);
    assert.match(plain.out, /The file is intact: \d+ event\(s\), numbers 1 to \d+/u);

    const { checkpoint: text } = AuditCheckpointSchema.parse(
      (await owner.post('/audit/checkpoints')).body,
    );
    // The file was written before the checkpoint existed: it is shorter than it.
    const short = await run([file, '--checkpoint', text]);
    assert.equal(short.code, 1);
    assert.match(short.out, /ends at \d+, before the checkpoint/u);

    const longer = join(dir, 'later.jsonl');
    await writeFile(longer, await downloadText(owner, 100));
    const agreed = await run([longer, '--checkpoint', text]);
    assert.equal(agreed.code, 0, agreed.out + agreed.err);
    assert.match(agreed.out, /signature is valid/u);
    assert.match(agreed.out, /agrees with the checkpoint/u);

    const withoutKey = await run([longer, '--checkpoint', text], null);
    assert.equal(withoutKey.code, 0);
    assert.match(withoutKey.out, /not checked: SW_AUTH_KEY is not set/u);
  });

  it('says so when a file was changed, or a checkpoint is not what the file holds', async () => {
    const text = await downloadText(owner, 100);
    const lines = text.trim().split('\n');
    const event = JSON.parse(found(lines[2], 'line')) as Record<string, unknown>;
    event['outcome'] = 'failure';
    const tampered = join(dir, 'tampered.jsonl');
    await writeFile(
      tampered,
      `${[...lines.slice(0, 2), JSON.stringify(event), ...lines.slice(3)].join('\n')}\n`,
    );
    const bad = await run([tampered]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /NOT INTACT.*number 2 \(content\)/u);

    const good = join(dir, 'good.jsonl');
    await writeFile(good, text);
    const foreign = makeCheckpoint(
      checkpointKey(Buffer.alloc(32, 5)),
      { seq: 1, hash: '00'.repeat(32) },
      new Date(),
    );
    const notOurs = await run([good, '--checkpoint', foreign]);
    assert.equal(notOurs.code, 1);
    assert.match(notOurs.out, /NOT OURS/u);

    const wrongHash = makeCheckpoint(
      checkpointKey(INSTANCE_KEY),
      { seq: 2, hash: 'ab'.repeat(32) },
      new Date(),
    );
    const differs = await run([good, '--checkpoint', wrongHash]);
    assert.equal(differs.code, 1);
    assert.match(differs.out, /HISTORY DIFFERS/u);

    assert.equal((await run([])).code, 2);
    assert.equal((await run([join(dir, 'nothing.jsonl')])).code, 2);
    assert.equal((await run([good, '--checkpoint'])).code, 2);
  });
});
