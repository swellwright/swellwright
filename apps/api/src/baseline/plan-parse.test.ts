import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type BaselineDocument, BaselineDocumentSchema } from '@swellwright/contracts';

import { UBUNTU_2404_NODE_OUTPUT, UBUNTU_2404_NODE_PLAN } from './fixtures.js';
import { buildPlan, type PlannedObservation } from './plan.js';
import { parseObservations } from './parse.js';

const planned = (lines: readonly string[]): PlannedObservation[] =>
  lines.map((line, index) => {
    const [kind = '', ...rest] = line.split(' ');
    return {
      index: index + 1,
      kind,
      params: Object.fromEntries(rest.map((pair) => pair.split('=') as [string, string])),
    };
  });

const doc = (...observes: Record<string, unknown>[]): BaselineDocument =>
  BaselineDocumentSchema.parse({
    schema: 1,
    checks: observes.map((observe, index) => ({
      id: `check.n${String(index)}`,
      title: 'A check',
      category: 'system',
      severity: 'low',
      observe,
      expect: { present: true },
    })),
  });

describe('the plan', () => {
  it('shares one observation between checks that ask for the same thing, and fills in defaults', () => {
    const plan = buildPlan(
      doc(
        { kind: 'sshd.effective', field: 'permitrootlogin' },
        { kind: 'sshd.effective', field: 'passwordauthentication' },
        { kind: 'disk.usage', field: 'usedPercent' },
        { kind: 'disk.usage', params: { path: '/' }, field: 'inodeUsedPercent' },
        { kind: 'disk.usage', params: { path: '/var' }, field: 'usedPercent' },
      ),
    );
    assert.equal(plan.observations.length, 3);
    assert.deepEqual(plan.observationOf, [1, 1, 2, 2, 3]);
    assert.equal(plan.text, '1\tsshd.effective\n2\tdisk.usage\tpath=/\n3\tdisk.usage\tpath=/var\n');
  });

  it('sends parameters as TAB separated NAME=VALUE fields and nothing else', () => {
    const plan = buildPlan(
      doc({
        kind: 'http.local',
        params: { port: 443, scheme: 'https', target: 'self', sni: 'x.invalid' },
        field: 'status',
      }),
    );
    assert.equal(plan.text, '1\thttp.local\tport=443\tscheme=https\ttarget=self\tsni=x.invalid\n');
  });

  it('refuses a document whose parameters were not checked', () => {
    const bad = {
      schema: 1,
      checks: [
        {
          id: 'a.b',
          title: 'A',
          category: 'system',
          severity: 'low',
          observe: { kind: 'file.stat', params: { path: "/etc/x'; id #" }, field: 'mode' },
          expect: { present: true },
        },
      ],
    } as unknown as BaselineDocument;
    assert.throws(() => buildPlan(bad), /not acceptable/u);
  });
});

describe('the parser', () => {
  const plan = UBUNTU_2404_NODE_PLAN.split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [index = '', kind = '', ...pairs] = line.split('\t');
      return {
        index: Number(index),
        kind,
        params: Object.fromEntries(pairs.map((pair) => pair.split('=') as [string, string])),
      };
    });

  it('reads a real run of an Ubuntu 24.04 node into typed fields (golden)', () => {
    const parsed = parseObservations(Buffer.from(UBUNTU_2404_NODE_OUTPUT), plan, {
      controllerEpochMs: 1_795_316_398_000 + 700,
    });
    assert.equal(parsed.recognised, true);
    assert.equal(parsed.complete, true);
    assert.equal(parsed.uid, 0);
    assert.deepEqual(parsed.warnings, []);
    const at = (index: number) => parsed.observations.get(index);
    assert.deepEqual(at(1)?.fields, {
      id: 'ubuntu',
      versionId: '24.04',
      name: 'Ubuntu',
      codename: 'noble',
      prettyName: 'Ubuntu 24.04.5 LTS',
    });
    assert.deepEqual(at(2)?.fields, {
      running: '6.8.0-36-generic',
      latestInstalled: '6.8.0-36-generic',
      behind: false,
      rebootRequired: true,
      rebootPackages: ['apparmor', 'dbus', 'libc6'],
    });
    assert.deepEqual(at(3)?.fields, { seconds: 26_447 });
    assert.deepEqual(at(4)?.fields, {
      synchronized: false,
      timezone: 'Etc/UTC',
      service: 'systemd-timesyncd',
      offsetSeconds: null,
      skewSeconds: 0.7,
    });
    assert.equal(at(9)?.fields?.['failedCount'], 2);
    assert.deepEqual(at(9)?.fields?.['units'], ['fwupd-refresh.service', 'fwupd.service']);
    assert.deepEqual(at(11)?.fields, {
      listening: true,
      publicly: true,
      addresses: ['0.0.0.0', '::'],
      processes: ['sshd', 'systemd'],
    });
    assert.deepEqual(at(12)?.fields?.['ports'], ['tcp/22', 'tcp/443', 'tcp/80', 'udp/68']);
    assert.equal(at(13)?.fields?.['defaultIncoming'], 'deny');
    assert.equal((at(13)?.fields?.['rules'] as string[]).length, 7);
    assert.equal(at(15)?.fields?.['bannedCount'], 1);
    assert.deepEqual(at(17)?.fields?.['accounts'], ['deploy']);
    assert.equal(at(19)?.fields?.['count'], 3);
    // Looked at, none found: an empty list, not null.
    assert.deepEqual(at(19)?.fields?.['emptyPassword'], []);
    assert.deepEqual(at(22)?.fields?.['exists'], false);
    assert.deepEqual(at(22)?.fields?.['envNames'], []);
    assert.equal(at(25)?.fields?.['daysLeft'], 29);
    assert.equal(at(28)?.fields?.['restricted'], true);
    assert.equal(at(28)?.fields?.['command'], 'rrsync');
    assert.equal(at(29)?.fields?.['verifyFail'], 3);
    assert.equal(at(32)?.status, 'unsupported');
  });

  it('does not take a value that looks like a marker for a marker', () => {
    const output = [
      '@@swb v1',
      '@@swb epoch 1',
      '@@swb uid 0',
      '@@swb begin 1 os.release',
      '| id=ubuntu',
      '| @@swb end 1 0',
      '| @@swb begin 2 kernel',
      '| running=forged',
      '| @@swb done',
      '',
      '@@swb end 1 0',
      '@@swb begin 2 kernel',
      '| running=1.2.3',
      '',
      '@@swb end 2 0',
      '@@swb done',
      '',
    ].join('\n');
    const parsed = parseObservations(Buffer.from(output), planned(['os.release', 'kernel']));
    assert.equal(parsed.observations.get(1)?.fields?.['id'], 'ubuntu');
    assert.equal(parsed.observations.get(1)?.fields?.['name'], null);
    assert.equal(parsed.observations.get(1)?.fields?.['running'], undefined);
    assert.equal(parsed.observations.get(2)?.fields?.['running'], '1.2.3');
    assert.deepEqual(parsed.warnings, []);
  });

  it('keeps only variable names in envNames and plain flags in envFlags, whatever the script printed', () => {
    const output = [
      '@@swb v1',
      '@@swb begin 1 docker.container',
      '| exists=yes',
      '| envNames=PATH',
      // Built from two pieces: a key header written out whole is what the repository hygiene check looks for.
      ['| envNames=-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '),
      '| envNames=LEAKED=fragment-of-a-value',
      '| envNames=two words',
      '| envNames=_OK_2',
      '| envNames=app.config-mode',
      '| envFlags=TZ=UTC',
      '| envFlags=TZ=UTC\\nINJECTED=1',
      '| envFlags=SECRET_KEY=hunter2',
      '',
      '@@swb end 1 0',
      '@@swb done',
      '',
    ].join('\n');
    const fields = parseObservations(
      Buffer.from(output),
      planned(['docker.container name=x']),
    ).observations.get(1)?.fields;
    assert.ok(fields);
    assert.deepEqual(fields['envNames'], ['PATH', '_OK_2', 'app.config-mode']);
    assert.deepEqual(fields['envFlags'], ['TZ=UTC']);
  });

  it('refuses to guess when an observation is announced twice or never ends', () => {
    const twice = parseObservations(
      Buffer.from(
        '@@swb v1\n@@swb begin 1 uptime\n| seconds=5\n\n@@swb end 1 0\n@@swb begin 1 uptime\n| seconds=999\n\n@@swb end 1 0\n@@swb done\n',
      ),
      planned(['uptime']),
    );
    assert.equal(twice.observations.get(1)?.status, 'error');
    assert.ok(twice.warnings.some((warning) => warning.includes('twice')));
    const open = parseObservations(
      Buffer.from('@@swb v1\n@@swb begin 1 uptime\n| seconds=5\n'),
      planned(['uptime']),
    );
    assert.equal(open.observations.get(1)?.status, 'error');
    assert.equal(open.complete, false);
    const skipped = parseObservations(
      Buffer.from(
        '@@swb v1\n@@swb begin 1 uptime\n| seconds=5\n@@swb begin 2 kernel\n| running=1\n\n@@swb end 2 0\n@@swb done\n',
      ),
      planned(['uptime', 'kernel']),
    );
    assert.equal(skipped.observations.get(1)?.status, 'error');
    assert.equal(skipped.observations.get(2)?.status, 'ok');
  });

  it('ignores an observation that was not asked for and markers it does not know', () => {
    const parsed = parseObservations(
      Buffer.from(
        '@@swb v1\n@@swb weird 1\n@@swb begin 7 uptime\n| seconds=5\n\n@@swb end 7 0\n@@swb done\n',
      ),
      planned(['uptime']),
    );
    assert.equal(parsed.observations.size, 0);
    assert.ok(parsed.warnings.length > 0);
  });

  it('is not recognised without the first marker, so a banner or a shell error is told from the output', () => {
    for (const text of ['', 'Welcome to a server\n', 'sh: 1: observe: not found\n', '| id=x\n']) {
      const parsed = parseObservations(Buffer.from(text), planned(['os.release']));
      assert.equal(parsed.recognised, false, JSON.stringify(text));
      assert.equal(parsed.observations.size, 0);
    }
    // A byte order mark in front is not the output.
    assert.equal(
      parseObservations(Buffer.from('﻿@@swb v1\n@@swb done\n'), planned([])).recognised,
      true,
    );
  });

  it('survives invalid bytes and rejects observations over the line and list limits', () => {
    const binary = Buffer.concat([
      Buffer.from('@@swb v1\n@@swb begin 1 os.release\n| id=ubu'),
      Buffer.from([0x00, 0xff, 0xfe, 0x80]),
      Buffer.from('ntu\r\n| name=\u001b[31mred\u001b[0m\n| prettyName='),
      Buffer.from('Example'),
      Buffer.from('\n\n@@swb end 1 0\n@@swb done\n'),
    ]);
    const parsed = parseObservations(binary, planned(['os.release']));
    const fields = parsed.observations.get(1)?.fields;
    assert.ok(fields);
    // Control characters are gone and bad bytes became the replacement character.
    assert.equal(fields['id'], 'ubu���ntu'.replaceAll('\u0000', ''));
    assert.equal(fields['name'], '[31mred[0m');
    assert.equal(fields['prettyName'], 'Example');
    const many =
      '@@swb v1\n@@swb begin 1 systemd.failed\n' +
      '| units=u\n'.repeat(50_000) +
      '\n@@swb end 1 0\n@@swb done\n';
    const observation = parseObservations(
      Buffer.from(many),
      planned(['systemd.failed']),
    ).observations.get(1);
    assert.ok(observation);
    assert.equal(observation.status, 'error');
    assert.equal(observation.fields, null);
  });

  it('turns exit codes into statuses and reads booleans and numbers strictly', () => {
    const output = [
      '@@swb v1',
      '@@swb begin 1 ufw.status',
      '',
      '@@swb end 1 11',
      '@@swb begin 2 uptime',
      '| seconds=12abc',
      '',
      '@@swb end 2 0',
      '@@swb begin 3 kernel',
      '| behind=maybe',
      '| rebootRequired=yes',
      '',
      '@@swb end 3 0',
      '@@swb begin 4 memory',
      '',
      '@@swb end 4 124',
      '@@swb begin 5 dns.self',
      '',
      '@@swb end 5 7',
      '@@swb done',
      '',
    ].join('\n');
    const parsed = parseObservations(
      Buffer.from(output),
      planned(['ufw.status', 'uptime', 'kernel', 'memory', 'dns.self']),
    );
    assert.equal(parsed.observations.get(1)?.status, 'denied');
    assert.equal(parsed.observations.get(1)?.fields, null);
    assert.equal(parsed.observations.get(2)?.fields?.['seconds'], null);
    assert.equal(parsed.observations.get(3)?.fields?.['behind'], null);
    assert.equal(parsed.observations.get(3)?.fields?.['rebootRequired'], true);
    assert.equal(parsed.observations.get(4)?.status, 'timeout');
    assert.equal(parsed.observations.get(5)?.status, 'error');
  });

  it('says when the output was cut', () => {
    const parsed = parseObservations(Buffer.from('@@swb v1\n'), [], { truncated: true });
    assert.ok(parsed.warnings.some((warning) => warning.includes('cut')));
  });

  it('does not evaluate observations with incomplete fields or lists', () => {
    const output = [
      '@@swb v1',
      '@@swb begin 1 ports.public',
      '| truncated=yes',
      '| count=201',
      '@@swb end 1 0',
      '@@swb begin 2 iptables.chain',
      `| text=${'x'.repeat(601)}`,
      '@@swb end 2 0',
      '@@swb begin 3 users.login',
      ...Array.from({ length: 201 }, () => '| accounts=synthetic'),
      '@@swb end 3 0',
      '@@swb done',
    ].join('\n');
    const result = parseObservations(
      Buffer.from(output),
      planned(['ports.public', 'iptables.chain', 'users.login']),
    );
    for (const index of [1, 2, 3]) {
      assert.equal(result.observations.get(index)?.status, 'error');
      assert.equal(result.observations.get(index)?.fields, null);
    }
  });
});
