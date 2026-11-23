/* eslint-disable @typescript-eslint/no-floating-promises --
   node:test registers suites and tests with top-level calls whose promises are not awaited; eslint.config.js turns
   the same rule off for *.test.ts. */

// The scenarios every detached-step implementation has to pass, written once and run twice: against the in-process
// server with a real POSIX shell (steps.test.ts, in CI on Linux) and against a real sshd (steps.integration.test.ts,
// when SW_TEST_SSH_* is set). They are tests, not library code: nothing here is part of the public API.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, before, after, describe, it } from 'node:test';

import type { SshConnection } from './connection.js';
import { SshConnectionLostError, SshError, SshInputError, SshStepError } from './errors.js';
import { shellQuote } from './shell.js';
import {
  cancelStep,
  getStepStatus,
  readStepOutput,
  removeStep,
  removeStepSecrets,
  startDetachedStep,
  waitForStep,
} from './steps.js';
import type { StepOutputChunk, SudoOptions } from './types.js';
import { sleep, until } from './test-util.js';

export interface StepEnvironment {
  /** Opens a connection to the server under test. */
  connect: () => Promise<SshConnection>;
  /** Opens a connection through a forwarder that `cut()` kills at once. */
  connectCuttable: () => Promise<{ connection: SshConnection; cut: () => void }>;
  /** A directory the tests may fill and delete: `/var/lib/swellwright-test/steps`, or a temporary one. */
  baseDir: string;
  /** Present when sudo can be exercised. `elevatesTo` is the user a sudo job reports from `id -un`. */
  sudo?: { options: SudoOptions; elevatesTo: string; elevates: boolean };
  /** Called after the suite. */
  close: () => Promise<void>;
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
let counter = 0;
const nextId = (label: string): string =>
  `${label}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

const text = (chunks: readonly StepOutputChunk[], stream: 'stdout' | 'stderr'): string =>
  Buffer.concat(
    chunks.filter((chunk) => chunk.stream === stream).map((chunk) => chunk.data),
  ).toString('utf8');

export function defineStepScenarios(
  name: string,
  open: () => Promise<StepEnvironment>,
  options: { skip?: string | false } = {},
): void {
  describe(name, { skip: options.skip ?? false }, () => {
    let env: StepEnvironment;
    let conn: SshConnection;
    let baseDir: string;

    // A guard for the cleanup below, which deletes a directory tree as the SSH user (or root).
    const assertDisposable = (path: string): void => {
      assert.match(path, /^\/[^/]+\/[^/]+\/.+/u, `refusing to clean up ${path}`);
      assert.ok(
        path.includes('test'),
        `refusing to clean up ${path}: it does not look like a test directory`,
      );
    };

    const cleanup = async (): Promise<void> => {
      assertDisposable(baseDir);
      const script =
        'B=$1; for p in "$B"/*/pid "$B"/*/*/pid; do [ -f "$p" ] || continue; kill -s KILL -- "-$(cat "$p")" 2>/dev/null; done; rm -rf "$B"';
      await conn.exec(
        `sh -c ${shellQuote(script)} swellwright-test-cleanup ${shellQuote(baseDir)}`,
        {
          ...(env.sudo === undefined ? {} : { sudo: env.sudo.options }),
          timeoutMs: 30_000,
        },
      );
    };

    before(async () => {
      env = await open();
      baseDir = env.baseDir;
      conn = await env.connect();
      await cleanup();
    });
    afterEach(async () => {
      await cleanup();
    });
    after(async () => {
      await cleanup();
      conn.close();
      await env.close();
    });

    const run = async (
      script: string,
      extra: {
        stdin?: string;
        env?: Record<string, string>;
        secrets?: Record<string, string>;
        id?: string;
        sudo?: SudoOptions;
      } = {},
    ): Promise<{
      id: string;
      chunks: StepOutputChunk[];
      status: Awaited<ReturnType<typeof waitForStep>>;
    }> => {
      const id = extra.id ?? nextId('run');
      await startDetachedStep(conn, {
        id,
        script,
        baseDir,
        ...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
        ...(extra.env === undefined ? {} : { env: extra.env }),
        ...(extra.secrets === undefined ? {} : { secrets: extra.secrets }),
        ...(extra.sudo === undefined ? {} : { sudo: extra.sudo }),
      });
      const chunks: StepOutputChunk[] = [];
      const status = await waitForStep(conn, id, {
        baseDir,
        pollMs: 100,
        onOutput: (chunk) => {
          chunks.push(chunk);
        },
      });
      return { id, chunks, status };
    };

    it('runs a script detached and reports output, exit code, times and sizes', async () => {
      const script = 'echo to-out\necho to-err >&2\nexit 3\n';
      const id = nextId('basic');
      const started = await startDetachedStep(conn, { id, script, baseDir });
      assert.equal(started.id, id);
      assert.equal(started.scriptSha256, sha256(script));
      assert.ok(started.state === 'running' || started.state === 'exited');
      assert.match(started.startedAt ?? '', ISO);

      const chunks: StepOutputChunk[] = [];
      const final = await waitForStep(conn, id, {
        baseDir,
        pollMs: 100,
        onOutput: (chunk) => {
          chunks.push(chunk);
        },
      });
      assert.equal(final.state, 'exited');
      assert.equal(final.exitCode, 3);
      assert.match(final.finishedAt ?? '', ISO);
      assert.ok((final.finishedAt ?? '') >= (final.startedAt ?? 'x'));
      assert.equal(final.stdoutBytes, 7);
      assert.equal(final.stderrBytes, 7);
      assert.equal(text(chunks, 'stdout'), 'to-out\n');
      assert.equal(text(chunks, 'stderr'), 'to-err\n');
      assert.deepEqual(await getStepStatus(conn, id, baseDir), final);
    });

    it('records the exit code of the script, including death by signal', async () => {
      for (const code of [0, 1, 42, 255]) {
        const result = await run(`exit ${String(code)}\n`);
        assert.equal(result.status.state, 'exited');
        assert.equal(result.status.exitCode, code);
      }
      const killed = await run('kill -9 $$\n');
      assert.equal(killed.status.state, 'exited');
      assert.equal(killed.status.exitCode, 137);
    });

    it('reads output by byte offset: pieces add up, the end is flagged, a late reader loses nothing', async () => {
      const script =
        'i=0; while [ $i -lt 40 ]; do echo "line $i"; i=$((i + 1)); done\nsleep 1\necho tail\n';
      const expected = `${Array.from({ length: 40 }, (_, index) => `line ${String(index)}\n`).join('')}tail\n`;
      const id = nextId('offsets');
      await startDetachedStep(conn, { id, script, baseDir });

      // While the step runs, a read does not claim the end.
      await sleep(300);
      const early = await readStepOutput(conn, id, { stream: 'stdout', fromOffset: 0, baseDir });
      assert.equal(early.eof, false);

      await waitForStep(conn, id, { baseDir, pollMs: 100 });
      const pieces: string[] = [];
      let offset = 0;
      let eofSeen = false;
      for (let guard = 0; guard < 200 && !eofSeen; guard += 1) {
        const slice = await readStepOutput(conn, id, {
          stream: 'stdout',
          fromOffset: offset,
          maxBytes: 7,
          baseDir,
        });
        assert.equal(slice.nextOffset, offset + slice.data.length);
        assert.ok(slice.data.length <= 7);
        pieces.push(slice.data.toString('utf8'));
        offset = slice.nextOffset;
        eofSeen = slice.eof;
      }
      assert.ok(eofSeen);
      assert.equal(pieces.join(''), expected);

      const middle = await readStepOutput(conn, id, {
        stream: 'stdout',
        fromOffset: 20,
        maxBytes: 100,
        baseDir,
      });
      assert.equal(middle.data.toString('utf8'), expected.slice(20, 120));
      const past = await readStepOutput(conn, id, {
        stream: 'stdout',
        fromOffset: expected.length + 50,
        baseDir,
      });
      assert.equal(past.data.length, 0);
      assert.equal(past.eof, true);
      const stderr = await readStepOutput(conn, id, { stream: 'stderr', fromOffset: 0, baseDir });
      assert.equal(stderr.data.length, 0);
      assert.equal(stderr.eof, true);
    });

    it('returns output as raw bytes', async () => {
      const result = await run(String.raw`printf '\000\001\377\n'` + '\n');
      const read = await readStepOutput(conn, result.id, {
        stream: 'stdout',
        fromOffset: 0,
        baseDir,
      });
      assert.deepEqual([...read.data], [0, 1, 255, 10]);
    });

    it('passes standard input and environment variables through whatever they contain', async () => {
      const weird = 'it\'s $(echo INJECTED) `echo INJECTED` "quoted" back\\slash';
      const script = [
        'cat',
        'echo',
        'printf \'%s|\' "$WEIRD" "$MULTI" "$EMPTY"',
        'echo',
        'echo "$SWELLWRIGHT_STEP_ID"',
        'echo "$SWELLWRIGHT_STEP_DIR"',
        '[ "$(pwd -P)" = "$(cd "$SWELLWRIGHT_STEP_DIR" && pwd -P)" ] && echo cwd-ok',
        '',
      ].join('\n');
      const id = nextId('inputs');
      const result = await run(script, {
        id,
        stdin: 'from stdin\nsecond line',
        env: { WEIRD: weird, MULTI: 'one\ntwo', EMPTY: '' },
      });
      assert.equal(result.status.exitCode, 0);
      assert.equal(
        text(result.chunks, 'stdout'),
        `from stdin\nsecond line\n${weird}|one\ntwo||\n${id}\n${baseDir}/${id}\ncwd-ok\n`,
      );
      assert.equal(text(result.chunks, 'stderr'), '');
    });

    it('does not start a step twice: the same id and script attach, another script is a conflict', async () => {
      const script = 'echo ran >> "$SWELLWRIGHT_STEP_DIR/counter"\nsleep 1\necho done\n';
      const id = nextId('idem');
      const [first, second] = await Promise.all([
        startDetachedStep(conn, { id, script, baseDir }),
        startDetachedStep(conn, { id, script, baseDir }),
      ]);
      assert.equal(first.scriptSha256, second.scriptSha256);
      await assert.rejects(
        startDetachedStep(conn, { id, script: 'echo different\n', baseDir }),
        (error: unknown) => {
          assert.ok(error instanceof SshStepError);
          assert.equal(error.code, 'ssh_step_conflict');
          return true;
        },
      );
      await waitForStep(conn, id, { baseDir, pollMs: 100 });
      // Attaching to a finished step does not run it again.
      const again = await startDetachedStep(conn, { id, script, baseDir });
      assert.equal(again.state, 'exited');
      const counter = await conn.exec(`cat ${shellQuote(`${baseDir}/${id}/counter`)}`);
      assert.equal(counter.stdout, 'ran\n');
    });

    it('DIAGNOSTIC stress: no step runs twice', async () => {
      const script = 'echo ran >> "$SWELLWRIGHT_STEP_DIR/counter"\nsleep 1\necho done\n';
      const dump = async (id: string): Promise<string> => {
        const dir = shellQuote(`${baseDir}/${id}`);
        const trace = shellQuote(`${baseDir}/${id}.trace`);
        const info = await conn.exec(
          `(cd ${dir} 2>/dev/null && ls -la --time-style=full-iso && echo '--- wc/od' && wc -c counter && od -c counter); echo '--- trace'; cat ${trace}; echo '--- ps'; ps -eo pid,ppid,pgid,sid,lstart,args | grep -E 'run.sh|script.sh' | grep -v grep`,
        );
        return info.stdout + info.stderr;
      };
      const attempt = async (launches: number): Promise<string | undefined> => {
        const id = nextId('stress');
        try {
          await Promise.all(
            Array.from({ length: launches }, () =>
              startDetachedStep(conn, { id, script, baseDir }),
            ),
          );
          await waitForStep(conn, id, { baseDir, pollMs: 100 });
          const counter = await conn.exec(`cat ${shellQuote(`${baseDir}/${id}/counter`)}`);
          if (counter.stdout !== 'ran\n') {
            return `${id} DOUBLE counter=${JSON.stringify(counter.stdout)}\n${await dump(id)}`;
          }
          return undefined;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `${id} ERROR ${message}\n${await dump(id).catch(() => '(dump failed)')}`;
        }
      };
      const report: string[] = [];
      for (const launches of [2, 1]) {
        const problems: string[] = [];
        for (let from = 0; from < 100; from += 4) {
          const results = await Promise.all(Array.from({ length: 4 }, () => attempt(launches)));
          for (const result of results) if (result !== undefined) problems.push(result);
        }
        const doubles = problems.filter((entry) => entry.includes(' DOUBLE ')).length;
        report.push(
          `launches=${String(launches)}: ${String(problems.length)} problems of 100 (${String(doubles)} double runs)\n${problems.slice(0, 5).join('\n=====\n')}`,
        );
      }
      const bad = report.some((entry) => !entry.includes(': 0 problems'));
      assert.ok(!bad, report.join('\n#####\n'));
    });

    it('never lets a hostile id or directory name reach the shell', async () => {
      for (const id of [
        '',
        'UPPER',
        '../escape',
        'a/b',
        'a b',
        '$(touch INJECTED)',
        '`touch INJECTED`',
        "a'b",
        'a;b',
        'a\nb',
        'x'.repeat(65),
      ]) {
        await assert.rejects(
          startDetachedStep(conn, { id, script: 'true\n', baseDir }),
          SshInputError,
          JSON.stringify(id),
        );
        await assert.rejects(getStepStatus(conn, id, baseDir), SshInputError);
        await assert.rejects(
          readStepOutput(conn, id, { stream: 'stdout', fromOffset: 0, baseDir }),
          SshInputError,
        );
        await assert.rejects(cancelStep(conn, id, { baseDir }), SshInputError);
        await assert.rejects(removeStep(conn, id, { baseDir }), SshInputError);
      }
      for (const dir of ['relative/dir', '/a/../b', '~', '/with\nnewline']) {
        await assert.rejects(
          startDetachedStep(conn, { id: 'ok', script: 'true\n', baseDir: dir }),
          SshInputError,
          dir,
        );
      }
      for (const bad of [{ A: 'x', 'B C': 'y' }, { '1X': 'y' }, { 'A;id': 'y' }]) {
        await assert.rejects(
          startDetachedStep(conn, { id: 'ok', script: 'true\n', baseDir, env: bad }),
          SshInputError,
        );
      }
      await assert.rejects(
        startDetachedStep(conn, { id: 'ok', script: '', baseDir }),
        SshInputError,
      );
      await assert.rejects(
        startDetachedStep(conn, { id: 'ok', script: 'a\0b', baseDir }),
        SshInputError,
      );

      // A directory whose name is full of shell syntax is just a directory name.
      const odd = `${baseDir}/odd 'dir' $(touch INJECTED) ;touch INJECTED2`;
      const id = nextId('odd');
      await startDetachedStep(conn, { id, script: 'echo in-odd-dir\n', baseDir: odd });
      const final = await waitForStep(conn, id, { baseDir: odd, pollMs: 100 });
      assert.equal(final.exitCode, 0);
      const check = await conn.exec(
        `test -d ${shellQuote(`${odd}/${id}`)} && test ! -e "$HOME/INJECTED" && test ! -e "$HOME/INJECTED2" && test ! -e ${shellQuote(`${baseDir}/INJECTED`)} && echo clean`,
      );
      assert.equal(check.stdout.trim(), 'clean', check.stderr);
    });

    it('survives a connection that is cut hard: reconnect, resume by offset, nothing lost or repeated', async () => {
      const script =
        'i=0; while [ $i -lt 14 ]; do echo "line $i"; i=$((i + 1)); sleep 0.3; done\nexit 5\n';
      const expected = Array.from({ length: 14 }, (_, index) => `line ${String(index)}\n`).join('');
      const id = nextId('drop');
      const { connection: first, cut } = await env.connectCuttable();
      const firstChunks: StepOutputChunk[] = [];
      try {
        await startDetachedStep(first, { id, script, baseDir });
        const waiting = waitForStep(first, id, {
          baseDir,
          pollMs: 100,
          onOutput: (chunk) => {
            firstChunks.push(chunk);
          },
        });
        const outcome = waiting.then(
          () => undefined,
          (error: unknown) => error,
        );
        await until(() => firstChunks.length >= 1, 15_000, 'the first output');
        cut();
        const error = await outcome;
        assert.ok(error instanceof SshConnectionLostError, `unexpected outcome: ${String(error)}`);
      } finally {
        first.close();
      }
      assert.ok(firstChunks.length >= 1);

      // The step goes on without us.
      const second = await env.connect();
      try {
        const last = firstChunks.at(-1);
        assert.ok(last);
        const rest: StepOutputChunk[] = [];
        const final = await waitForStep(second, id, {
          baseDir,
          pollMs: 100,
          fromOffsets: { stdout: last.nextOffset },
          onOutput: (chunk) => {
            rest.push(chunk);
          },
        });
        assert.equal(final.state, 'exited');
        assert.equal(final.exitCode, 5);
        assert.equal(text(firstChunks, 'stdout') + text(rest, 'stdout'), expected);
        assert.ok(rest.length >= 1, 'the second reader should have found more output');
        // A reader that starts over gets everything again, from the first byte.
        const everything: StepOutputChunk[] = [];
        const again = await waitForStep(second, id, {
          baseDir,
          pollMs: 100,
          onOutput: (chunk) => {
            everything.push(chunk);
          },
        });
        assert.equal(again.exitCode, 5);
        assert.equal(text(everything, 'stdout'), expected);
      } finally {
        second.close();
      }
    });

    it('reports a step whose process vanished without an exit marker as lost', async () => {
      const id = nextId('lost');
      await startDetachedStep(conn, { id, script: 'sleep 60\n', baseDir });
      const dir = shellQuote(`${baseDir}/${id}`);
      await sleep(300);
      assert.equal((await getStepStatus(conn, id, baseDir)).state, 'running');
      const killed = await conn.exec(`kill -s KILL -- "-$(cat ${dir}/pid)"`);
      assert.equal(killed.code, 0, killed.stderr);
      await sleep(300);
      const status = await getStepStatus(conn, id, baseDir);
      assert.equal(status.state, 'lost');
      assert.equal(status.exitCode, null);
      assert.equal(status.finishedAt, null);
      const waited = await waitForStep(conn, id, { baseDir, pollMs: 100 });
      assert.equal(waited.state, 'lost');
      assert.equal(await removeStep(conn, id, { baseDir }), true);
      await assert.rejects(
        getStepStatus(conn, id, baseDir),
        (error: unknown) => error instanceof SshStepError && error.code === 'ssh_step_not_found',
      );
    });

    const groupGone = async (id: string): Promise<boolean> => {
      const pid = (await conn.exec(`cat ${shellQuote(`${baseDir}/${id}/pid`)}`)).stdout.trim();
      const check = await conn.exec(`kill -0 -- -${pid} 2>/dev/null; echo $?`);
      return check.stdout.trim() !== '0';
    };

    it('cancels a step: TERM to the whole process group, exit code recorded, nothing left running', async () => {
      const id = nextId('cancel');
      // A child of the script, so that only killing the whole group stops everything.
      await startDetachedStep(conn, { id, script: 'sleep 300 &\nsleep 300\n', baseDir });
      await sleep(400);
      assert.equal((await getStepStatus(conn, id, baseDir)).state, 'running');
      await cancelStep(conn, id, { baseDir });
      const status = await getStepStatus(conn, id, baseDir);
      assert.equal(status.state, 'exited');
      assert.equal(status.exitCode, 143);
      assert.equal(await groupGone(id), true);
    });

    it('escalates to KILL when the script ignores TERM, and writes the exit marker itself', async () => {
      const id = nextId('stubborn');
      await startDetachedStep(conn, {
        id,
        script: "trap '' TERM INT\nwhile :; do sleep 1; done\n",
        baseDir,
      });
      await sleep(400);
      await cancelStep(conn, id, { baseDir, graceMs: 600 });
      const status = await getStepStatus(conn, id, baseDir);
      assert.equal(status.state, 'exited');
      assert.equal(status.exitCode, 137);
      assert.equal(await groupGone(id), true);
    });

    it('leaves a finished step alone when cancelled, and reports one that does not exist', async () => {
      const done = await run('exit 9\n');
      await cancelStep(conn, done.id, { baseDir });
      assert.equal((await getStepStatus(conn, done.id, baseDir)).exitCode, 9);
      await assert.rejects(
        cancelStep(conn, 'no-such-step', { baseDir }),
        (error: unknown) => error instanceof SshStepError && error.code === 'ssh_step_not_found',
      );
      await assert.rejects(
        getStepStatus(conn, 'no-such-step', baseDir),
        (error: unknown) => error instanceof SshStepError && error.code === 'ssh_step_not_found',
      );
      await assert.rejects(
        readStepOutput(conn, 'no-such-step', { stream: 'stdout', fromOffset: 0, baseDir }),
        (error: unknown) => error instanceof SshStepError && error.code === 'ssh_step_not_found',
      );
      assert.equal(await removeStep(conn, 'no-such-step', { baseDir }), false);
    });

    it('removes finished steps, and refuses to remove a running one unless forced', async () => {
      const id = nextId('remove');
      await startDetachedStep(conn, { id, script: 'sleep 300\n', baseDir });
      await sleep(300);
      assert.equal(await removeStep(conn, id, { baseDir }), false);
      assert.equal((await getStepStatus(conn, id, baseDir)).state, 'running');
      await cancelStep(conn, id, { baseDir });
      assert.equal(await removeStep(conn, id, { baseDir }), true);
      await assert.rejects(getStepStatus(conn, id, baseDir), SshStepError);
    });

    it('says so, and does not run anything, when a step directory was never completed', async () => {
      const id = nextId('incomplete');
      await conn.exec(`mkdir -p ${shellQuote(`${baseDir}/${id}`)}`);
      assert.equal((await getStepStatus(conn, id, baseDir)).state, 'unknown');
      await assert.rejects(
        waitForStep(conn, id, { baseDir, pollMs: 100, unknownGraceMs: 400 }),
        (error: unknown) => error instanceof SshStepError && error.code === 'ssh_step_incomplete',
      );
      await assert.rejects(
        startDetachedStep(conn, { id, script: 'echo never\n', baseDir }),
        (error: unknown) => error instanceof SshStepError && error.code === 'ssh_step_incomplete',
      );
    });

    it('carries a large script and a large input intact', async () => {
      const filler = `# ${randomBytes(30_000).toString('hex')}\n`.repeat(8);
      const script = `${filler}wc -c < "$SWELLWRIGHT_STEP_DIR/stdin"\nsha256sum < "$SWELLWRIGHT_STEP_DIR/stdin" | cut -d' ' -f1\n`;
      const input = randomBytes(300_000).toString('base64');
      const result = await run(script, { stdin: input });
      assert.equal(result.status.exitCode, 0);
      assert.equal(result.status.scriptSha256, sha256(script));
      assert.equal(
        text(result.chunks, 'stdout'),
        `${String(Buffer.byteLength(input))}\n${sha256(input)}\n`,
      );
    });

    describe('secrets (ADR 0042)', () => {
      const DISTINCT = 's3cret-distinct-value';
      // Trailing newline, quotes, expansions, a backslash and a second line: nothing of it may be interpreted anywhere.
      const HARD = `${DISTINCT}-"q" 'q' $(echo INJECTED) \`echo INJECTED\` back\\slash\nsecond line\n`;

      const secretsDir = (id: string): string => `${baseDir}/${id}/secrets`;
      /** The step directory has no secrets directory (a missing one is the success). */
      const secretsGone = async (id: string): Promise<boolean> =>
        (await conn.exec(`test -e ${shellQuote(secretsDir(id))}; echo $?`)).stdout.trim() === '1';
      /** Everything below the step directory that holds the distinct value, one path per line. */
      const holders = async (id: string): Promise<string[]> =>
        (
          await conn.exec(
            `grep -rlF -e ${shellQuote(DISTINCT)} ${shellQuote(`${baseDir}/${id}`)}; true`,
          )
        ).stdout
          .split('\n')
          .filter((line) => line.length > 0)
          .sort();
      /** How many processes of the server have the distinct value in their command line (the bracket keeps grep out). */
      const inArguments = async (): Promise<number> =>
        Number(
          (
            await conn.exec(`ps -eo args | grep -c -e '[s]3cret-distinct-value'; true`)
          ).stdout.trim(),
        );

      it('writes each secret to a private file the script reads through NAME_FILE, and nowhere else', async () => {
        const script = [
          'echo "$MYSECRET_FILE"',
          'stat -c "%a" "$MYSECRET_FILE" "$(dirname "$MYSECRET_FILE")"',
          'sha256sum < "$MYSECRET_FILE" | cut -d" " -f1',
          'sha256sum < "$OTHER_FILE" | cut -d" " -f1',
          'ls "$(dirname "$MYSECRET_FILE")" | sort',
          'sleep 2',
          'echo done',
          '',
        ].join('\n');
        const id = nextId('secrets');
        await startDetachedStep(conn, {
          id,
          script,
          baseDir,
          secrets: { MYSECRET: HARD, OTHER: 'the-other-value' },
        });
        await sleep(700);

        // While the script runs the value is in exactly one file, and in no command line, script or environment file.
        assert.deepEqual(await holders(id), [`${secretsDir(id)}/MYSECRET`]);
        assert.equal(await inArguments(), 0, 'a value is in the arguments of a process');
        const env = await conn.exec(`cat ${shellQuote(`${baseDir}/${id}/env`)}`);
        assert.ok(!env.stdout.includes(DISTINCT));
        assert.match(
          env.stdout,
          /export MYSECRET_FILE="\$SWELLWRIGHT_STEP_DIR\/secrets\/MYSECRET"/u,
        );
        const written = await conn.exec(`cat ${shellQuote(`${baseDir}/${id}/script.sh`)}`);
        assert.equal(written.stdout, script);

        const chunks: StepOutputChunk[] = [];
        const final = await waitForStep(conn, id, {
          baseDir,
          pollMs: 100,
          onOutput: (chunk) => {
            chunks.push(chunk);
          },
        });
        assert.equal(final.exitCode, 0);
        assert.equal(
          text(chunks, 'stdout'),
          `${secretsDir(id)}/MYSECRET\n600\n700\n${sha256(HARD)}\n${sha256('the-other-value')}\nMYSECRET\nOTHER\ndone\n`,
        );
        assert.equal(await secretsGone(id), true, 'the files are gone when the script ended');
        assert.deepEqual(await holders(id), [], 'and no copy of the value is left in the step');
      });

      it('carries bytes exactly: a long value, an odd one, and the absence of a trailing newline', async () => {
        const long = randomBytes(40_000).toString('base64');
        const odd = 'äö€😀 \r\n\t end';
        const script = [
          'for n in LONG ODD ONE; do',
          '  eval "f=\\$${n}_FILE"',
          '  printf "%s " "$(wc -c < "$f" | tr -d " ")"; sha256sum < "$f" | cut -d" " -f1',
          'done',
          '',
        ].join('\n');
        const result = await run(script, { secrets: { LONG: long, ODD: odd, ONE: 'x' } });
        assert.equal(result.status.exitCode, 0);
        assert.equal(
          text(result.chunks, 'stdout'),
          `${String(Buffer.byteLength(long))} ${sha256(long)}\n${String(Buffer.byteLength(odd))} ${sha256(odd)}\n1 ${sha256('x')}\n`,
        );
      });

      it('gives a step without secrets no secrets directory and no secret variable', async () => {
        const result = await run('env | grep -c "_FILE=" ; ls "$SWELLWRIGHT_STEP_DIR"\n');
        assert.doesNotMatch(text(result.chunks, 'stdout'), /secrets/u);
      });

      it('removes the secrets whatever way the script ends', async () => {
        const dir = (id: string): string => shellQuote(`${baseDir}/${id}`);

        // The script fails.
        const failed = await run('sleep 0.3\nexit 3\n', { secrets: { MYSECRET: DISTINCT } });
        assert.equal(failed.status.exitCode, 3);
        assert.equal(await secretsGone(failed.id), true, 'after a failure');

        // The script kills its own shell: the wrapper is alive and cleans up.
        const suicide = await run('kill -9 $$\n', { secrets: { MYSECRET: DISTINCT } });
        assert.equal(suicide.status.exitCode, 137);
        assert.equal(await secretsGone(suicide.id), true, 'after the script was killed');

        // A person cancels it (TERM reaches the group, the wrapper records the end).
        const termId = nextId('secrets-term');
        await startDetachedStep(conn, {
          id: termId,
          script: 'sleep 300 &\nsleep 300\n',
          baseDir,
          secrets: { MYSECRET: DISTINCT },
        });
        await sleep(400);
        assert.deepEqual(await holders(termId), [`${secretsDir(termId)}/MYSECRET`]);
        await cancelStep(conn, termId, { baseDir });
        assert.equal(await secretsGone(termId), true, 'after cancel (TERM)');

        // A script that ignores TERM is killed outright, wrapper included; cancel sweeps up.
        const killId = nextId('secrets-kill');
        await startDetachedStep(conn, {
          id: killId,
          script: "trap '' TERM INT\nwhile :; do sleep 1; done\n",
          baseDir,
          secrets: { MYSECRET: DISTINCT },
        });
        await sleep(400);
        await cancelStep(conn, killId, { baseDir, graceMs: 600 });
        assert.equal((await getStepStatus(conn, killId, baseDir)).exitCode, 137);
        assert.equal(await secretsGone(killId), true, 'after cancel (KILL)');

        // Only the wrapper is killed: nothing records an end; the next look at the step says lost and sweeps up.
        const lostId = nextId('secrets-lost');
        await startDetachedStep(conn, {
          id: lostId,
          script: 'sleep 58\n',
          baseDir,
          secrets: { MYSECRET: DISTINCT },
        });
        await sleep(400);
        const killed = await conn.exec(`kill -s KILL "$(cat ${dir(lostId)}/pid)"`);
        assert.equal(killed.code, 0, killed.stderr);
        await sleep(300);
        assert.equal((await getStepStatus(conn, lostId, baseDir)).state, 'lost');
        assert.equal(await secretsGone(lostId), true, 'after the wrapper alone was killed');

        // A step that is removed while it runs takes everything with it.
        const removeId = nextId('secrets-remove');
        await startDetachedStep(conn, {
          id: removeId,
          script: 'sleep 57\n',
          baseDir,
          secrets: { MYSECRET: DISTINCT },
        });
        await sleep(400);
        // Removing a step does not stop its script, and the directory (with the pid file) is gone afterwards: keep the
        // process group to end it ourselves, or a sleeper outlives this test.
        const pid = (await conn.exec(`cat ${dir(removeId)}/pid`)).stdout.trim();
        assert.match(pid, /^[0-9]+$/u);
        try {
          assert.equal(await removeStep(conn, removeId, { baseDir, force: true }), true);
          assert.equal(await secretsGone(removeId), true, 'after remove');
          assert.deepEqual(await holders(removeId), []);
        } finally {
          await conn.exec(`kill -s KILL -- -${pid} 2>/dev/null; true`);
        }
      });

      it('refuses what cannot be delivered, before anything is sent', async () => {
        const start = (secrets: Record<string, string>, env?: Record<string, string>) =>
          startDetachedStep(conn, {
            id: nextId('secrets-bad'),
            script: 'true\n',
            baseDir,
            secrets,
            ...(env === undefined ? {} : { env }),
          });
        for (const name of ['lower', '1BAD', 'A-B', 'A B', '', 'A'.repeat(65), 'X;rm']) {
          await assert.rejects(start({ [name]: 'v' }), SshInputError, `the name "${name}"`);
        }
        await assert.rejects(start({ NUL: 'a\0b' }), SshInputError);
        await assert.rejects(start({ BIG: 'x'.repeat(64 * 1024 + 1) }), SshInputError);
        await assert.rejects(
          start(Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`S${String(n)}`, 'v']))),
          SshInputError,
        );
        await assert.rejects(start({ CLASH: 'v' }, { CLASH_FILE: '/elsewhere' }), SshInputError);
        const listing = await conn.exec(
          `ls ${shellQuote(baseDir)} 2>/dev/null | grep -c secrets-bad; true`,
        );
        assert.equal(listing.stdout.trim(), '0', 'no step was created for any of them');
      });
    });

    it('uses a per-user directory when none is given', async () => {
      const id = nextId('default-dir');
      const started = await startDetachedStep(conn, { id, script: 'echo default\n' });
      assert.equal(started.id, id);
      const final = await waitForStep(conn, id, { pollMs: 100 });
      assert.equal(final.exitCode, 0);
      assert.equal(await removeStep(conn, id), true);
    });

    it('runs several steps at once without mixing them up', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          run(`sleep 0.${String(n)}\necho step-${String(n)}\nexit ${String(n)}\n`),
        ),
      );
      results.forEach((result, index) => {
        assert.equal(result.status.exitCode, index + 1);
        assert.equal(text(result.chunks, 'stdout'), `step-${String(index + 1)}\n`);
      });
    });

    it('follows an abort signal', async () => {
      const id = nextId('abort');
      await startDetachedStep(conn, { id, script: 'sleep 300\n', baseDir });
      const controller = new AbortController();
      const waiting = waitForStep(conn, id, { baseDir, pollMs: 100, signal: controller.signal });
      setTimeout(() => {
        controller.abort();
      }, 300);
      await assert.rejects(
        waiting,
        (error: unknown) => error instanceof SshError && error.code === 'ssh_aborted',
      );
      // Stopping to watch does not stop the step.
      assert.equal((await getStepStatus(conn, id, baseDir)).state, 'running');
    });

    describe('as root through sudo', () => {
      it('runs the step as root, with its files readable by the user who started it', async (context) => {
        if (env.sudo === undefined) {
          context.skip('no sudo in this environment');
          return;
        }
        const result = await run('id -un\necho "$0" >/dev/null\n', { sudo: env.sudo.options });
        assert.equal(result.status.exitCode, 0);
        assert.equal(text(result.chunks, 'stdout'), `${env.sudo.elevatesTo}\n`);
        // The status and the output were read as the ordinary user: the files are readable by them.
        assert.ok(result.status.startedAt !== null);
      });

      it('cannot be cancelled by the ordinary user, but can with sudo', async (context) => {
        if (!env.sudo?.elevates) {
          context.skip('sudo does not change the user here');
          return;
        }
        const id = nextId('root-cancel');
        await startDetachedStep(conn, {
          id,
          script: 'sleep 300\n',
          baseDir,
          sudo: env.sudo.options,
        });
        await sleep(500);
        await assert.rejects(
          cancelStep(conn, id, { baseDir }),
          (error: unknown) => error instanceof SshStepError && error.message.includes('sudo'),
        );
        assert.equal((await getStepStatus(conn, id, baseDir)).state, 'running');
        await cancelStep(conn, id, { baseDir, sudo: env.sudo.options });
        assert.equal((await getStepStatus(conn, id, baseDir)).state, 'exited');
        assert.equal(await removeStep(conn, id, { baseDir, sudo: env.sudo.options }), true);
      });

      it("cancels and removes a step below the login user's home although sudo resets HOME", async (context) => {
        if (env.sudo === undefined) {
          context.skip('no sudo in this environment');
          return;
        }
        // Real sudo (Debian, Ubuntu) gives the command root's HOME: a "~/" directory looked up under sudo would be
        // the wrong one, the cancel would find no step and the script would run on.
        const dirName = nextId('.swellwright-test-home');
        const homeBase = `~/${dirName}`;
        const id = nextId('home-cancel');
        try {
          await startDetachedStep(conn, {
            id,
            script: 'sleep 300\n',
            baseDir: homeBase,
            sudo: env.sudo.options,
          });
          await sleep(500);
          assert.equal((await getStepStatus(conn, id, homeBase)).state, 'running');
          await cancelStep(conn, id, { baseDir: homeBase, sudo: env.sudo.options });
          assert.equal((await getStepStatus(conn, id, homeBase)).state, 'exited');
          assert.equal(
            await removeStep(conn, id, { baseDir: homeBase, sudo: env.sudo.options }),
            true,
          );
          await assert.rejects(
            getStepStatus(conn, id, homeBase),
            (error: unknown) =>
              error instanceof SshStepError && error.code === 'ssh_step_not_found',
          );
        } finally {
          await conn.exec(`rm -rf "$HOME"/${shellQuote(dirName)}`);
        }
      });

      it('delivers secrets to a step that runs as root, owned by root, and removes them', async (context) => {
        if (env.sudo === undefined) {
          context.skip('no sudo in this environment');
          return;
        }
        const value = 's3cret-for-root-steps';
        const result = await run(
          'stat -c "%U %a" "$MYSECRET_FILE"\nsha256sum < "$MYSECRET_FILE" | cut -d" " -f1\n',
          { sudo: env.sudo.options, secrets: { MYSECRET: value } },
        );
        assert.equal(result.status.exitCode, 0);
        // The step runs as the user sudo elevates to, and its secret belongs to that user (a program handed the file may
        // insist on it): root on a real server, the caller where the stand-in sudo does not elevate.
        assert.equal(
          text(result.chunks, 'stdout'),
          `${env.sudo.elevatesTo} 600\n${sha256(value)}\n`,
        );
        const left = await conn.exec(
          `test -e ${shellQuote(`${baseDir}/${result.id}/secrets`)}; echo $?`,
        );
        assert.equal(left.stdout.trim(), '1', 'removed after the script ended');
      });

      it('removes the secrets of a step that runs as root after its wrapper was killed, and leaves its record', async (context) => {
        if (env.sudo === undefined) {
          context.skip('no sudo in this environment');
          return;
        }
        const id = nextId('secrets-root-lost');
        await startDetachedStep(conn, {
          id,
          script: 'sleep 56\n',
          baseDir,
          sudo: env.sudo.options,
          secrets: { MYSECRET: 's3cret-for-lost-root-steps' },
        });
        await sleep(600);
        const dir = shellQuote(`${baseDir}/${id}`);
        // The wrapper runs as root: killing it takes root.
        const killed = await conn.exec(`kill -s KILL "$(cat ${dir}/pid)"`, {
          sudo: env.sudo.options,
        });
        assert.equal(killed.code, 0, killed.stderr);
        await sleep(300);
        assert.equal((await getStepStatus(conn, id, baseDir)).state, 'lost');
        // The login user's status read removes what it owns; what root owns needs sudo.
        assert.equal(await removeStepSecrets(conn, id, { baseDir, sudo: env.sudo.options }), true);
        const left = await conn.exec(`test -e ${dir}/secrets; echo $?`);
        assert.equal(left.stdout.trim(), '1', 'the secrets are gone');
        assert.equal(
          (await getStepStatus(conn, id, baseDir)).state,
          'lost',
          'and the record stays',
        );
        assert.equal(await removeStepSecrets(conn, 'no-such-step', { baseDir }), false);
        await conn.exec(`kill -s KILL -- "-$(cat ${dir}/pid)" 2>/dev/null; true`, {
          sudo: env.sudo.options,
        });
      });

      it('hands the sudo password to nothing but sudo: the step never sees it', async (context) => {
        if (env.sudo === undefined) {
          context.skip('no sudo in this environment');
          return;
        }
        const password = env.sudo.options.password ?? '';
        const script = 'cat\necho "--"\nenv\n';
        const result = await run(script, { sudo: env.sudo.options });
        const output = text(result.chunks, 'stdout');
        assert.ok(output.startsWith('--\n'), 'the step read something from its standard input');
        assert.ok(
          password.length > 0 && !output.includes(password),
          'the password reached the step',
        );
        const listing = await conn.exec(`cat ${shellQuote(`${baseDir}/${result.id}`)}/script.sh`);
        assert.ok(!listing.stdout.includes(password));
      });
    });
  });
}
