// A stand-in for sudo, for tests of the wrapper that feeds sudo a password. It understands only what the SSH layer
// uses (-n, -S, -p, --), runs the command as the same user, and appends what it saw (arguments, environment, how it
// decided) to a log so that a test can prove the password was never in either.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeSudo {
  /** Put this directory first on PATH. */
  dir: string;
  /** Everything every invocation logged. */
  log(): string;
  cleanup(): void;
}

/**
 * `passwordless`: sudo never asks (NOPASSWD). Otherwise it demands `password` on the standard input of `-S` and
 * answers "a password is required" to `-n`. `resetHome`: the command runs with this `HOME`, as under the real sudo of
 * Debian and Ubuntu (`env_reset` gives the command the home of the target user, not the caller's); without it the
 * caller's `HOME` is kept, which hides every bug that depends on the difference.
 */
export function installFakeSudo(options: {
  password: string;
  passwordless?: boolean;
  resetHome?: string;
}): FakeSudo {
  if (!/^[A-Za-z0-9_-]+$/u.test(options.password))
    throw new Error('The fake sudo password must be simple.');
  if (options.resetHome !== undefined && !/^\/[A-Za-z0-9_./-]+$/u.test(options.resetHome))
    throw new Error('The fake sudo home must be a simple absolute path.');
  const dir = mkdtempSync(join(tmpdir(), 'sw-fake-sudo-'));
  const logFile = join(dir, 'sudo.log');
  writeFileSync(logFile, '');
  const script = `#!/bin/sh
LOG='${logFile}'
PASSWORD='${options.password}'
PASSWORDLESS=${options.passwordless === true ? '1' : '0'}
${options.resetHome === undefined ? '' : `RESET_HOME='${options.resetHome}'`}
{ printf 'argv:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; env; } >> "$LOG"
if [ -n "\${RESET_HOME:-}" ]; then HOME=$RESET_HOME; export HOME; fi
s=0
while [ $# -gt 0 ]; do
  case "$1" in -n) shift;; -S) s=1; shift;; -p) shift 2;; --) shift; break;; -*) shift;; *) break;; esac
done
if [ "$PASSWORDLESS" = 1 ]; then echo "mode:passwordless" >> "$LOG"; exec "$@"; fi
if [ "$s" = 1 ]; then
  IFS= read -r pw
  if [ "$pw" = "$PASSWORD" ]; then echo "mode:password-accepted" >> "$LOG"; exec "$@"; fi
  echo "mode:password-rejected" >> "$LOG"
  echo "Sorry, try again." >&2
  exit 1
fi
echo "mode:password-required" >> "$LOG"
echo "sudo: a password is required" >&2
exit 1
`;
  writeFileSync(join(dir, 'sudo'), script);
  chmodSync(join(dir, 'sudo'), 0o755);
  return {
    dir,
    log: () => readFileSync(logFile, 'utf8'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
