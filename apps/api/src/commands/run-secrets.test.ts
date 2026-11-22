import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import {
  ApiErrorSchema,
  CommandOutputPageSchema,
  type CommandRunView,
  SecretViewSchema,
} from '@swellwright/contracts';

import { auditEvents, databaseUrl, errorCode, found, type Reply } from '../test-support.js';
import {
  createGate,
  Harness,
  PASSPHRASE,
  standardPrograms,
  sleep,
  targetOf,
} from './commands-test-support.js';
import { VaultService } from '../vault/vault.service.js';
import type { Gate, Program } from './step-host.js';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const DAY = 86_400_000;
const T0 = Date.parse('2031-03-01T12:00:00.000Z');

// Values that must never be found anywhere but in the vault and on the server for the length of a run.
const NODE_KEY = 'nk_live_7Qm2xk-4d9a-b1c3e5f7-run-secret-value';
const TOKEN_B = 'tok_second_8r3Ht5zq-9c1e7a2b4d6f-run-secret';
const SPLIT = 'split-secret-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGH';
const WITH_BREAK = 'value-with-a-trailing-line-break-4f2a9c\n';
const EXPIRING = 'expiring-secret-value-6b1d8e3f-for-the-clock';
const VALUES = [NODE_KEY, TOKEN_B, SPLIT, WITH_BREAK.trim(), EXPIRING];

class CapturingLogger {
  readonly lines: string[] = [];
  log(...parts: unknown[]): void {
    this.lines.push(parts.map(String).join(' '));
  }
  error(...parts: unknown[]): void {
    this.log(...parts);
  }
  warn(...parts: unknown[]): void {
    this.log(...parts);
  }
  debug(...parts: unknown[]): void {
    this.log(...parts);
  }
  verbose(...parts: unknown[]): void {
    this.log(...parts);
  }
}

/** Programs that read what a run was handed, the way a script would, through the path in `NAME_FILE`. */
function secretPrograms(gates: Record<string, Gate>): Record<string, Program> {
  const aborted = (signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        resolve();
      });
    });
  return {
    ...standardPrograms(),
    /** Prints how big the secret is, its hash and where it lives, never the value. */
    measure: (context) => {
      const file = context.env['NODE_KEY_FILE'] ?? '(no variable)';
      const bytes = context.readSecret('NODE_KEY');
      context.write(
        'stdout',
        `file=${file.slice(file.indexOf('/secrets/'))} bytes=${String(bytes?.length ?? -1)} sha=${bytes === undefined ? '-' : sha256(bytes)}\n`,
      );
      // The script is told where the file is, not what is in it: the environment has no value.
      const leaked = Object.values(context.env).some((value) =>
        VALUES.some((secret) => value.includes(secret.trim())),
      );
      context.write('stdout', `leaked=${String(leaked)}\n`);
      return 0;
    },
    /** `cat "$NODE_KEY_FILE"` and `echo "$(cat ...)" >&2`: the careless things a script does. */
    cat: (context) => {
      const bytes = context.readSecret('NODE_KEY');
      context.write('stdout', Buffer.concat([bytes ?? Buffer.alloc(0), Buffer.from('\n')]));
      context.write('stderr', `warning: ${bytes?.toString('utf8') ?? ''} was used\n`);
      return 0;
    },
    catbreak: (context) => {
      context.write('stdout', context.readSecret('BREAK') ?? Buffer.alloc(0));
      context.write('stdout', 'next line\n');
      return 0;
    },
    /** Prints a value in two pieces with a pause between, so that a poll falls in the middle of it. */
    split: async (context) => {
      const value = context.readSecret('SPLIT')?.toString('utf8') ?? '';
      const half = Math.floor(value.length / 2);
      context.write('stdout', `start ${value.slice(0, half)}`);
      await Promise.race([gates['split']?.promise, aborted(context.signal)]);
      context.write('stdout', `${value.slice(half)} end\n`);
      return 0;
    },
    /** Waits at a gate with its secrets on disk, then says whether they are still there. */
    hold: async (context) => {
      context.write('stdout', `have=${String(context.readSecret('NODE_KEY') !== undefined)}\n`);
      await Promise.race([gates['hold']?.promise, aborted(context.signal)]);
      context.write('stdout', `after=${String(context.readSecret('NODE_KEY') !== undefined)}\n`);
      return context.signal.aborted ? 143 : 0;
    },
    /** Prints the first part of a secret, waits, prints the rest: the secret may expire meanwhile. */
    later: async (context) => {
      const value = context.readSecret('SLOW')?.toString('utf8') ?? '';
      context.write('stdout', `begin ${value.slice(0, 20)}`);
      await Promise.race([gates['later']?.promise, aborted(context.signal)]);
      context.write('stdout', `${value.slice(20)}\n`);
      return 0;
    },
  };
}

describe('a vault secret handed to a run', { skip: !databaseUrl }, () => {
  let nowMs = T0;
  const h = new Harness();
  const logger = new CapturingLogger();
  const gates = { split: createGate(), hold: createGate(), later: createGate() };
  /** Everything said to or heard from the API about runs, to be searched for values at the end. */
  const heard: string[] = [];
  let nodeKey = '';
  let tokenB = '';
  let breakId = '';
  let splitId = '';
  let sshKeyId = '';

  const make = async (name: string, type: string, value: string, expiresAt?: string) => {
    const reply = await h.owner.post('/secrets', {
      name,
      type,
      value,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return SecretViewSchema.parse(reply.body).id;
  };

  const withSecrets = (
    serverIds: string[],
    command: string,
    secrets: { name: string; secretId: string }[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => h.inline(serverIds, command, { secrets, ...extra });

  const post = async (client = h.owner, body: Record<string, unknown>): Promise<Reply> => {
    const reply = await client.post('/command-runs', body);
    heard.push(JSON.stringify(reply.body));
    return reply;
  };

  const run = async (body: Record<string, unknown>): Promise<CommandRunView> => {
    const made = await h.createRun(h.owner, body);
    return h.finished(made.id);
  };

  const outputOf = async (runId: string, targetId: string, stream: 'stdout' | 'stderr') => {
    const reply = await h.owner.get(
      `/command-runs/${runId}/targets/${targetId}/output?stream=${stream}`,
    );
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    heard.push(JSON.stringify(reply.body));
    return CommandOutputPageSchema.parse(reply.body);
  };

  const runsCount = (): Promise<number> => h.instance.isolated.database.client.commandRun.count();

  before(async () => {
    await h.open({}, { clock: () => nowMs });
    Logger.overrideLogger(logger);
    nodeKey = await make('node key', 'generic', NODE_KEY);
    tokenB = await make('second token', 'provider_token', TOKEN_B);
    breakId = await make('with a break', 'generic', WITH_BREAK);
    splitId = await make('split value', 'generic', SPLIT);
    sshKeyId = await make('a private key', 'ssh_key', 'not a real key, only a test');
  });
  after(async () => {
    await h.close();
  });

  describe('who may hand a secret over', () => {
    it('refuses a role that cannot reveal, and says so in the audit log, but lets it run what has no secret', async () => {
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const before = await runsCount();
      const refused = await post(
        h.operator,
        withSecrets([server], '# fake:measure\n', [{ name: 'NODE_KEY', secretId: nodeKey }]),
      );
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.equal(errorCode(refused), 'forbidden');
      assert.equal(await runsCount(), before, 'nothing was queued');
      assert.equal(host.launches.created, 0);
      const denials = (await auditEvents(h.instance)).filter(
        (e) => e.action === 'authz.denied' && e.details['permission'] === 'vault:reveal',
      );
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.actor?.name, 'ops');

      const plain = await h.createRun(h.operator, h.inline([server], '# fake:hello\n'));
      assert.equal(
        (await h.finished(plain.id)).state,
        'succeeded',
        'a run without secrets is as before',
      );
    });

    it('asks the owner for a fresh code, and shuts out an API token and the unauthenticated', async () => {
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const body = withSecrets([server], '# fake:measure\n', [
        { name: 'NODE_KEY', secretId: nodeKey },
      ]);
      const before = await runsCount();

      await h.lapse();
      const stale = await post(h.owner, body);
      assert.equal(stale.status, 403);
      assert.equal(errorCode(stale), 'step_up_required');
      await h.stepUp(h.owner, 'owner');
      await h.stepUp(h.operator, 'ops');
      assert.equal(await runsCount(), before, 'nothing was queued without the code');

      const minted = await h.owner.post('/tokens', {
        name: 'revealer',
        permissions: ['vault:reveal'],
      });
      assert.equal(minted.status, 400, 'a token cannot hold the permission to reveal');
      const reader = await h.owner.post('/tokens', {
        name: 'reader',
        permissions: ['servers:read'],
      });
      const bearer = { authorization: `Bearer ${(reader.body as { token: string }).token}` };
      assert.equal(
        (await h.instance.client().call('POST', '/command-runs', body, bearer)).status,
        401,
      );
      assert.equal((await h.instance.client().post('/command-runs', body)).status, 401);
      assert.equal(await runsCount(), before);
      assert.equal(host.launches.created, 0);
    });
  });

  describe('what is checked before anything is queued', () => {
    it('refuses a sealed vault with 423, an expired secret with 409, and queues nothing', async () => {
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const gone = await make(
        'already expired',
        'generic',
        'expired-run-secret-value',
        new Date(T0 - 1).toISOString(),
      );
      const before = await runsCount();
      const connections = host.server.connections;

      const expired = await post(
        h.owner,
        withSecrets([server], '# fake:measure\n', [{ name: 'NODE_KEY', secretId: gone }]),
      );
      assert.equal(expired.status, 409, JSON.stringify(expired.body));
      assert.equal(errorCode(expired), 'secret_expired');
      assert.equal(
        (ApiErrorSchema.parse(expired.body).error.details as { secretName: string }).secretName,
        'already expired',
      );

      assert.equal((await h.owner.post('/vault/seal')).status, 200);
      const sealed = await post(
        h.owner,
        withSecrets([server], '# fake:measure\n', [{ name: 'NODE_KEY', secretId: gone }]),
      );
      assert.equal(sealed.status, 423, 'sealed first, as everywhere');
      assert.equal(errorCode(sealed), 'vault_sealed');
      assert.equal((await h.owner.post('/vault/unseal', { passphrase: PASSPHRASE })).status, 200);

      assert.equal(await runsCount(), before, 'nothing was queued');
      assert.equal(host.server.connections, connections, 'and nobody connected to the server');
      assert.equal(host.launches.created, 0);

      await h.owner.call('PATCH', `/secrets/${gone}`, {
        expiresAt: new Date(T0 + DAY).toISOString(),
      });
      const renewed = await run(
        withSecrets([server], '# fake:measure\n', [{ name: 'NODE_KEY', secretId: gone }]),
      );
      assert.equal(renewed.state, 'succeeded', 'a renewed secret works again');
    });

    it('refuses hostile and missing choices with the reason, and leaves nothing on any server', async () => {
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const before = await runsCount();
      const attempts: [string, unknown[], number][] = [
        ['a name in lower case', [{ name: 'node_key', secretId: nodeKey }], 400],
        ['a name that starts with a digit', [{ name: '1KEY', secretId: nodeKey }], 400],
        ['a name with a dash', [{ name: 'NODE-KEY', secretId: nodeKey }], 400],
        ['a name of Swellwright', [{ name: 'SW_PARAM_X', secretId: nodeKey }], 400],
        ['a name of Swellwright', [{ name: 'SWELLWRIGHT_STEP_DIR', secretId: nodeKey }], 400],
        ['a name too long', [{ name: 'A'.repeat(65), secretId: nodeKey }], 400],
        [
          'a name used twice',
          [
            { name: 'DUP', secretId: nodeKey },
            { name: 'DUP', secretId: tokenB },
          ],
          400,
        ],
        [
          'nine secrets',
          Array.from({ length: 9 }, (_, n) => ({ name: `S${String(n)}`, secretId: nodeKey })),
          400,
        ],
        ['an id that is not one', [{ name: 'X', secretId: 'not-an-id' }], 400],
        [
          'a secret that does not exist',
          [{ name: 'X', secretId: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b' }],
          404,
        ],
        ['a private key', [{ name: 'X', secretId: sshKeyId }], 409],
      ];
      for (const [what, secrets, status] of attempts) {
        const reply = await post(h.owner, { ...h.inline([server], '# fake:measure\n'), secrets });
        assert.equal(reply.status, status, `${what}: ${JSON.stringify(reply.body)}`);
      }
      assert.equal(await runsCount(), before);
      assert.equal(host.launches.created, 0);
    });
  });

  describe('delivery', () => {
    it('writes the secret to a file, tells the script where it is, and keeps the value out of everything else', async () => {
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const done = await run(
        withSecrets([server], '# fake:measure\n', [{ name: 'NODE_KEY', secretId: nodeKey }]),
      );
      assert.equal(done.state, 'succeeded', JSON.stringify(done.targets));
      const target = targetOf(done);
      assert.match(
        target.stdout.tail,
        new RegExp(
          `^file=/secrets/NODE_KEY bytes=${String(NODE_KEY.length)} sha=${sha256(NODE_KEY)}\\nleaked=false\\n$`,
          'u',
        ),
      );
      // The run keeps which secret, never a value.
      assert.deepEqual(done.secrets, [
        { name: 'NODE_KEY', secretId: nodeKey, secretName: 'node key' },
      ]);
      assert.equal(done.body, '# fake:measure\n');
      assert.deepEqual(done.parameters, {});

      // Not in a command line of any connection, and not on the server any more.
      assert.ok(host.commands.length > 0);
      for (const command of host.commands) {
        assert.ok(
          !VALUES.some((value) => command.includes(value.trim())),
          'a value is in a command line',
        );
      }
      assert.deepEqual(
        host.runningSteps().map((step) => [...step.secrets.keys()]),
        [],
      );
      for (const step of host.steps.values()) {
        assert.equal(step.secrets.size, 0, 'the files are gone when the script has ended');
      }

      const db = h.instance.isolated.database.client;
      const stored = JSON.stringify([
        await db.commandRun.findMany(),
        (await db.commandRunTarget.findMany()).map((row) => ({
          ...row,
          stdoutTail: Buffer.from(row.stdoutTail).toString('latin1'),
          stderrTail: Buffer.from(row.stderrTail).toString('latin1'),
        })),
        (await db.commandOutputChunk.findMany()).map((row) =>
          Buffer.from(row.data).toString('latin1'),
        ),
        await db.commandRunSecret.findMany(),
      ]);
      for (const value of VALUES) {
        assert.ok(!stored.includes(value), 'a value is in the database');
      }
    });

    it('records the use of every secret in the transaction of the run, with the servers and without the value', async () => {
      const host = await h.host(secretPrograms(gates));
      const a = await h.server(host);
      const b = await h.server(host);
      const done = await run(
        withSecrets([a, b], '# fake:hello\n', [
          { name: 'NODE_KEY', secretId: nodeKey },
          { name: 'TOKEN_B', secretId: tokenB },
        ]),
      );
      const records = (await auditEvents(h.instance)).filter(
        (e) => e.action === 'secret.used_in_run' && e.details['run'] === done.id,
      );
      assert.equal(records.length, 2);
      assert.deepEqual(
        records.map((r) => [r.details['name'], r.object?.id, r.details['secret_name']]).sort(),
        [
          ['NODE_KEY', nodeKey, 'node key'],
          ['TOKEN_B', tokenB, 'second token'],
        ],
      );
      for (const record of records) {
        assert.equal(record.actor?.name, 'owner');
        assert.equal(record.details['servers'], 2);
        assert.equal(record.details['server_ids'], [a, b].join(','));
      }
      const started = found(
        (await auditEvents(h.instance)).find(
          (e) => e.action === 'command.run.started' && e.object?.id === done.id,
        ),
        'the record of the start',
      );
      assert.equal(started.details['secrets'], 2);
      // They were written in the same transaction as the run: the sequence has no event of another kind between them.
      const seqs = [...records.map((r) => r.seq), started.seq].sort((x, y) => x - y);
      assert.equal((seqs[2] ?? 0) - (seqs[0] ?? 0), 2);
    });
  });

  describe('the output', () => {
    it('shows a marker where the script printed a value, on both streams, and stores nothing else', async () => {
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const done = await run(
        withSecrets([server], '# fake:cat\n', [{ name: 'NODE_KEY', secretId: nodeKey }]),
      );
      const target = targetOf(done);
      assert.equal(target.stdout.tail, '[secret NODE_KEY]\n');
      assert.equal(target.stderr.tail, 'warning: [secret NODE_KEY] was used\n');
      const page = await outputOf(done.id, target.id, 'stdout');
      assert.equal(page.text, '[secret NODE_KEY]\n');
      assert.equal(page.storedBytes, '[secret NODE_KEY]\n'.length);
      assert.equal((await outputOf(done.id, target.id, 'stderr')).text, target.stderr.tail);
      assert.equal(
        heard.some((text) => text.includes(NODE_KEY)),
        false,
      );
    });

    it('keeps the line break after a value that has one', async () => {
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const done = await run(
        withSecrets([server], '# fake:catbreak\n', [{ name: 'BREAK', secretId: breakId }]),
      );
      assert.equal(targetOf(done).stdout.tail, '[secret BREAK]\nnext line\n');
    });

    it('finds a value that straddles two reads, and stores the held-back part only once it is known to be text', async () => {
      const gate = createGate();
      gates.split = gate;
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const made = await h.createRun(
        h.owner,
        withSecrets([server], '# fake:split\n', [{ name: 'SPLIT', secretId: splitId }]),
      );
      // Half of the value has been written, and the poll has seen it: nothing of it may be stored yet.
      await sleep(400);
      const midway = await h.getRun(made.id);
      assert.ok(
        !targetOf(midway).stdout.tail.includes(SPLIT.slice(0, 20)),
        'the first half of a value was stored',
      );
      assert.equal(targetOf(midway).stdout.tail.startsWith('start'), true);
      gate.open();
      const done = await h.finished(made.id);
      assert.equal(done.state, 'succeeded');
      assert.equal(targetOf(done).stdout.tail, 'start [secret SPLIT] end\n');
      const page = await outputOf(done.id, targetOf(done).id, 'stdout');
      assert.equal(page.text, 'start [secret SPLIT] end\n');
      assert.equal(page.truncated, false);
    });

    it('goes on finding values after the API was restarted, because the vault is opened again and the offset was kept', async () => {
      const gate = createGate();
      gates.split = gate;
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const made = await h.createRun(
        h.owner,
        withSecrets([server], '# fake:split\n', [{ name: 'SPLIT', secretId: splitId }]),
      );
      await sleep(400);
      await h.restart();
      Logger.overrideLogger(logger);
      // After a restart the vault is sealed: the run waits, the script is not touched.
      const waiting = await h.waitFor(
        made.id,
        'the sealed vault',
        (r) => targetOf(r).waiting === 'vault_sealed',
      );
      assert.equal(targetOf(waiting).state, 'running');
      gate.open();
      await sleep(150);
      assert.equal(
        (await h.getRun(made.id)).state,
        'running',
        'nothing was read while the vault is sealed',
      );
      assert.equal((await h.owner.post('/vault/unseal', { passphrase: PASSPHRASE })).status, 200);
      const done = await h.finished(made.id);
      assert.equal(targetOf(done).stdout.tail, 'start [secret SPLIT] end\n');
      assert.equal(host.launches.created, 1, 'it was found again, not started again');
    });
  });

  describe('the files on the server', () => {
    it('are there while the script runs and gone when it ends: by exit, failure, cancel and timeout', async () => {
      const gate = createGate();
      gates.hold = gate;
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const secret = { name: 'NODE_KEY', secretId: nodeKey };

      // Exit.
      const first = await h.createRun(h.owner, withSecrets([server], '# fake:hold\n', [secret]));
      await h.waitFor(first.id, 'the script to run', (r) =>
        targetOf(r).stdout.tail.startsWith('have=true'),
      );
      assert.deepEqual(
        host.runningSteps().map((step) => [...step.secrets.keys()]),
        [['NODE_KEY']],
        'the file is there while it runs',
      );
      gate.open();
      const ended = await h.finished(first.id);
      assert.equal(
        targetOf(ended).stdout.tail,
        'have=true\nafter=true\n',
        'it could read it until the end',
      );
      assert.equal(host.steps.size, 0, 'the record of the step is tidied away');

      // Failure.
      const failed = await run(withSecrets([server], '# fake:fail3\n', [secret]));
      assert.equal(failed.state, 'failed');

      // Cancel.
      const gate2 = createGate();
      gates.hold = gate2;
      const running = await h.createRun(h.owner, withSecrets([server], '# fake:hold\n', [secret]));
      await h.waitFor(running.id, 'the script to run', (r) =>
        targetOf(r).stdout.tail.startsWith('have=true'),
      );
      assert.equal((await h.owner.post(`/command-runs/${running.id}/cancel`)).status, 200);
      const cancelled = await h.finished(running.id);
      assert.equal(cancelled.state, 'cancelled');
      for (const step of host.steps.values()) {
        assert.equal(step.secrets.size, 0, 'after a cancel');
      }

      // Time limit.
      const gate3 = createGate();
      gates.hold = gate3;
      const slow = await h.createRun(
        h.owner,
        withSecrets([server], '# fake:hold\n', [secret], { timeoutSeconds: 1 }),
      );
      const timedOut = await h.finished(slow.id);
      assert.equal(targetOf(timedOut).errorCode, 'timeout');
      for (const step of host.steps.values()) {
        assert.equal(step.secrets.size, 0, 'after the time limit');
      }
      for (const command of host.commands) {
        assert.ok(!VALUES.some((value) => command.includes(value.trim())));
      }
    });
  });

  describe('a secret that is in use', () => {
    it('is not replaced or deleted while a run that was handed it is going, and lets go when the run is over', async () => {
      const gate = createGate();
      gates.hold = gate;
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const guarded = await make('guarded', 'generic', 'guarded-secret-value-3d9a1c');
      const made = await h.createRun(
        h.owner,
        withSecrets([server], '# fake:hold\n', [{ name: 'NODE_KEY', secretId: guarded }]),
      );
      await h.waitFor(made.id, 'the script to run', (r) =>
        targetOf(r).stdout.tail.startsWith('have=true'),
      );

      const replace = await h.owner.call('PATCH', `/secrets/${guarded}`, {
        value: 'another-value-0001',
      });
      assert.equal(replace.status, 409, JSON.stringify(replace.body));
      assert.match(JSON.stringify(replace.body), /still going/u);
      assert.equal((await h.owner.call('DELETE', `/secrets/${guarded}`)).status, 409);
      const renewed = await h.owner.call('PATCH', `/secrets/${guarded}`, {
        expiresAt: new Date(T0 + 40 * DAY).toISOString(),
      });
      assert.equal(renewed.status, 200, 'the expiry and the details are not the value');
      assert.equal(
        (await h.owner.call('PATCH', `/secrets/${guarded}`, { description: 'still fine' })).status,
        200,
      );

      gate.open();
      await h.finished(made.id);
      assert.equal(
        (await h.owner.call('PATCH', `/secrets/${guarded}`, { value: 'another-value-0001' }))
          .status,
        200,
        'the run is over: the value may change',
      );
      assert.equal((await h.owner.call('DELETE', `/secrets/${guarded}`)).status, 204);
      const view = await h.getRun(made.id);
      assert.deepEqual(view.secrets, [{ name: 'NODE_KEY', secretId: null, secretName: 'guarded' }]);
    });

    it('does not hand over a value that is not the one the run was queued with, and says so before anything is decrypted', async () => {
      const vault = h.instance.app.get(VaultService);
      const changing = await make('changing', 'generic', 'changing-secret-value-aa11');
      const consumer = { kind: 'command_run', id: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6c' } as const;
      const [queued] = await vault.readForRun([{ name: 'K', secretId: changing }], consumer);
      assert.equal(queued?.version, 1);
      // Another process, or a restored backup, changes what the secret is. A replacement through the API is refused while
      // a run is going; this is what the check at delivery is for.
      await h.instance.isolated.database.client.secret.update({
        where: { id: changing },
        data: { version: { increment: 1 } },
      });
      await assert.rejects(
        vault.readForRun([{ name: 'K', secretId: changing, version: 1 }], consumer),
        /replaced after the run was queued/u,
      );
      await assert.rejects(
        vault.readForRun([{ name: 'K', secretId: sshKeyId }], consumer),
        /cannot be handed to a run/u,
      );
    });
  });

  describe('the expiry of a secret that a run was handed', () => {
    it('does not cut a run short: it is followed to the end, and its output is still scrubbed', async () => {
      const gate = createGate();
      gates.later = gate;
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const soon = await make(
        'slow secret',
        'generic',
        EXPIRING,
        new Date(T0 + 10 * 60_000).toISOString(),
      );
      const made = await h.createRun(
        h.owner,
        withSecrets([server], '# fake:later\n', [{ name: 'SLOW', secretId: soon }]),
      );
      await h.waitFor(made.id, 'the first output', (r) => targetOf(r).stdout.storedBytes > 0);
      nowMs = T0 + 11 * 60_000;
      gate.open();
      const done = await h.finished(made.id);
      nowMs = T0;
      assert.equal(done.state, 'succeeded', JSON.stringify(done.targets));
      assert.equal(targetOf(done).errorCode, null);
      assert.equal(targetOf(done).stdout.tail, 'begin [secret SLOW]\n');
    });
  });

  describe('a secret parameter of a script', () => {
    it('takes the id of a vault secret, hands it over as NAME_FILE and keeps it out of the stored parameters', async () => {
      const host = await h.host(secretPrograms(gates));
      const server = await h.server(host);
      const script = await h.script(h.owner, {
        name: 'needs a key',
        description: 'Reads the key of a node.',
        dangerLevel: 'read',
        sudo: false,
        parameters: [
          {
            name: 'node_key',
            label: 'Node key',
            required: true,
            type: 'secret',
            secretTypes: ['generic', 'provider_token'],
          },
        ],
        body: '# fake:measure\n',
      });
      const done = await run({
        mode: 'script',
        scriptId: script.id,
        serverIds: [server],
        parameters: { node_key: nodeKey },
      });
      assert.equal(done.state, 'succeeded', JSON.stringify(done.targets));
      assert.match(targetOf(done).stdout.tail, /^file=\/secrets\/NODE_KEY bytes=/u);
      assert.deepEqual(done.parameters, {}, 'the secret is not a parameter value');
      assert.deepEqual(done.secrets, [
        { name: 'NODE_KEY', secretId: nodeKey, secretName: 'node key' },
      ]);

      // The wrong kind for the parameter, a missing choice, and the same name given twice.
      const before = await runsCount();
      for (const [what, body] of [
        [
          'a kind the parameter does not take',
          { parameters: { node_key: breakId.length > 0 ? sshKeyId : '' } },
        ],
        ['no choice', { parameters: {} }],
        ['not an id', { parameters: { node_key: 'x' } }],
        [
          'the name used twice',
          { parameters: { node_key: nodeKey }, secrets: [{ name: 'NODE_KEY', secretId: tokenB }] },
        ],
      ] as const) {
        const reply = await post(h.owner, {
          mode: 'script',
          scriptId: script.id,
          serverIds: [server],
          ...body,
        });
        assert.ok(
          reply.status === 400 || reply.status === 409,
          `${what}: ${JSON.stringify(reply.body)}`,
        );
      }
      assert.equal(await runsCount(), before);

      // An operator may run the script, but not hand it a secret.
      const refused = await post(h.operator, {
        mode: 'script',
        scriptId: script.id,
        serverIds: [server],
        parameters: { node_key: nodeKey },
      });
      assert.equal(refused.status, 403);
    });

    it('refuses to save a script whose secret parameter cannot become a variable of the run', async () => {
      const bad = await h.owner.post('/scripts', {
        name: 'bad secret parameter',
        description: 'x',
        dangerLevel: 'read',
        sudo: false,
        parameters: [
          {
            name: 'sw_key',
            label: 'Key',
            required: true,
            type: 'secret',
            secretTypes: ['generic'],
          },
        ],
        body: 'true\n',
      });
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      const empty = await h.owner.post('/scripts', {
        name: 'empty kinds',
        description: 'x',
        dangerLevel: 'read',
        sudo: false,
        parameters: [
          { name: 'key', label: 'Key', required: true, type: 'secret', secretTypes: [] },
        ],
        body: 'true\n',
      });
      assert.equal(empty.status, 400);
      const privateKey = await h.owner.post('/scripts', {
        name: 'private keys are not for scripts',
        description: 'x',
        dangerLevel: 'read',
        sudo: false,
        parameters: [
          { name: 'key', label: 'Key', required: true, type: 'secret', secretTypes: ['ssh_key'] },
        ],
        body: 'true\n',
      });
      assert.equal(privateKey.status, 400);
    });
  });

  it('never put a value in a response, in the audit log, in the database or in a log line', async () => {
    const db = h.instance.isolated.database.client;
    const everything = [
      ...heard,
      JSON.stringify(await auditEvents(h.instance)),
      JSON.stringify(await db.auditEvent.findMany({ select: { details: true } })),
      logger.lines.join('\n'),
    ].join('\n');
    for (const value of VALUES) {
      assert.ok(
        !everything.includes(value),
        `a value is somewhere it must not be: ${value.slice(0, 8)}...`,
      );
    }
  });
});
