// Detached steps and the sudo wrapper against the in-process server running a real POSIX shell. Linux and macOS only
// (Windows has no /bin/sh); CI runs them on Linux. The same scenarios run against a real sshd in
// steps.integration.test.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';

import { SshConnection } from './connection.js';
import { SshStepError } from './errors.js';
import { defineStepScenarios } from './step-scenarios.js';
import { STATUS_SCRIPT } from './step-scripts.js';
import { getStepStatus, startDetachedStep } from './steps.js';
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
