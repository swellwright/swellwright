import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ApiErrorSchema,
  CommandOutputPageSchema,
  CommandRunListSchema,
  ScriptViewSchema,
} from '@swellwright/contracts';

import { databaseUrl, errorCode } from '../test-support.js';
import {
  eventsOf,
  FP_OTHER,
  Harness,
  LOGIN,
  OTHER,
  sleep,
  standardPrograms,
  SUDO,
  targetOf,
} from './commands-test-support.js';

const programsWith = (name: string) => ({
  ...standardPrograms(),
  hello: (context: Parameters<ReturnType<typeof standardPrograms>['hello']>[0]) => {
    context.write('stdout', `hello from ${name}\n`);
    return 0;
  },
});

describe('runs on several servers', { skip: !databaseUrl }, () => {
  const h = new Harness();
  before(async () => {
    await h.open();
  });
  after(async () => {
    await h.close();
  });

  it('runs a command on three servers at once, each with its own output, and cleans up after itself', async () => {
    const hosts = [
      await h.host(programsWith('alpha')),
      await h.host(programsWith('beta')),
      await h.host(programsWith('gamma')),
    ];
    const ids = [] as string[];
    for (const host of hosts) {
      ids.push(await h.server(host));
    }
    const queued = await h.createRun(h.operator, h.inline(ids, '# fake:hello\n'));
    assert.equal(queued.mode, 'inline');
    assert.equal(queued.createdBy, 'ops');
    assert.equal(queued.targets.length, 3);
    assert.deepEqual(
      queued.targets.map((t) => t.serverId),
      ids,
      'in the order the servers were chosen',
    );

    const run = await h.finished(queued.id);
    assert.equal(run.state, 'succeeded');
    assert.deepEqual(run.counts, {
      total: 3,
      pending: 0,
      running: 0,
      succeeded: 3,
      failed: 0,
      lost: 0,
      cancelled: 0,
      skipped: 0,
    });
    for (const [index, name] of ['alpha', 'beta', 'gamma'].entries()) {
      const target = run.targets[index];
      assert.ok(target);
      assert.equal(target.state, 'succeeded');
      assert.equal(target.exitCode, 0);
      assert.equal(target.stdout.tail, `hello from ${name}\n`);
      assert.equal(target.stdout.storedBytes, `hello from ${name}\n`.length);
      assert.equal(target.stdout.truncated, false);
      assert.equal(target.stderr.storedBytes, 0);
      assert.ok(target.startedAt && target.finishedAt);
    }
    assert.ok(run.startedAt && run.finishedAt);
    // The records on the servers are removed once the output is kept.
    for (const host of hosts) {
      await until(() => host.steps.size === 0);
      assert.equal(host.removed.length, 1);
      assert.equal(host.launches.created, 1);
    }
    assert.equal(run.body, '# fake:hello\n');
    assert.match(run.bodySha256, /^[0-9a-f]{64}$/u);
  });

  it('records the start and the end, with the level, the count and the hash of the command, not its text', async () => {
    const host = await h.host(programsWith('audit'));
    const id = await h.server(host);
    const command = '# fake:hello\n# do not put this text in the audit log, the-secret-token-123\n';
    const queued = await h.createRun(h.operator, h.inline([id], command));
    await h.finished(queued.id);
    const started = (await eventsOf(h.instance, 'command.run.started')).find(
      (e) => e.object?.id === queued.id,
    );
    assert.ok(started);
    assert.equal(started.actor?.name, 'ops');
    assert.equal(started.outcome, 'success');
    assert.equal(started.details['mode'], 'inline');
    assert.equal(started.details['level'], 'read');
    assert.equal(started.details['servers'], 1);
    assert.equal(started.details['body_sha256'], queued.bodySha256);
    const finished = (await eventsOf(h.instance, 'command.run.finished')).filter(
      (e) => e.object?.id === queued.id,
    );
    assert.equal(finished.length, 1, 'once');
    assert.equal(finished[0]?.outcome, 'success');
    assert.equal(finished[0].details['state'], 'succeeded');
    assert.equal(finished[0].details['started_by'], 'ops');
    for (const event of [started, ...finished]) {
      assert.ok(
        !JSON.stringify(event).includes('the-secret-token-123'),
        'no command text in the audit log',
      );
    }
  });

  it('reports a non-zero exit as a failure of that server and keeps both streams', async () => {
    const good = await h.host(programsWith('good'));
    const bad = await h.host(programsWith('bad'));
    const ids = [await h.server(good), await h.server(bad)];
    const queued = await h.createRun(
      h.operator,
      h.inline([ids[1] ?? '', ids[0] ?? ''], '# fake:fail3\n'),
    );
    const run = await h.finished(queued.id);
    assert.equal(run.state, 'failed');
    for (const target of run.targets) {
      assert.equal(target.state, 'failed');
      assert.equal(target.exitCode, 3);
      assert.equal(target.stdout.tail, 'before\n');
      assert.equal(target.stderr.tail, 'boom\n');
      assert.equal(target.errorCode, null, 'the exit status says it');
    }
  });

  it('lets one server fail to log in while the others succeed, and does not try the wrong password again', async () => {
    const good = await h.host(programsWith('good'));
    const refused = await h.host(programsWith('refused'));
    const ids = [
      await h.server(good),
      await h.server(refused, { password: h.secrets.wrong }),
      await h.server(good, { name: 'second-on-good' }),
    ];
    const queued = await h.createRun(h.operator, h.inline(ids, '# fake:hello\n'));
    const run = await h.finished(queued.id);
    assert.equal(run.state, 'partial');
    assert.deepEqual(
      run.targets.map((t) => t.state),
      ['succeeded', 'failed', 'succeeded'],
    );
    const failed = run.targets[1];
    assert.ok(failed);
    assert.equal(failed.errorCode, 'ssh_auth_failed');
    assert.ok(failed.errorMessage);
    assert.ok(!JSON.stringify(run).includes(OTHER), 'the password is nowhere in the answer');
    const attempts = refused.server.authAttempts.filter((a) => a.method === 'password').length;
    assert.equal(attempts, 1, 'a wrong password is tried once');
    await sleep(300);
    assert.equal(
      refused.server.authAttempts.filter((a) => a.method === 'password').length,
      attempts,
      'and never again',
    );
    assert.equal(refused.launches.created, 0);
  });

  it('refuses a server whose key is not the pinned one before a credential is sent, and runs the others', async () => {
    const good = await h.host(programsWith('good'));
    const changed = await h.host(programsWith('changed'));
    const ids = [await h.server(good), await h.server(changed, { fingerprint: FP_OTHER })];
    const run = await h.finished(
      (await h.createRun(h.operator, h.inline(ids, '# fake:hello\n'))).id,
    );
    assert.equal(run.state, 'partial');
    assert.equal(targetOf(run, 0).state, 'succeeded');
    assert.equal(targetOf(run, 1).state, 'failed');
    assert.equal(targetOf(run, 1).errorCode, 'host_key_mismatch');
    assert.equal(changed.server.authAttempts.length, 0, 'not even the user name was sent');
    assert.equal(changed.launches.created, 0);
  });

  it('skips a server that has no pinned key or no way to log in, and says why', async () => {
    const host = await h.host(programsWith('ok'));
    const ids = [
      await h.server(host),
      await h.server(host, { fingerprint: null, name: 'unpinned' }),
      await h.server(host, { access: false, name: 'no-access' }),
    ];
    const queued = await h.createRun(h.operator, h.inline(ids, '# fake:hello\n'));
    assert.deepEqual(
      queued.targets.slice(1).map((t) => t.state),
      ['skipped', 'skipped'],
      'decided when the run is made',
    );
    const run = await h.finished(queued.id);
    assert.equal(run.state, 'partial');
    assert.deepEqual(
      run.targets.map((t) => t.errorCode),
      [null, 'host_key_not_pinned', 'no_access_entry'],
    );
    assert.equal(run.counts.skipped, 2);
  });

  it('is finished at once when no server can be used, and counts as failed', async () => {
    const host = await h.host(programsWith('ok'));
    const id = await h.server(host, { fingerprint: null, name: 'unpinned-only' });
    const run = await h.createRun(h.operator, h.inline([id], '# fake:hello\n'));
    const done = await h.finished(run.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.startedAt, null);
    assert.equal(host.launches.created, 0);
  });

  it('answers 404 for a server that does not exist, and 400 for a server listed twice', async () => {
    const missing = await h.operator.post(
      '/command-runs',
      h.inline(['0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'], 'uptime'),
    );
    assert.equal(missing.status, 404);
    const host = await h.host(programsWith('x'));
    const id = await h.server(host);
    const twice = await h.operator.post('/command-runs', h.inline([id, id], 'uptime'));
    assert.equal(twice.status, 400);
  });

  it('gives a script its parameters as environment variables only, exactly as they were given', async () => {
    const host = await h.host(programsWith('env'));
    const id = await h.server(host);
    const script = await h.script(h.operator, {
      name: 'show env',
      description: 'Prints its parameters.',
      dangerLevel: 'read',
      sudo: false,
      parameters: [
        { name: 'note', label: 'Note', type: 'string', required: false, maxLength: 300 },
        {
          name: 'count',
          label: 'Count',
          type: 'integer',
          required: false,
          min: 1,
          max: 9,
          default: 3,
        },
        { name: 'verbose', label: 'Verbose', type: 'boolean', required: false },
        {
          name: 'level',
          label: 'Level',
          type: 'enum',
          required: false,
          options: ['err', 'warning'],
        },
      ],
      body: '# fake:env\n',
    });
    const hostile = '\'; touch /tmp/pwn #\n$(id) `id` "$HOME" \\ \\\' ${IFS}';
    const run = await h.finished(
      (
        await h.createRun(h.operator, {
          mode: 'script',
          serverIds: [id],
          scriptId: script.id,
          parameters: { note: hostile, verbose: true, level: 'warning' },
        })
      ).id,
    );
    assert.equal(run.state, 'succeeded');
    assert.deepEqual(run.parameters, { note: hostile, count: 3, verbose: true, level: 'warning' });
    assert.equal(
      targetOf(run, 0).stdout.tail,
      [
        'SW_PARAM_COUNT=[3]',
        'SW_PARAM_LEVEL=[warning]',
        `SW_PARAM_NOTE=[${hostile}]`,
        'SW_PARAM_VERBOSE=[1]',
        '',
      ].join('\n'),
    );
    assert.ok(!run.body.includes('touch'), 'the values are not in the text that ran');
    assert.equal(run.scriptName, 'show env');
    assert.equal(run.scriptVersion, 1);
  });

  it('refuses a parameter value that does not fit its definition, with 400 and the name', async () => {
    const host = await h.host(programsWith('p'));
    const id = await h.server(host);
    const script = await h.script(h.operator, {
      name: 'strict params',
      description: 'Has strict parameters.',
      dangerLevel: 'read',
      sudo: false,
      parameters: [
        {
          name: 'unit',
          label: 'Unit',
          type: 'string',
          required: true,
          pattern: '[a-z][a-z0-9@.-]{0,40}\\.service',
          maxLength: 50,
        },
        { name: 'lines', label: 'Lines', type: 'integer', required: false, min: 1, max: 100 },
        {
          name: 'level',
          label: 'Level',
          type: 'enum',
          required: false,
          options: ['err', 'warning'],
        },
      ],
      body: '# fake:env\n',
    });
    const queued = async (parameters: Record<string, unknown>) =>
      h.operator.post('/command-runs', {
        mode: 'script',
        serverIds: [id],
        scriptId: script.id,
        parameters,
      });
    for (const hostile of [
      {},
      { unit: 'ssh.service; rm -rf /' },
      { unit: '$(touch /tmp/pwn).service' },
      { unit: 'a.service\nb.service' },
      { unit: 'a.service', lines: 0 },
      { unit: 'a.service', lines: '12; id' },
      { unit: 'a.service', level: 'debug' },
      { unit: 'a.service', extra: 'x' },
      { unit: 5 },
    ]) {
      const reply = await queued(hostile);
      assert.equal(reply.status, 400, JSON.stringify(hostile));
      assert.equal(errorCode(reply), 'validation_failed');
    }
    const issues = ApiErrorSchema.parse((await queued({ unit: 'a.service', lines: 0 })).body).error
      .details as { path: string[] }[];
    assert.deepEqual(issues[0]?.path, ['parameters', 'lines']);
    assert.equal(host.launches.created, 0, 'nothing was sent to a server');
    assert.equal((await queued({ unit: 'ssh.service' })).status, 201);
  });

  it('asks for a confirmation of the level when it is not read, and records that it was given', async () => {
    const host = await h.host(programsWith('c'));
    const id = await h.server(host);
    const destructive = await h.script(h.operator, {
      name: 'wipe thing',
      description: 'Removes a thing.',
      dangerLevel: 'destructive',
      sudo: true,
      parameters: [],
      body: '# fake:hello\n',
    });
    const body = { mode: 'script', serverIds: [id], scriptId: destructive.id };
    const none = await h.operator.post('/command-runs', body);
    assert.equal(none.status, 409);
    assert.equal(errorCode(none), 'confirmation_required');
    assert.deepEqual(ApiErrorSchema.parse(none.body).error.details, { level: 'destructive' });
    const wrong = await h.operator.post('/command-runs', { ...body, confirmedLevel: 'change' });
    assert.equal(errorCode(wrong), 'confirmation_required');
    const read = await h.operator.post('/command-runs', { ...body, confirmedLevel: 'read' });
    assert.equal(errorCode(read), 'confirmation_required');
    assert.equal(host.launches.created, 0);

    const run = await h.createRun(h.operator, { ...body, confirmedLevel: 'destructive' });
    assert.equal(run.dangerLevel, 'destructive');
    assert.equal(run.confirmedLevel, 'destructive');
    assert.equal(run.sudo, true);
    await h.finished(run.id);
    const started = (await eventsOf(h.instance, 'command.run.started')).find(
      (e) => e.object?.id === run.id,
    );
    assert.equal(started?.details['level'], 'destructive');
    assert.equal(started.details['confirmed'], true);
    assert.equal(started.details['script'], 'wipe thing');

    // An inline command is of the level the person says, `change` unless they say otherwise.
    const inline = await h.operator.post('/command-runs', {
      mode: 'inline',
      serverIds: [id],
      command: 'uptime',
    });
    assert.equal(errorCode(inline), 'confirmation_required');
    assert.deepEqual(ApiErrorSchema.parse(inline.body).error.details, { level: 'change' });
    const ok = await h.createRun(h.operator, {
      mode: 'inline',
      serverIds: [id],
      command: '# fake:hello\n',
      confirmedLevel: 'change',
    });
    assert.equal(ok.dangerLevel, 'change');
    await h.finished(ok.id);
  });

  it('gives sudo to a script that wants it: the stored sudo password goes with the launch', async () => {
    const host = await h.host(programsWith('s'));
    const id = await h.server(host);
    const run = await h.finished(
      (await h.createRun(h.operator, h.inline([id], '# fake:hello\n', { sudo: true }))).id,
    );
    assert.equal(run.sudo, true);
    assert.equal(run.state, 'succeeded');
    const launch = host.server.execLog.find((entry) =>
      entry.command.includes('swellwright-launch'),
    );
    assert.ok(launch);
    assert.ok(
      launch.command.endsWith(" '1'") || launch.command.endsWith(' 1'),
      'the step is told to use sudo',
    );
    assert.ok(
      !launch.command.includes(LOGIN) && !launch.command.includes(SUDO),
      'no password in a command line',
    );
  });

  it('keeps what a run executed when its script is edited or deleted afterwards', async () => {
    const host = await h.host(programsWith('h'));
    const id = await h.server(host);
    const script = await h.script(h.operator, {
      name: 'history subject',
      description: 'Subject.',
      dangerLevel: 'read',
      sudo: false,
      parameters: [],
      body: '# fake:hello\n# version one\n',
    });
    const first = await h.finished(
      (await h.createRun(h.operator, { mode: 'script', serverIds: [id], scriptId: script.id })).id,
    );
    await h.operator.call('PATCH', `/scripts/${script.id}`, {
      body: '# fake:hello\n# version two\n',
    });
    const second = await h.finished(
      (await h.createRun(h.operator, { mode: 'script', serverIds: [id], scriptId: script.id })).id,
    );
    assert.equal(first.body, '# fake:hello\n# version one\n');
    assert.equal(first.scriptVersion, 1);
    assert.equal(second.body, '# fake:hello\n# version two\n');
    assert.equal(second.scriptVersion, 2);
    assert.notEqual(first.bodySha256, second.bodySha256);
    await h.operator.call('DELETE', `/scripts/${script.id}`);
    const after = await h.getRun(first.id);
    assert.equal(after.body, first.body, 'the text is still there');
    assert.equal(after.scriptName, 'history subject');
    assert.equal(after.scriptId, null, 'the link to the script is gone');
    assert.equal(after.label, 'history subject');
  });

  it('refuses a run confirmed for a revision of the script that is no longer the current one', async () => {
    const host = await h.host(programsWith('r'));
    const id = await h.server(host);
    const script = await h.script(h.operator, {
      name: 'revision subject',
      description: 'Subject.',
      dangerLevel: 'change',
      sudo: false,
      parameters: [],
      body: '# fake:hello\n# reviewed\n',
    });
    const seen = script.updatedAt;
    const body = {
      mode: 'script',
      serverIds: [id],
      scriptId: script.id,
      confirmedLevel: 'change',
      expectedScriptRevision: seen,
    };
    // Changed after the person looked: the text, or only sudo, which leaves the version as it was.
    const edited = await h.operator.call('PATCH', `/scripts/${script.id}`, {
      body: '# fake:hello\n# not reviewed\n',
    });
    assert.equal(edited.status, 200);
    const stale = await h.operator.post('/command-runs', body);
    assert.equal(stale.status, 409);
    assert.equal(errorCode(stale), 'conflict');
    const current = ScriptViewSchema.parse(edited.body);
    const sudo = await h.operator.call('PATCH', `/scripts/${script.id}`, { sudo: true });
    assert.equal(ScriptViewSchema.parse(sudo.body).version, current.version);
    const staleSudo = await h.operator.post('/command-runs', {
      ...body,
      expectedScriptRevision: current.updatedAt,
    });
    assert.equal(staleSudo.status, 409, 'sudo changed since: also a different revision');
    assert.equal(host.launches.created, 0, 'nothing was sent to a server');

    // The revision on show runs; a client that sends none runs the current script, as before.
    const latest = ScriptViewSchema.parse(sudo.body);
    const run = await h.finished(
      (await h.createRun(h.operator, { ...body, expectedScriptRevision: latest.updatedAt })).id,
    );
    assert.equal(run.body, '# fake:hello\n# not reviewed\n');
    const legacy = { ...body } as Record<string, unknown>;
    delete legacy['expectedScriptRevision'];
    await h.finished((await h.createRun(h.operator, legacy)).id);
    assert.equal(
      (await h.operator.post('/command-runs', { ...body, expectedScriptRevision: 'yesterday' }))
        .status,
      400,
    );
  });

  it('lists the history newest first, with the counts, and filters by state and by server', async () => {
    const host = await h.host(programsWith('l'));
    const id = await h.server(host, { name: 'listed' });
    const bad = await h.finished(
      (await h.createRun(h.operator, h.inline([id], '# fake:fail3\n'))).id,
    );
    const good = await h.finished(
      (await h.createRun(h.operator, h.inline([id], '# fake:hello\n'))).id,
    );
    const all = CommandRunListSchema.parse((await h.observer.get('/command-runs?limit=200')).body);
    assert.ok(all.total >= 2);
    const ids = all.runs.map((run) => run.id);
    assert.ok(ids.indexOf(good.id) < ids.indexOf(bad.id), 'newest first');
    const forServer = CommandRunListSchema.parse(
      (await h.observer.get(`/command-runs?serverId=${id}`)).body,
    );
    assert.deepEqual(
      forServer.runs.map((run) => run.id),
      [good.id, bad.id],
    );
    assert.equal(forServer.runs[0]?.counts.succeeded, 1);
    const failed = CommandRunListSchema.parse(
      (await h.observer.get(`/command-runs?serverId=${id}&state=failed`)).body,
    );
    assert.deepEqual(
      failed.runs.map((run) => run.id),
      [bad.id],
    );
    const paged = CommandRunListSchema.parse(
      (await h.observer.get(`/command-runs?serverId=${id}&limit=1&offset=1`)).body,
    );
    assert.deepEqual(
      paged.runs.map((run) => run.id),
      [bad.id],
    );
    assert.equal(paged.total, 2);
    assert.equal((await h.observer.get('/command-runs?limit=0')).status, 400);
    assert.equal((await h.observer.get('/command-runs?state=sleeping')).status, 400);
  });

  it('pages the output by byte offset, never inside a character, and gives the same text back', async () => {
    const host = await h.host(programsWith('o'));
    const id = await h.server(host);
    const run = await h.finished(
      (await h.createRun(h.operator, h.inline([id], '# fake:lines\n'))).id,
    );
    const target = run.targets[0];
    assert.ok(target);
    const expected = Array.from(
      { length: 20_000 },
      (_, i) => `line ${String(i).padStart(6, '0')}\n`,
    ).join('');
    assert.equal(target.stdout.storedBytes, expected.length);
    assert.equal(target.stdout.truncated, false);
    assert.equal(target.stdout.tailOffset, expected.length - target.stdout.tail.length);
    assert.ok(expected.endsWith(target.stdout.tail), 'the tail is the end');
    assert.ok(target.stdout.tail.length <= 16 * 1024);
    let offset = 0;
    let text = '';
    let pages = 0;
    for (;;) {
      const reply = await h.observer.get(
        `/command-runs/${run.id}/targets/${target.id}/output?stream=stdout&offset=${String(offset)}&limit=50000`,
      );
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      const page = CommandOutputPageSchema.parse(reply.body);
      assert.equal(page.offset, offset);
      text += page.text;
      offset = page.nextOffset;
      pages += 1;
      if (page.eof) {
        break;
      }
    }
    assert.ok(pages > 3);
    assert.equal(text, expected);
    const none = CommandOutputPageSchema.parse(
      (await h.observer.get(`/command-runs/${run.id}/targets/${target.id}/output?stream=stderr`))
        .body,
    );
    assert.deepEqual([none.text, none.eof, none.storedBytes], ['', true, 0]);
  });

  it('does not cut a character in two when a page ends inside it', async () => {
    const host = await h.host(programsWith('u'));
    const id = await h.server(host);
    const run = await h.finished(
      (await h.createRun(h.operator, h.inline([id], '# fake:unicode\n'))).id,
    );
    const target = run.targets[0];
    assert.ok(target);
    const unit = 'héllo wörld € 😀 ünïcode — ';
    const expected = unit.repeat(800);
    assert.equal(target.stdout.storedBytes, Buffer.byteLength(expected, 'utf8'));
    for (const limit of [1, 3, 7, 1000, 4097]) {
      // A page of a byte or two is walked only for a while: it must move on and never show a broken character.
      const small = limit < 20;
      let offset = 0;
      let text = '';
      for (let guard = 0; guard < (small ? 40 : 400); guard += 1) {
        const page = CommandOutputPageSchema.parse(
          (
            await h.observer.get(
              `/command-runs/${run.id}/targets/${target.id}/output?stream=stdout&offset=${String(offset)}&limit=${String(limit)}`,
            )
          ).body,
        );
        assert.ok(
          !page.text.includes('�'),
          `no broken character (limit ${String(limit)}, offset ${String(offset)})`,
        );
        assert.ok(page.nextOffset > offset || page.eof, 'it moves on');
        text += page.text;
        offset = page.nextOffset;
        if (page.eof) {
          break;
        }
      }
      if (small) {
        assert.ok(expected.startsWith(text) && text.length > 8, `limit ${String(limit)}`);
      } else {
        assert.equal(text, expected, `limit ${String(limit)}`);
      }
    }
    // The tail of a long output starts on a character too.
    assert.ok(!target.stdout.tail.includes('�'));
  });

  it('answers 404 for an output that does not exist', async () => {
    const host = await h.host(programsWith('n'));
    const id = await h.server(host);
    const run = await h.finished(
      (await h.createRun(h.operator, h.inline([id], '# fake:hello\n'))).id,
    );
    const wrongTarget = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
    assert.equal(
      (await h.observer.get(`/command-runs/${run.id}/targets/${wrongTarget}/output?stream=stdout`))
        .status,
      404,
    );
    assert.equal((await h.observer.get(`/command-runs/${wrongTarget}`)).status, 404);
    assert.equal(
      (await h.observer.get(`/command-runs/${run.id}/targets/${targetOf(run, 0).id}/output`))
        .status,
      400,
      'a stream is needed',
    );
  });
});

/** Wait for a condition without a deadline of its own: the tests have theirs. */
async function until(test: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await sleep(15);
  }
}
