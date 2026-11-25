import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  configureParameterPatternTest,
  ScriptListSchema,
  ScriptViewSchema,
} from '@swellwright/contracts';

import { testWithDeadline } from '../common/regex-deadline.js';
import { databaseUrl, errorCode } from '../test-support.js';
import { Harness, eventsOf } from './commands-test-support.js';

describe('the script library', { skip: !databaseUrl }, () => {
  const h = new Harness();
  before(async () => {
    await h.open();
  });
  after(async () => {
    await h.close();
  });

  const goodScript = {
    name: 'check unit',
    description: 'Shows the state of a unit.',
    dangerLevel: 'read',
    sudo: false,
    parameters: [
      {
        name: 'unit',
        label: 'Unit',
        type: 'string',
        required: true,
        pattern: '[a-z0-9@.-]+\\.service',
        maxLength: 60,
      },
    ],
    body: 'systemctl status "$SW_PARAM_UNIT"\n',
  };

  it('has the thirteen built-in scripts, read-only, built-in first', async () => {
    const reply = await h.observer.get('/scripts');
    assert.equal(reply.status, 200);
    const { scripts } = ScriptListSchema.parse(reply.body);
    const builtin = scripts.filter((script) => script.builtin);
    assert.equal(builtin.length, 13);
    for (const script of builtin) {
      assert.equal(script.dangerLevel, 'read');
      assert.match(script.bodySha256, /^[0-9a-f]{64}$/u);
      assert.equal(script.version, 1);
    }
    const flags = scripts.map((script) => script.builtin);
    assert.deepEqual(
      flags,
      [...flags].sort((a, b) => Number(b) - Number(a)),
    );
    const summary = builtin.find((script) => script.name === 'system-summary');
    assert.ok(summary);
    const full = ScriptViewSchema.parse((await h.observer.get(`/scripts/${summary.id}`)).body);
    assert.ok(full.body.startsWith('#!/bin/sh\n# swellwright-script: system-summary v1'));
  });

  it('refuses to change or delete a built-in script, with 409', async () => {
    const { scripts } = ScriptListSchema.parse((await h.owner.get('/scripts')).body);
    const builtin = scripts.find((script) => script.builtin);
    assert.ok(builtin);
    assert.equal(
      (await h.owner.call('PATCH', `/scripts/${builtin.id}`, { description: 'mine' })).status,
      409,
    );
    assert.equal((await h.owner.call('DELETE', `/scripts/${builtin.id}`)).status, 409);
  });

  it('lets an operator with a fresh code write a script, and records it without its text', async () => {
    const script = await h.script(h.operator, goodScript);
    assert.equal(script.builtin, false);
    assert.equal(script.version, 1);
    assert.equal(script.body, goodScript.body);
    assert.match(script.bodySha256, /^[0-9a-f]{64}$/u);
    const created = (await eventsOf(h.instance, 'script.created')).at(-1);
    assert.ok(created);
    assert.equal(created.actor?.name, 'ops');
    assert.equal(created.outcome, 'success');
    assert.equal(created.details['name'], 'check unit');
    assert.equal(created.details['body_sha256'], script.bodySha256);
    assert.ok(
      !JSON.stringify(created).includes('systemctl'),
      'the text of a script is not in the audit log',
    );
  });

  it('refuses a second script with the same name, and parameter definitions that do not hold together', async () => {
    assert.equal((await h.operator.post('/scripts', goodScript)).status, 409);
    const bool = (name: string) => ({ name, label: 'A', type: 'boolean', required: false });
    for (const parameters of [
      [bool('a'), bool('a')],
      [{ name: 'n', label: 'N', type: 'integer', required: false, min: 9, max: 1 }],
      [{ name: 's', label: 'S', type: 'string', required: false, maxLength: 5, pattern: '(' }],
      [{ name: 'Bad Name', label: 'S', type: 'boolean', required: false }],
    ]) {
      const reply = await h.operator.post('/scripts', { ...goodScript, name: 'other', parameters });
      assert.equal(reply.status, 400, JSON.stringify(parameters));
      assert.equal(errorCode(reply), 'validation_failed');
    }
    assert.equal(
      (await h.operator.post('/scripts', { ...goodScript, name: 'x', body: '' })).status,
      400,
    );
    assert.equal(
      (await h.operator.post('/scripts', { ...goodScript, name: 'x', body: 'a\0b' })).status,
      400,
    );
  });

  it('keeps the definitions of a script stored with a pattern the rules now refuse, and refuses new ones and its runs', async () => {
    const client = h.instance.isolated.database.client;
    // Saved before the bound on matching: a pattern the bound refuses, and an ordinary parameter beside it.
    const legacy = ['(a|', 'a)*'].join('');
    const parameters = [
      {
        name: 'word',
        label: 'Word',
        type: 'string',
        required: true,
        pattern: legacy,
        maxLength: 40,
      },
      { name: 'loud', label: 'Loud', type: 'boolean', required: false },
    ];
    const row = await client.script.create({
      data: {
        name: 'legacy pattern',
        description: 'Saved before the bound.',
        body: 'echo "$SW_PARAM_WORD"\n',
        dangerLevel: 'read',
        sudo: false,
        parameters,
        builtin: false,
        version: 1,
        bodySha256: '0'.repeat(64),
      },
    });
    // It is listed with every definition, so an editor shows them.
    const shown = ScriptViewSchema.parse((await h.observer.get(`/scripts/${row.id}`)).body);
    assert.deepEqual(
      shown.parameters.map((parameter) => parameter.name),
      ['word', 'loud'],
    );
    // Saving an unrelated change with the definitions as shown keeps them.
    const described = await h.operator.call('PATCH', `/scripts/${row.id}`, {
      description: 'Still saved before the bound.',
      parameters: shown.parameters,
    });
    assert.equal(described.status, 200, JSON.stringify(described.body));
    assert.deepEqual(
      ScriptViewSchema.parse(described.body).parameters.map((parameter) => parameter.name),
      ['word', 'loud'],
    );
    // A new pattern of that kind is refused, on a change and on a new script, with the reason.
    const added = await h.operator.call('PATCH', `/scripts/${row.id}`, {
      parameters: [
        ...shown.parameters,
        {
          name: 'other',
          label: 'O',
          type: 'string',
          required: false,
          pattern: legacy,
          maxLength: 9,
        },
      ],
    });
    assert.equal(added.status, 400, JSON.stringify(added.body));
    assert.equal(errorCode(added), 'validation_failed');
    assert.match(JSON.stringify(added.body), /repeats a part/u);
    const fresh = await h.operator.post('/scripts', {
      ...goodScript,
      name: 'new legacy',
      parameters,
    });
    assert.equal(fresh.status, 400, JSON.stringify(fresh.body));
    // A run of it is refused before anything is queued, saying why.
    const run = await h.operator.post('/command-runs', {
      mode: 'script',
      scriptId: row.id,
      serverIds: ['00000000-0000-4000-8000-000000000000'],
      parameters: { word: 'aaa' },
    });
    assert.equal(run.status, 400, JSON.stringify(run.body));
    assert.match(JSON.stringify(run.body), /refused and is not run/u);
    await client.script.delete({ where: { id: row.id } });
  });

  it('reads a stored script without running a pattern, even when the time for patterns is spent', async () => {
    const client = h.instance.isolated.database.client;
    const parameters = [
      {
        name: 'unit',
        label: 'Unit',
        type: 'string',
        required: false,
        pattern: '[a-z]+\\.service',
        maxLength: 40,
        default: 'nginx.service',
      },
      { name: 'loud', label: 'Loud', type: 'boolean', required: false },
    ];
    const row = await client.script.create({
      data: {
        name: 'stored default',
        description: 'A default that matches its pattern.',
        body: 'systemctl status "$SW_PARAM_UNIT"\n',
        dangerLevel: 'read',
        sudo: false,
        parameters,
        builtin: false,
        version: 1,
        bodySha256: '0'.repeat(64),
      },
    });
    // As when the process's budget for patterns is spent: every run of a pattern answers `timeout`, and is counted.
    let calls = 0;
    configureParameterPatternTest(() => {
      calls += 1;
      return 'timeout';
    });
    try {
      const shown = ScriptViewSchema.parse((await h.observer.get(`/scripts/${row.id}`)).body);
      assert.deepEqual(
        shown.parameters.map((parameter) => parameter.name),
        ['unit', 'loud'],
      );
      const listed = ScriptListSchema.parse((await h.observer.get('/scripts')).body);
      assert.equal(listed.scripts.find((script) => script.id === row.id)?.parameters.length, 2);
      // An unrelated save keeps every definition.
      const saved = await h.operator.call('PATCH', `/scripts/${row.id}`, {
        description: 'Saved while the time for patterns is spent.',
        parameters: shown.parameters,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(ScriptViewSchema.parse(saved.body).parameters.length, 2);
      assert.equal(calls, 0, 'reading or saving unchanged definitions ran a pattern');
      // A new default cannot be checked now: it is refused, saying so, and nothing is lost.
      const changed = await h.operator.call('PATCH', `/scripts/${row.id}`, {
        parameters: [{ ...parameters[0], default: 'sshd.service' }, parameters[1]],
      });
      assert.equal(changed.status, 400, JSON.stringify(changed.body));
      assert.match(
        JSON.stringify(changed.body),
        /could not be checked against the pattern in time/u,
      );
      assert.equal(
        ScriptViewSchema.parse((await h.observer.get(`/scripts/${row.id}`)).body).parameters.length,
        2,
      );
    } finally {
      configureParameterPatternTest((regex, value) => testWithDeadline(regex, value));
      await client.script.delete({ where: { id: row.id } });
    }
  });

  it('raises the version with a change of the text only, and records what changed', async () => {
    const script = await h.script(h.operator, { ...goodScript, name: 'edit me' });
    const described = await h.operator.call('PATCH', `/scripts/${script.id}`, {
      description: 'New words.',
    });
    assert.equal(described.status, 200);
    assert.equal(ScriptViewSchema.parse(described.body).version, 1);

    const edited = await h.operator.call('PATCH', `/scripts/${script.id}`, {
      body: 'echo "$SW_PARAM_UNIT"\r\n',
    });
    const view = ScriptViewSchema.parse(edited.body);
    assert.equal(view.version, 2);
    assert.equal(view.body, 'echo "$SW_PARAM_UNIT"\n', 'CRLF becomes LF');
    assert.notEqual(view.bodySha256, script.bodySha256);

    const before = (await eventsOf(h.instance, 'script.updated')).length;
    const same = await h.operator.call('PATCH', `/scripts/${script.id}`, {
      body: 'echo "$SW_PARAM_UNIT"\n',
    });
    assert.equal(ScriptViewSchema.parse(same.body).version, 2);
    const updated = await eventsOf(h.instance, 'script.updated');
    assert.equal(updated.length, before, 'a change that changes nothing is not recorded');
    assert.deepEqual(
      updated.slice(-2).map((event) => event.details['changed']),
      ['description', 'body'],
    );
    assert.equal(updated.at(-1)?.details['version'], 2);
    assert.equal(
      (await h.operator.call('PATCH', `/scripts/${script.id}`, { name: 'check unit' })).status,
      409,
      'a taken name',
    );
    assert.equal(
      (await h.operator.call('PATCH', `/scripts/${script.id}`, {})).status,
      400,
      'an empty change',
    );
  });

  it('deletes a script of the instance and records it', async () => {
    const script = await h.script(h.owner, { ...goodScript, name: 'delete me' });
    assert.equal((await h.owner.call('DELETE', `/scripts/${script.id}`)).status, 204);
    assert.equal((await h.owner.get(`/scripts/${script.id}`)).status, 404);
    const deleted = (await eventsOf(h.instance, 'script.deleted')).at(-1);
    assert.equal(deleted?.details['name'], 'delete me');
  });

  it('needs servers:exec and a fresh code to write, and servers:read only to read', async () => {
    for (const client of [h.observer, h.auditor]) {
      assert.equal((await client.post('/scripts', { ...goodScript, name: 'nope' })).status, 403);
    }
    const anonymous = h.instance.client();
    assert.equal((await anonymous.get('/scripts')).status, 401);
    assert.equal((await anonymous.post('/scripts', goodScript)).status, 401);

    await h.lapse();
    const late = await h.operator.post('/scripts', { ...goodScript, name: 'late' });
    assert.equal(late.status, 403);
    assert.equal(errorCode(late), 'step_up_required');
    const script = await h.owner.get('/scripts');
    assert.equal(script.status, 200, 'reading needs no code');
    const list = ScriptListSchema.parse(script.body).scripts.find((s) => s.name === 'edit me');
    assert.ok(list);
    const patch = await h.operator.call('PATCH', `/scripts/${list.id}`, {
      description: 'too late',
    });
    assert.equal(errorCode(patch), 'step_up_required');
    assert.equal(
      errorCode(await h.operator.call('DELETE', `/scripts/${list.id}`)),
      'step_up_required',
    );
    await h.stepUp(h.operator, 'ops');
    await h.stepUp(h.owner, 'owner');
  });

  it('puts the built-in scripts back as this build has them when the server starts again', async () => {
    const db = h.instance.isolated.database.client;
    const original = await db.script.findUniqueOrThrow({ where: { name: 'top-processes' } });
    await db.script.update({
      where: { id: original.id },
      data: { body: '#!/bin/sh\necho tampered\n', bodySha256: '0'.repeat(64), version: 7 },
    });
    await h.restart();
    const after = await h.instance.isolated.database.client.script.findUniqueOrThrow({
      where: { name: 'top-processes' },
    });
    assert.equal(after.id, original.id, 'updated, not made again');
    assert.equal(after.bodySha256, original.bodySha256);
    assert.equal(after.version, original.version);
    assert.equal(
      await h.instance.isolated.database.client.script.count({ where: { builtin: true } }),
      13,
    );
    // A script of the instance with a built-in name is never overwritten.
    const own = await h.instance.isolated.database.client.script.findUniqueOrThrow({
      where: { name: 'check unit' },
    });
    assert.equal(own.builtin, false);
  });
});
