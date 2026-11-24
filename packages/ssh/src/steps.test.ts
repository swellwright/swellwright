// Detached steps and the sudo wrapper against the in-process server running a real POSIX shell. Linux and macOS only
// (Windows has no /bin/sh); CI runs them on Linux. The same scenarios run against a real sshd in
// steps.integration.test.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { SshConnection } from './connection.js';
import { SshStepError } from './errors.js';
import { defineStepScenarios } from './step-scenarios.js';
import { STATUS_SCRIPT, WRAPPER_SCRIPT } from './step-scripts.js';
import { shellQuote } from './shell.js';
import { getStepStatus, startDetachedStep, waitForStep } from './steps.js';
import {
  installFakeSudo,
  shExecHandler,
  startCuttableProxy,
  TestSshServer,
  type FakeSudo,
} from './test-support/index.js';
import { IS_ROOT, NO_POSIX_SHELL, USERS, targetFor, tempDir } from './test-util.js';

const FAKE_SUDO_PASSWORD = 'fake-sudo-pw-7';

function commandExists(name: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

// The wrapper needs setsid, base64 and sha256sum (util-linux and coreutils: every Debian/Ubuntu server has them).
const TOOLS_MISSING =
  NO_POSIX_SHELL !== false
    ? NO_POSIX_SHELL
    : ['setsid', 'base64', 'sha256sum', 'tail', 'head', 'wc'].every((tool) => commandExists(tool))
      ? false
      : 'needs setsid, base64 and sha256sum';

defineStepScenarios(
  'detached steps (in-process server, real shell, fake sudo)',
  async () => {
    const home = tempDir('sw-ssh-steps-home-');
    // Like the real sudo of Debian and Ubuntu, the fake one gives the command another HOME than the caller's.
    const sudo = installFakeSudo({
      password: FAKE_SUDO_PASSWORD,
      resetHome: `${home.path}-sudo-home`,
    });
    const server = await TestSshServer.start({
      users: USERS,
      exec: shExecHandler({ home: home.path, extraPath: sudo.dir }),
    });
    const proxy = await startCuttableProxy(server.host, server.port);
    return {
      connect: () => SshConnection.connect(targetFor(server)),
      connectCuttable: async () => ({
        connection: await SshConnection.connect(
          targetFor(server, { host: proxy.host, port: proxy.port }),
        ),
        cut: proxy.cut,
      }),
      baseDir: join(home.path, 'steps-test'),
      sudo: {
        options: { password: FAKE_SUDO_PASSWORD },
        elevatesTo: userInfo().username,
        elevates: false,
      },
      close: async () => {
        await proxy.close();
        await server.close();
        sudo.cleanup();
        home.cleanup();
      },
    };
  },
  { skip: TOOLS_MISSING },
);

// As root sudo is never asked for a password, so the wrapper takes its shortcut and these cases do not apply.
const SUDO_SKIP =
  TOOLS_MISSING !== false
    ? TOOLS_MISSING
    : IS_ROOT
      ? 'running as root: sudo asks root for nothing'
      : false;

describe('the sudo wrapper', { skip: SUDO_SKIP }, () => {
  const home = tempDir('sw-ssh-sudo-home-');
  let connection: SshConnection;
  let strict: FakeSudo;
  let lenient: FakeSudo;
  let strictServer: TestSshServer;
  let lenientServer: TestSshServer;
  let strictConnection: SshConnection;
  let lenientConnection: SshConnection;

  before(async () => {
    strict = installFakeSudo({ password: FAKE_SUDO_PASSWORD });
    lenient = installFakeSudo({ password: FAKE_SUDO_PASSWORD, passwordless: true });
    strictServer = await TestSshServer.start({
      users: USERS,
      exec: shExecHandler({ home: home.path, extraPath: strict.dir }),
    });
    lenientServer = await TestSshServer.start({
      users: USERS,
      exec: shExecHandler({ home: home.path, extraPath: lenient.dir }),
    });
    strictConnection = await SshConnection.connect(targetFor(strictServer));
    lenientConnection = await SshConnection.connect(targetFor(lenientServer));
    connection = strictConnection;
  });
  after(async () => {
    strictConnection.close();
    lenientConnection.close();
    await strictServer.close();
    await lenientServer.close();
    strict.cleanup();
    lenient.cleanup();
    home.cleanup();
  });

  it('runs the command through sudo -S with the password on standard input only', async () => {
    const result = await connection.exec('echo ran-as-root', {
      sudo: { password: FAKE_SUDO_PASSWORD },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'ran-as-root\n');
    const log = strict.log();
    assert.ok(log.includes('mode:password-accepted'));
    // What the fake sudo saw of its own invocations: arguments and environment. The password is in neither.
    assert.ok(
      !log.includes(FAKE_SUDO_PASSWORD),
      'the password reached the arguments or the environment of sudo',
    );
    const logged = strictServer.execLog.at(-1);
    assert.ok(logged);
    assert.ok(!logged.command.includes(FAKE_SUDO_PASSWORD));
  });

  it('hands the command its own standard input untouched, not the password line', async () => {
    const result = await connection.exec('cat', {
      sudo: { password: FAKE_SUDO_PASSWORD },
      stdin: 'payload\nsecond line\n',
    });
    assert.equal(result.stdout, 'payload\nsecond line\n');
  });

  it('drops the password line when sudo needs none, so a command that reads its input never sees it', async () => {
    const withInput = await lenientConnection.exec('cat', {
      sudo: { password: FAKE_SUDO_PASSWORD },
      stdin: 'only this',
    });
    assert.equal(withInput.stdout, 'only this');
    const withoutInput = await lenientConnection.exec('cat', {
      sudo: { password: FAKE_SUDO_PASSWORD },
    });
    assert.equal(withoutInput.stdout, '');
    assert.ok(lenient.log().includes('mode:passwordless'));
    assert.ok(!lenient.log().includes(FAKE_SUDO_PASSWORD));
  });

  it('reports a wrong password as a failed command without echoing it', async () => {
    const wrong = 'not-the-password-1';
    const result = await connection.exec('echo should-not-run', { sudo: { password: wrong } });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(wrong));
    assert.ok(!strict.log().includes(wrong));
  });

  it('does not hang when sudo wants a password and none was given', async () => {
    const result = await connection.exec('echo should-not-run', { sudo: {}, timeoutMs: 10_000 });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /password is required/u);
  });

  it('does not start a step with a wrong sudo password, leaves nothing behind and keeps the password out of the error', async () => {
    const wrong = 'not-the-password-2';
    const baseDir = join(home.path, 'steps-wrong-sudo');
    await assert.rejects(
      startDetachedStep(connection, {
        id: 'wrong-sudo',
        script: 'echo no\n',
        baseDir,
        sudo: { password: wrong },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SshStepError);
        assert.equal(error.code, 'ssh_step_failed');
        assert.ok(!error.message.includes(wrong));
        return true;
      },
    );
    await assert.rejects(
      getStepStatus(connection, 'wrong-sudo', baseDir),
      (error: unknown) => error instanceof SshStepError && error.code === 'ssh_step_not_found',
    );
  });
});

// The race a loaded machine showed once: the step finishes between the status script's look at the exit marker and its
// look at the process. The wrapper writes the marker before it exits, so the second look must find it.
describe(
  'the status of a step that finishes while it is being read',
  { skip: TOOLS_MISSING },
  () => {
    it('reports exited, not lost, when the marker appears after the first look and the process is already gone', () => {
      const base = tempDir();
      try {
        const dir = join(base.path, 'raced');
        mkdirSync(dir, { recursive: true });
        // A pid that is certainly not a live process of this step, and no marker yet.
        writeFileSync(join(dir, 'pid'), '2147483646\n');
        // The first `alive` call publishes the marker, as the wrapper would a moment before the process disappeared,
        // then answers that the process is gone.
        const script = STATUS_SCRIPT.replace(
          'alive() {',
          `alive() { printf '4\\n2026-01-01T00:00:00Z\\n' > "$D/exit"; return 1; }\nalive_unused() {`,
        );
        const out = spawnSync('/bin/sh', ['-c', script, 'swellwright-status', base.path, 'raced'], {
          encoding: 'utf8',
        });
        assert.match(out.stdout, /^state=exited$/mu);
        assert.match(out.stdout, /^code=4$/mu);
      } finally {
        base.cleanup();
      }
    });

    // What a reader fetches once a step is over is bounded by the size the status gave, so a step that is reported as over
    // must be reported with the size it finished with. A script that wrote its last line and ended between the look at
    // the sizes and the look at the exit marker used to be reported as over with the size from before that line, and the
    // line was never read (seen as a flaky CI test: the last line of a run's output was missing).
    it('never reports a step as over with a size that misses what it wrote before it ended', () => {
      const base = tempDir();
      try {
        const dir = join(base.path, 'late');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'pid'), '2147483646\n');
        writeFileSync(join(dir, 'out'), 'first\n');
        // The process is alive. The first `wc` ends the way the step does: right after it has counted, the script writes
        // one more line and the wrapper publishes the exit marker.
        const finishing = [
          'alive() { return 0; }',
          'wc() {',
          '  command wc "$@"',
          '  if [ ! -e "$D/finished" ]; then',
          '    : > "$D/finished"',
          `    printf 'late\\n' >> "$D/out"`,
          `    printf '0\\n2026-01-01T00:00:00Z\\n' > "$D/exit"`,
          '  fi',
          '}',
        ].join('\n');
        const script = STATUS_SCRIPT.replace('D=$1/$2\n', () => `D=$1/$2\n${finishing}\n`);
        assert.notEqual(script, STATUS_SCRIPT, 'the stand-in is in place');
        const look = (): string =>
          spawnSync('/bin/sh', ['-c', script, 'swellwright-status', base.path, 'late'], {
            encoding: 'utf8',
          }).stdout;
        const sizeOf = (report: string): number => Number(/^out=(\d+)$/mu.exec(report)?.[1]);
        const onDisk = (): number => statSync(join(dir, 'out')).size;

        const first = look();
        if (/^state=(exited|lost)$/mu.test(first)) {
          assert.equal(sizeOf(first), onDisk(), `over, with the size it finished with:\n${first}`);
        }
        // The next look, with nothing racing, is over and exact.
        const second = look();
        assert.match(second, /^state=exited$/mu);
        assert.equal(sizeOf(second), 'first\nlate\n'.length);
        assert.equal(sizeOf(second), onDisk());
      } finally {
        base.cleanup();
      }
    });

    it('still reports lost when the process is gone and no marker was ever written', () => {
      const base = tempDir();
      try {
        const dir = join(base.path, 'gone');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'pid'), '2147483646\n');
        const out = spawnSync(
          '/bin/sh',
          ['-c', STATUS_SCRIPT, 'swellwright-status', base.path, 'gone'],
          {
            encoding: 'utf8',
          },
        );
        assert.match(out.stdout, /^state=lost$/mu);
      } finally {
        base.cleanup();
      }
    });
  },
);

// A stand-in for the `mkdir` of uutils coreutils (the default of Ubuntu 25.10 and later), which tells BOTH of two callers
// that race for one path that they made it (measured on real servers in 29 to 57 percent of tight races). For a path
// named `raced-*` the two callers wait for each other and then both succeed; `.claimed`, the wrapper's claim, always
// succeeds. A claim made with mkdir lets such a step run twice; one made with an exclusive create does not.
const RACY_MKDIR = String.raw`#!/bin/sh
last=
for a in "$@"; do last=$a; done
case $last in
  .claimed) exec /bin/mkdir -p "$@" ;;
  */raced-*)
    here=$(dirname "$0")
    key=$(printf '%s' "$last" | tr '/' '_')
    /bin/mkdir -p "$here/barrier"
    : > "$here/barrier/$key.$$"
    n=0
    while [ "$n" -lt 50 ]; do
      c=0
      for f in "$here/barrier/$key".*; do [ -e "$f" ] && c=$((c + 1)); done
      [ "$c" -ge 2 ] && break
      sleep 0.1
      n=$((n + 1))
    done
    exec /bin/mkdir -p "$last" ;;
esac
exec /bin/mkdir "$@"
`;

function installRacyMkdir(): { path: string; cleanup: () => void } {
  const dir = tempDir('sw-ssh-racy-mkdir-');
  const file = join(dir.path, 'mkdir');
  writeFileSync(file, RACY_MKDIR);
  chmodSync(file, 0o755);
  return dir;
}

// A step must never run twice. The launcher already attaches a second caller instead of starting again; this is the
// last line of defence: whatever starts the wrapper a second time, it ends without running the script.
describe('the step wrapper', { skip: TOOLS_MISSING }, () => {
  it('runs the script once, however many times it is started', () => {
    const base = tempDir();
    try {
      const dir = join(base.path, 'once');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'script.sh'), 'echo ran >> "$SWELLWRIGHT_STEP_DIR/counter"\n');
      writeFileSync(join(dir, 'run.sh'), WRAPPER_SCRIPT);
      const first = spawnSync('/bin/sh', [join(dir, 'run.sh'), dir], { encoding: 'utf8' });
      const second = spawnSync('/bin/sh', [join(dir, 'run.sh'), dir], { encoding: 'utf8' });
      assert.equal(first.status, 0);
      assert.equal(second.status, 0, 'a second wrapper ends quietly');
      assert.equal(readFileSync(join(dir, 'counter'), 'utf8'), 'ran\n');
      assert.match(readFileSync(join(dir, 'exit'), 'utf8'), /^0\n/u);
    } finally {
      base.cleanup();
    }
  });

  it('runs the script once even when mkdir tells every caller that it made the directory', () => {
    const racy = installRacyMkdir();
    const base = tempDir();
    try {
      const dir = join(base.path, 'once');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'script.sh'), 'echo ran >> "$SWELLWRIGHT_STEP_DIR/counter"\n');
      writeFileSync(join(dir, 'run.sh'), WRAPPER_SCRIPT);
      const env = { ...process.env, PATH: `${racy.path}:${process.env['PATH'] ?? ''}` };
      const first = spawnSync('/bin/sh', [join(dir, 'run.sh'), dir], { encoding: 'utf8', env });
      const second = spawnSync('/bin/sh', [join(dir, 'run.sh'), dir], { encoding: 'utf8', env });
      assert.equal(first.status, 0);
      assert.equal(second.status, 0, 'a second wrapper ends quietly');
      assert.equal(readFileSync(join(dir, 'counter'), 'utf8'), 'ran\n');
    } finally {
      base.cleanup();
      racy.cleanup();
    }
  });
});

// The launcher of a step has the same duty: of two launches that race for one id only one may create the step, even
// when mkdir says both did (the original report: "does not start a step twice" saw `ran` written twice on a real sshd).
describe('two launches that race for one step id', { skip: TOOLS_MISSING }, () => {
  let racy: ReturnType<typeof installRacyMkdir>;
  let home: ReturnType<typeof tempDir>;
  let server: TestSshServer;
  let connection: SshConnection;

  before(async () => {
    racy = installRacyMkdir();
    home = tempDir('sw-ssh-race-home-');
    server = await TestSshServer.start({
      users: USERS,
      exec: shExecHandler({ home: home.path, extraPath: racy.path }),
    });
    connection = await SshConnection.connect(targetFor(server));
  });
  after(async () => {
    connection.close();
    await server.close();
    racy.cleanup();
    home.cleanup();
  });

  it('start the script once and give the other launch the step that exists', async () => {
    const baseDir = join(home.path, 'steps-race');
    const id = `raced-${Date.now().toString(36)}`;
    const script = 'echo ran >> "$SWELLWRIGHT_STEP_DIR/counter"\nsleep 1\n';
    const [first, second] = await Promise.all([
      startDetachedStep(connection, { id, script, baseDir }),
      startDetachedStep(connection, { id, script, baseDir }),
    ]);
    assert.equal(first.scriptSha256, second.scriptSha256);
    const status = await waitForStep(connection, id, { baseDir, pollMs: 100 });
    assert.equal(status.exitCode, 0);
    const counter = await connection.exec(`cat ${shellQuote(`${baseDir}/${id}/counter`)}`);
    assert.equal(counter.stdout, 'ran\n');
  });
});
