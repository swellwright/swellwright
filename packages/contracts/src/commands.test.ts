import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkParameterValues,
  CommandOutputQuerySchema,
  CreateCommandRunRequestSchema,
  CreateScriptRequestSchema,
  commandLabel,
  MAX_RUN_SERVERS,
  parameterDefinitionIssues,
  parameterWriteIssues,
  parameterEnvName,
  type ScriptParameter,
  ScriptParametersSchema,
} from './index.js';

const SERVER = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
const SCRIPT = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6c';

const parameters: ScriptParameter[] = [
  {
    name: 'unit',
    label: 'Unit',
    type: 'string',
    required: true,
    pattern: '[a-z][a-z0-9@.-]{0,40}\\.(service|timer)',
    maxLength: 60,
  },
  {
    name: 'lines',
    label: 'Lines',
    type: 'integer',
    required: false,
    min: 1,
    max: 500,
    default: 50,
  },
  { name: 'level', label: 'Level', type: 'enum', required: false, options: ['err', 'warning'] },
  { name: 'verbose', label: 'Verbose', type: 'boolean', required: false, default: false },
  { name: 'note', label: 'Note', type: 'string', required: false, maxLength: 200 },
];

describe('the environment variable of a parameter', () => {
  it('is the upper-cased name behind SW_PARAM_', () => {
    assert.equal(parameterEnvName('unit'), 'SW_PARAM_UNIT');
    assert.equal(parameterEnvName('max_lines'), 'SW_PARAM_MAX_LINES');
  });
});

describe('parameter values', () => {
  it('takes the right types, fills defaults and names the environment', () => {
    const result = checkParameterValues(parameters, { unit: 'ssh.service', level: 'err' });
    assert.ok(result.ok);
    assert.deepEqual(result.values, {
      unit: 'ssh.service',
      lines: 50,
      level: 'err',
      verbose: false,
    });
    assert.deepEqual(result.env, {
      SW_PARAM_UNIT: 'ssh.service',
      SW_PARAM_LINES: '50',
      SW_PARAM_LEVEL: 'err',
      SW_PARAM_VERBOSE: '0',
    });
  });

  it('writes booleans as 1 and 0 and accepts a number written as text', () => {
    const result = checkParameterValues(parameters, {
      unit: 'a.timer',
      verbose: true,
      lines: '120',
    });
    assert.ok(result.ok);
    assert.equal(result.env['SW_PARAM_VERBOSE'], '1');
    assert.equal(result.env['SW_PARAM_LINES'], '120');
  });

  it('does not set an optional value that has no default and was not given', () => {
    const result = checkParameterValues(parameters, { unit: 'a.service' });
    assert.ok(result.ok);
    assert.ok(!('SW_PARAM_NOTE' in result.env));
    assert.ok(!('SW_PARAM_LEVEL' in result.env));
  });

  it('refuses a missing required value, an unknown name and values of the wrong kind', () => {
    const missing = checkParameterValues(parameters, {});
    assert.ok(!missing.ok);
    assert.deepEqual(
      missing.issues.map((issue) => issue.name),
      ['unit'],
    );
    const unknown = checkParameterValues(parameters, { unit: 'a.service', extra: 'x' });
    assert.ok(!unknown.ok);
    assert.equal(unknown.issues[0]?.name, 'extra');
    for (const bad of [
      { unit: 5 },
      { unit: 'a.service', lines: 0 },
      { unit: 'a.service', lines: 501 },
      { unit: 'a.service', lines: 1.5 },
      { unit: 'a.service', lines: '12abc' },
      { unit: 'a.service', lines: true },
      { unit: 'a.service', level: 'debug' },
      { unit: 'a.service', verbose: 'yes' },
    ]) {
      assert.ok(!checkParameterValues(parameters, bad).ok, JSON.stringify(bad));
    }
  });

  it('holds a string to its pattern as a whole, and to its length', () => {
    for (const hostile of [
      'ssh.service; rm -rf /',
      '$(touch /tmp/pwn).service',
      '`id`.service',
      "ssh'.service",
      'ssh.service\n',
      'ssh.service\nmalicious.service',
      '../../etc/passwd.service',
      'ssh service.service',
      'x'.repeat(61) + '.service',
    ]) {
      assert.ok(!checkParameterValues(parameters, { unit: hostile }).ok, JSON.stringify(hostile));
    }
    assert.ok(checkParameterValues(parameters, { unit: 'systemd-resolved.service' }).ok);
  });

  it('lets a string without a pattern carry any text, a NUL excepted, because it is quoted on the way', () => {
    const hostile = "'; touch /tmp/pwn; echo '$(id)' `id` \\ \n \"quoted\"";
    const result = checkParameterValues(parameters, { unit: 'a.service', note: hostile });
    assert.ok(result.ok);
    assert.equal(result.env['SW_PARAM_NOTE'], hostile);
    assert.ok(!checkParameterValues(parameters, { unit: 'a.service', note: 'a\0b' }).ok);
    assert.ok(!checkParameterValues(parameters, { unit: 'a.service', note: 'x'.repeat(201) }).ok);
  });

  it('never lets a prototype name through as a parameter', () => {
    const result = checkParameterValues(
      parameters,
      JSON.parse('{"unit":"a.service","__proto__":"x"}') as Record<string, unknown>,
    );
    assert.ok(!result.ok);
  });
});

describe('parameter definitions', () => {
  it('accept a consistent list', () => {
    assert.deepEqual(parameterDefinitionIssues(parameters), []);
    assert.ok(ScriptParametersSchema.safeParse(parameters).success);
  });

  it('refuse duplicates, ranges that cannot hold, defaults that do not fit and bad patterns', () => {
    const base = { label: 'x', required: false } as const;
    const bad: ScriptParameter[][] = [
      [
        { ...base, name: 'a', type: 'boolean' },
        { ...base, name: 'a', type: 'boolean' },
      ],
      [{ ...base, name: 'n', type: 'integer', min: 5, max: 1 }],
      [{ ...base, name: 'n', type: 'integer', min: 1, max: 5, default: 9 }],
      [{ ...base, name: 'e', type: 'enum', options: ['a', 'a'] }],
      [{ ...base, name: 'e', type: 'enum', options: ['a'], default: 'b' }],
      [{ ...base, name: 's', type: 'string', maxLength: 5, pattern: '(' }],
      [{ ...base, name: 's', type: 'string', maxLength: 5, default: 'toolong' }],
    ];
    for (const list of bad) {
      assert.ok(parameterDefinitionIssues(list).length > 0, JSON.stringify(list));
      assert.ok(!ScriptParametersSchema.safeParse(list).success, JSON.stringify(list));
    }
    // A default that does not match its pattern is a rule for writing (it runs the pattern), not for reading.
    const mismatch: ScriptParameter[] = [
      { ...base, name: 's', type: 'string', maxLength: 5, pattern: '[a-z]+', default: '123' },
    ];
    assert.ok(parameterWriteIssues(mismatch).length > 0);
    assert.ok(ScriptParametersSchema.safeParse(mismatch).success);
  });

  it('refuse names that could not be an environment variable', () => {
    for (const name of ['Unit', '1st', 'a-b', 'a b', '', 'x'.repeat(33), 'a;b']) {
      assert.ok(
        !ScriptParametersSchema.safeParse([{ name, label: 'x', type: 'boolean', required: false }])
          .success,
        name,
      );
    }
  });

  it('are at most twenty', () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      name: `p${String(index)}`,
      label: 'x',
      type: 'boolean' as const,
      required: false,
    }));
    assert.ok(!ScriptParametersSchema.safeParse(many).success);
  });
});

describe('a script', () => {
  const script = {
    name: 'check unit',
    description: 'Shows a unit.',
    dangerLevel: 'read',
    sudo: false,
    parameters: [],
    body: 'echo hi\n',
  };

  it('is taken as a whole', () => {
    assert.ok(CreateScriptRequestSchema.safeParse(script).success);
  });

  it('refuses an empty or oversized text, a NUL, a bad name and an unknown level', () => {
    for (const bad of [
      { ...script, body: '' },
      { ...script, body: 'echo \0' },
      { ...script, body: 'x'.repeat(256 * 1024 + 1) },
      { ...script, name: 'a/b' },
      { ...script, dangerLevel: 'harmless' },
    ]) {
      assert.ok(!CreateScriptRequestSchema.safeParse(bad).success);
    }
  });
});

describe('a run request', () => {
  const common = { serverIds: [SERVER] };

  it('takes a script with its parameters or an inline command', () => {
    assert.ok(
      CreateCommandRunRequestSchema.safeParse({
        mode: 'script',
        ...common,
        scriptId: SCRIPT,
        parameters: { unit: 'ssh.service' },
        timeoutSeconds: 60,
        confirmedLevel: 'change',
      }).success,
    );
    assert.ok(
      CreateCommandRunRequestSchema.safeParse({
        mode: 'inline',
        ...common,
        command: 'uptime',
        sudo: true,
        dangerLevel: 'read',
      }).success,
    );
  });

  it('refuses a body that mixes the two modes, an empty command and a missing server', () => {
    for (const bad of [
      { mode: 'script', ...common },
      { mode: 'inline', ...common },
      { mode: 'inline', ...common, command: '' },
      { mode: 'inline', ...common, command: 'a\0b' },
      { mode: 'inline', serverIds: [], command: 'uptime' },
      { mode: 'inline', serverIds: [SERVER, SERVER], command: 'uptime' },
      { mode: 'inline', serverIds: ['not-an-id'], command: 'uptime' },
      { mode: 'inline', ...common, command: 'uptime', timeoutSeconds: 0 },
      { mode: 'inline', ...common, command: 'uptime', timeoutSeconds: 3601 },
      { mode: 'other', ...common, command: 'uptime' },
    ]) {
      assert.ok(!CreateCommandRunRequestSchema.safeParse(bad).success, JSON.stringify(bad));
    }
  });

  it('allows fifty servers and not fifty-one', () => {
    const ids = (count: number): string[] =>
      Array.from(
        { length: count },
        (_, index) => `0192a3b4-c5d6-7e8f-9a0b-${String(index).padStart(12, '0')}`,
      );
    assert.equal(MAX_RUN_SERVERS, 50);
    assert.ok(
      CreateCommandRunRequestSchema.safeParse({ mode: 'inline', serverIds: ids(50), command: 'a' })
        .success,
    );
    assert.ok(
      !CreateCommandRunRequestSchema.safeParse({ mode: 'inline', serverIds: ids(51), command: 'a' })
        .success,
    );
  });
});

describe('output paging', () => {
  it('reads strings from a query and bounds the page', () => {
    assert.deepEqual(
      CommandOutputQuerySchema.parse({ stream: 'stdout', offset: '10', limit: '100' }),
      {
        stream: 'stdout',
        offset: 10,
        limit: 100,
      },
    );
    assert.ok(!CommandOutputQuerySchema.safeParse({ stream: 'stdin' }).success);
    assert.ok(!CommandOutputQuerySchema.safeParse({ stream: 'stdout', limit: '262145' }).success);
    assert.ok(!CommandOutputQuerySchema.safeParse({ stream: 'stdout', offset: '-1' }).success);
  });
});

describe('the label of an inline run', () => {
  it('is the first line that has text, cut at 80 characters', () => {
    assert.equal(commandLabel('\n  \nsystemctl status ssh\nmore'), 'systemctl status ssh');
    assert.equal(commandLabel('x'.repeat(200)).length, 80);
  });
});
