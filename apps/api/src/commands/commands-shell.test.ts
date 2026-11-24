import 'reflect-metadata';

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  type FakeSudo,
  installFakeSudo,
  startCuttableProxy,
  type CuttableProxy,
  TestSshServer,
} from '@swellwright/ssh/test-support';

import { databaseUrl } from '../test-support.js';
import { findShell, shellHandler } from '../servers/ssh-test-support.js';
import { loadBuiltinScripts } from './builtin-scripts.js';
import { Harness, LOGIN, PASSPHRASE, targetOf, until } from './commands-test-support.js';

const shell = findShell();
/** A directory with a `setsid`, for a machine that has none of its own (the tests of the author's Windows machine). */
const shimPath = process.env['SW_TEST_SHELL_PATH'];
const shellPath = (): string[] => [
  ...(shimPath === undefined ? [] : [shimPath]),
  ...(shell?.extraPath ?? []),
];

function hasStepTools(): boolean {
  if (shell === undefined) {
    return false;
  }
  const result = spawnSync(
    shell.shell,
    ['-c', 'command -v setsid && command -v sha256sum && command -v base64'],
    {
      env: { PATH: [...shellPath(), process.env['PATH'] ?? ''].join(delimiter) },
      encoding: 'utf8',
    },
  );
  return result.status === 0;
}

const available = hasStepTools();
const posix = process.platform !== 'win32';

/** A server whose commands go to a real shell, with the home directory of its own and a stand-in `sudo`. */
interface RealHost {
  readonly server: TestSshServer;
  readonly home: string;
  readonly sudo: FakeSudo;
}

async function startRealHost(): Promise<RealHost> {
  if (shell === undefined) {
    throw new Error('no shell');
  }
  const home = mkdtempSync(join(tmpdir(), 'sw-real-host-'));
  const sudo = installFakeSudo({ password: 'unused-password', passwordless: true });
  const server = await TestSshServer.start({
    users: { runner: { password: LOGIN } },
    exec: shellHandler({ shell: shell.shell, home, path: [sudo.dir, ...shellPath()] }),
  });
  return { server, home, sudo };
}

/** Whether a process is still there; one that is dead and waits to be collected (a zombie) is gone for this purpose. */
const alive = (pid: number): boolean => {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = state.stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
};

const stepDirectories = (host: RealHost): string[] => {
  const base = join(host.home, '.swellwright', 'steps');
  return existsSync(base) ? readdirSync(base) : [];
};

/**
 * The whole stack against a real POSIX shell, as the steps of the SSH layer run on a real server: the scripts start under
 * `setsid`, their output is read by offset, and what they were given as parameters is only ever data. Where the machine has
 * no `setsid` (the author's Windows machine) the suite is skipped; CI runs it on Linux.
 */
describe('commands against a real shell', { skip: !databaseUrl || !available }, () => {
  const h = new Harness();
  const hosts: RealHost[] = [];
  const proxies: CuttableProxy[] = [];
  const outside = mkdtempSync(join(tmpdir(), 'sw-real-outside-'));

  const realServer = async (
    name: string,
    host?: RealHost,
  ): Promise<{ id: string; host: RealHost }> => {
    const real = host ?? (await startRealHost());
    if (host === undefined) {
      hosts.push(real);
    }
    const id = await h.server(real.server, { name, fingerprint: real.server.hostKeyFingerprint });
    return { id, host: real };
  };

  before(async () => {
    await h.open({ SW_COMMAND_POLL_MS: '100', SW_SSH_COMMAND_TIMEOUT_SECONDS: '30' });
  });
  after(async () => {
    for (const proxy of proxies) {
      await proxy.close();
    }
    await h.close();
    for (const host of hosts) {
      await host.server.close();
      host.sudo.cleanup();
      rmSync(host.home, { recursive: true, force: true });
    }
    rmSync(outside, { recursive: true, force: true });
  });

  it('runs a command on three real servers at once, each with its own output, and removes its records', async () => {
    const servers = [
      await realServer('real-a'),
      await realServer('real-b'),
      await realServer('real-c'),
    ];
    const run = await h.createRun(
      h.operator,
      h.inline(
        servers.map((s) => s.id),
        'echo "to stdout from $(basename "$HOME" | cut -c1-8)"\necho "to stderr" >&2\nexit 0\n',
      ),
    );
    const done = await h.finished(run.id, 60_000);
    assert.equal(done.state, 'succeeded');
    for (const target of done.targets) {
      assert.equal(target.state, 'succeeded');
      assert.equal(target.exitCode, 0);
      assert.match(target.stdout.tail, /^to stdout from sw-real-\n$/u);
      assert.equal(target.stderr.tail, 'to stderr\n');
    }
    for (const { host } of servers) {
      await until('the record to go', () => stepDirectories(host).length === 0, 10_000);
    }
  });

  it('reports the exit status of a script that fails, and keeps what it printed on both streams', async () => {
    const { id } = await realServer('real-fail');
    const done = await h.finished(
      (await h.createRun(h.operator, h.inline([id], 'echo before\necho oops >&2\nexit 7\n'))).id,
      60_000,
    );
    assert.equal(done.state, 'failed');
    assert.equal(targetOf(done, 0).exitCode, 7);
    assert.equal(targetOf(done, 0).stdout.tail, 'before\n');
    assert.equal(targetOf(done, 0).stderr.tail, 'oops\n');
  });

  it('delivers hostile parameter values as data: nothing is executed, nothing is written', async () => {
    const { id, host } = await realServer('real-hostile');
    const marker = join(outside, 'pwned');
    const script = await h.script(h.operator, {
      name: 'echo note',
      description: 'Prints its parameter between brackets.',
      dangerLevel: 'read',
      sudo: false,
      parameters: [{ name: 'note', label: 'Note', type: 'string', required: true, maxLength: 500 }],
      body: 'printf "[%s]" "$SW_PARAM_NOTE"\n',
    });
    const payloads = [
      `'; touch '${marker}'; echo '`,
      `$(touch '${marker}')`,
      `\`touch '${marker}'\``,
      `"; touch "${marker}"; "`,
      `line one\n'; touch '${marker}'\nline three`,
      "it's a \\ back\\slash and a $HOME and ${IFS} and *",
      '-n -e \\x41',
    ];
    for (const note of payloads) {
      const done = await h.finished(
        (
          await h.createRun(h.operator, {
            mode: 'script',
            serverIds: [id],
            scriptId: script.id,
            parameters: { note },
          })
        ).id,
        60_000,
      );
      assert.equal(done.state, 'succeeded', JSON.stringify(note));
      assert.equal(targetOf(done, 0).stdout.tail, `[${note}]`, JSON.stringify(note));
      assert.ok(!existsSync(marker), `a payload ran a command: ${JSON.stringify(note)}`);
    }
    await until('the records to go', () => stepDirectories(host).length === 0, 10_000);
  });

  it('refuses hostile values before anything is sent when the script has a pattern', async () => {
    const { id, host } = await realServer('real-pattern');
    const script = await h.script(h.operator, {
      name: 'pattern only',
      description: 'Takes a unit name.',
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
      body: 'echo "$SW_PARAM_UNIT"\n',
    });
    for (const unit of ['a.service; touch /tmp/x', '$(id).service', 'a.service\nb.service']) {
      const reply = await h.operator.post('/command-runs', {
        mode: 'script',
        serverIds: [id],
        scriptId: script.id,
        parameters: { unit },
      });
      assert.equal(reply.status, 400);
    }
    assert.equal(host.server.execLog.length, 0, 'the server heard nothing');
  });

  it('runs a script through sudo (the stand-in), and a login that is not root needs it declared', async () => {
    const { id } = await realServer('real-sudo');
    const done = await h.finished(
      (await h.createRun(h.operator, h.inline([id], 'echo through sudo\n', { sudo: true }))).id,
      60_000,
    );
    assert.equal(done.state, 'succeeded');
    assert.equal(targetOf(done, 0).stdout.tail, 'through sudo\n');
  });

  it('follows a script that writes over time, and reads the end once it has finished', async () => {
    const { id } = await realServer('real-slow');
    const run = await h.createRun(
      h.operator,
      h.inline([id], 'echo first\nsleep 4\necho second\nsleep 1\necho third\n'),
    );
    const middle = await h.waitFor(
      run.id,
      'the first line',
      (r) => targetOf(r, 0).stdout.storedBytes > 0,
      30_000,
    );
    assert.equal(middle.state, 'running');
    assert.equal(
      targetOf(middle, 0).stdout.tail,
      'first\n',
      'what the script wrote so far, while it runs',
    );
    const done = await h.finished(run.id, 60_000);
    assert.equal(targetOf(done, 0).stdout.tail, 'first\nsecond\nthird\n');
  });

  it('continues after a cut connection without losing or repeating a byte', async () => {
    const real = await startRealHost();
    hosts.push(real);
    const proxy = await startCuttableProxy('127.0.0.1', real.server.port);
    proxies.push(proxy);
    const id = await h.server(proxy, {
      name: 'real-cut',
      fingerprint: real.server.hostKeyFingerprint,
    });
    const run = await h.createRun(h.operator, h.inline([id], 'echo one\nsleep 2\necho two\n'));
    await h.waitFor(run.id, 'the first line', (r) => targetOf(r, 0).stdout.storedBytes > 0, 30_000);
    proxy.cut();
    const done = await h.finished(run.id, 60_000);
    assert.equal(done.state, 'succeeded');
    assert.equal(targetOf(done, 0).stdout.tail, 'one\ntwo\n');
  });

  it(
    'stops a script that sleeps, with TERM to its whole process group',
    { skip: !posix },
    async () => {
      const { id, host } = await realServer('real-cancel');
      // A sleeper that is not this script's: the other test files, and the SSH package beside them, run `sleep 60` of
      // their own on this machine. What is checked is the process this script started (it says its pid), not every
      // sleeper of the machine, so this one must not matter.
      const bystander = spawn('sleep', ['60'], { stdio: 'ignore' });
      try {
        const run = await h.createRun(
          h.operator,
          h.inline(
            [id],
            'sleep 60 &\necho $! > "$HOME/sleeper.pid"\necho started\nwait\necho not reached\n',
          ),
        );
        await h.waitFor(
          run.id,
          'the script to start',
          (r) => targetOf(r, 0).stdout.tail === 'started\n',
          30_000,
        );
        const sleeper = Number(readFileSync(join(host.home, 'sleeper.pid'), 'utf8').trim());
        assert.ok(
          Number.isInteger(sleeper) && sleeper > 1,
          'the script said the pid of its sleeper',
        );
        assert.ok(alive(sleeper), 'the sleeper is there while the script runs');
        assert.equal((await h.operator.post(`/command-runs/${run.id}/cancel`)).status, 200);
        const done = await h.finished(run.id, 60_000);
        assert.equal(done.state, 'cancelled');
        assert.equal(targetOf(done, 0).state, 'cancelled');
        assert.equal(targetOf(done, 0).exitCode, 143);
        assert.equal(targetOf(done, 0).stdout.tail, 'started\n');
        await until(
          `the sleeper ${String(sleeper)} of the script to be gone (${host.home})`,
          () => !alive(sleeper),
          10_000,
        );
        assert.ok(
          bystander.pid !== undefined && alive(bystander.pid),
          'what the script did not start is left alone',
        );
      } finally {
        bystander.kill();
      }
    },
  );

  it('stops a script that outlives its time limit', { skip: !posix }, async () => {
    const { id } = await realServer('real-timeout');
    const done = await h.finished(
      (await h.createRun(h.operator, h.inline([id], 'sleep 60\n', { timeoutSeconds: 2 }))).id,
      60_000,
    );
    assert.equal(done.state, 'failed');
    assert.equal(targetOf(done, 0).errorCode, 'timeout');
    assert.equal(targetOf(done, 0).exitCode, 143);
  });

  it('cuts the output at the limit and leaves the whole of it on the server', async () => {
    const small = new Harness();
    await small.open({ SW_COMMAND_POLL_MS: '100', SW_COMMAND_OUTPUT_LIMIT_KIB: '16' });
    const real = await startRealHost();
    hosts.push(real);
    try {
      const id = await small.server(real.server, {
        name: 'real-big',
        fingerprint: real.server.hostKeyFingerprint,
      });
      const done = await small.finished(
        (
          await small.createRun(
            small.operator,
            small.inline([id], 'head -c 40000 /dev/zero | tr "\\0" x\n'),
          )
        ).id,
        60_000,
      );
      const target = done.targets[0];
      assert.ok(target);
      assert.equal(target.state, 'succeeded');
      assert.equal(target.stdout.storedBytes, 16 * 1024);
      assert.equal(target.stdout.totalBytes, 40_000);
      assert.equal(target.stdout.truncated, true);
      assert.equal(stepDirectories(real).length, 1, 'the only complete copy is still there');
    } finally {
      await small.close();
    }
  });

  it('takes a run up again after a restart of the server, with the output whole', async () => {
    const { id } = await realServer('real-restart');
    const run = await h.createRun(h.operator, h.inline([id], 'echo before\nsleep 3\necho after\n'));
    await h.waitFor(
      run.id,
      'the first line',
      (r) => targetOf(r, 0).stdout.tail === 'before\n',
      30_000,
    );
    await h.restart({ SW_COMMAND_POLL_MS: '100', SW_SSH_COMMAND_TIMEOUT_SECONDS: '30' });
    await h.stepUp(h.owner, 'owner');
    assert.equal((await h.owner.post('/vault/unseal', { passphrase: PASSPHRASE })).status, 200);
    const done = await h.finished(run.id, 60_000);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.targets[0]));
    assert.equal(targetOf(done, 0).stdout.tail, 'before\nafter\n');
  });

  it('runs every built-in script on a real shell to its end, reading nothing it should not, and writing nothing', async () => {
    const { id, host } = await realServer('real-builtin');
    const list = (await h.owner.get('/scripts')).body as {
      scripts: { id: string; name: string; builtin: boolean }[];
    };
    const builtin = list.scripts.filter((script) => script.builtin);
    assert.equal(builtin.length, loadBuiltinScripts().length);
    const before = readdirSync(host.home);
    for (const script of builtin) {
      const done = await h.finished(
        (await h.createRun(h.operator, { mode: 'script', serverIds: [id], scriptId: script.id }))
          .id,
        90_000,
      );
      const target = done.targets[0];
      assert.ok(target, script.name);
      // 0: it ran. 3: a tool it needs is not on this machine (and it says so). Anything else is a defect of the script.
      assert.ok(
        target.state === 'succeeded' || (target.state === 'failed' && target.exitCode === 3),
        `${script.name}: ${target.state} ${String(target.exitCode)} ${target.stderr.tail}`,
      );
      assert.ok(
        target.stdout.storedBytes > 0 || target.stderr.storedBytes > 0,
        `${script.name} says something`,
      );
      assert.ok(target.stdout.storedBytes < 256 * 1024, `${script.name} keeps its output bounded`);
    }
    await until('the records to go', () => stepDirectories(host).length === 0, 20_000);
    assert.deepEqual(
      readdirSync(host.home).filter((name) => name !== '.swellwright'),
      before.filter((name) => name !== '.swellwright'),
      'the built-in scripts left nothing in the home directory',
    );
  });
});
