// The programs that run on the server for detached steps. Plain POSIX sh (dash is enough) and coreutils: no
// bashisms, no Python, nothing installed. Each one is passed to `sh -c` as one argument; the values it works on are
// positional parameters (quoted by the caller), never spliced into the program text.
//
// Layout of a step, under `<baseDir>/<id>/`:
//   script.sh       the script (0700), exactly the bytes the caller gave
//   script.sha256   its SHA-256; written last of the uploaded files, it marks the step as committed
//   stdin           optional, the step's standard input (0600)
//   env             optional, `export NAME='value'` lines the wrapper sources (0600)
//   secrets/NAME    optional, one file per secret (the directory 0700, the files 0600), for the length of the script:
//                   written by the launch as the login user, owned by root when the step runs as root (the wrapper
//                   does that), removed by the wrapper when the script ends, whatever the way (ADR 0042)
//   run.sh          the wrapper (0700): becomes the leader of a new session, records pid and start, runs the
//                   script, records the exit code
//   out, err        the script's standard output and standard error (0600, appended to)
//   pid             the process group leader (the wrapper), written by the wrapper
//   started         ISO 8601 UTC time, written by the wrapper
//   exit            the exit code, then the ISO 8601 UTC finish time; created atomically (hard link of a complete
//                   temporary file) so the first writer wins and a reader never sees half of it
//   .owner          created exclusively by the launch that made the directory; the launch that cannot create it
//                   does not own the step, whatever `mkdir` answered
//   .claimed        created exclusively by the first wrapper to run; any other wrapper ends without running the script
//
// Who owns a step is always decided by an exclusive create done by the shell itself (`set -C`, which opens the file with
// O_EXCL), never by `mkdir`. The coreutils of Ubuntu since 25.10 are the Rust ones (uutils), and their `mkdir` answers
// success to both of two callers that race for the same path (measured on real servers: 29 to 57 percent of tight races;
// the shell's exclusive create, a symbolic link and a hard link: none in 600). A directory is not an atomic claim there.

import { AS_ROOT_FUNCTION } from './sudo-wrap.js';

// Shared helpers. `alive PID ID` is true while the process is the wrapper of that step: when /proc exists the
// command line must name the step's run.sh (a recycled pid of something else does not count), otherwise `kill -0`.
const PRELUDE = `
nap() { sleep 0.2 2>/dev/null || sleep 1; }
now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
alive() {
  case $1 in ''|*[!0-9]*) return 1;; esac
  if [ -r "/proc/$1/cmdline" ]; then
    case "$(tr '\\000' ' ' < "/proc/$1/cmdline" 2>/dev/null)" in *"/$2/run.sh"*) return 0;; esac
    return 1
  fi
  kill -0 "$1" 2>/dev/null
}
publish_exit() {
  umask 022
  tmp=$1/exit.tmp.$$
  { printf '%s\\n%s\\n' "$2" "$(now)" > "$tmp" && ln "$tmp" "$1/exit" 2>/dev/null; } || :
  rm -f "$tmp"
}
`;

/**
 * The wrapper, written to `run.sh`. Run as `setsid sh run.sh STEPDIR`: it is then the leader of its own session and
 * process group, so `kill -- -PID` reaches the script and everything it started. It ignores SIGHUP (the SSH
 * session going away must not matter) and survives SIGTERM long enough to record the exit code of the script,
 * which receives the same signal when the group is cancelled.
 */
export const WRAPPER_SCRIPT = `#!/bin/sh
D=$1
cd "$D" || exit 70
# The script runs at most once per step directory, whatever starts this wrapper: the first wrapper to create .claimed
# owns the step, any other one ends here without touching the step (a step must never run twice). The claim is the
# shell's own exclusive create, not mkdir (see the top of this file for why).
( set -C; : > .claimed ) 2>/dev/null || exit 0
trap '' HUP
trap : TERM INT
# A step that runs as root owns its secrets as root: the launch wrote them as the login user, and a program that is handed
# a secret file may insist that it belongs to the user that runs it (the node installer does). They stay 0600 and 0700.
if [ -d ./secrets ] && [ "$(id -u)" = 0 ]; then chown -R 0:0 ./secrets 2>/dev/null; fi
umask 022
printf '%s\\n' "$$" > pid.tmp && mv -f pid.tmp pid
date -u '+%Y-%m-%dT%H:%M:%SZ' > started.tmp && mv -f started.tmp started
umask 077
SWELLWRIGHT_STEP_DIR=$D
SWELLWRIGHT_STEP_ID=\${D##*/}
export SWELLWRIGHT_STEP_DIR SWELLWRIGHT_STEP_ID
if [ -f ./env ]; then . ./env; fi
if [ -f ./stdin ]; then
  sh ./script.sh < ./stdin >> out 2>> err
else
  sh ./script.sh < /dev/null >> out 2>> err
fi
rc=$?
# The secrets of the step were on disk only while the script ran. They go before the exit marker is published, so a step
# that is seen to have ended has none left; cancel, the status read and remove sweep up after a wrapper that was killed.
rm -rf ./secrets
umask 022
tmp=exit.tmp.$$
printf '%s\\n%s\\n' "$rc" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$tmp" || exit 71
ln "$tmp" exit 2>/dev/null || :
rm -f "$tmp"
exit "$rc"
`;

/**
 * Creates a step and starts it. Positional parameters: base directory, step id, script SHA-256, whether a sudo
 * line comes first on the standard input (0 or 1). The standard input is then: the sudo password line (if any), a
 * header line, and four frames (script, stdin, env, run), each `FRAME name sha256|-` followed, when present, by
 * base64 lines and a line with a single dot. The last line printed is `SWRESULT started|attached|conflict|incomplete`.
 */
export const LAUNCH_SCRIPT = `${PRELUDE}
${AS_ROOT_FUNCTION}
B=$1; ID=$2; WANT=$3; USESUDO=$4
SWPW=
if [ "$USESUDO" = 1 ]; then IFS= read -r SWPW || { echo "swellwright: no sudo line" >&2; exit 64; }; fi
IFS= read -r HDR || exit 65
[ "$HDR" = SWSTEP/1 ] || { echo "swellwright: bad header" >&2; exit 65; }
umask 077
mkdir -p "$B" || { echo "swellwright: cannot create the base directory" >&2; exit 66; }
D=$B/$ID
# The launch that creates the directory owns the step; a directory that is already there belongs to somebody else (a
# complete step, one being made, or one that was never completed). Two launches that race can both be told by mkdir that
# they made it, so the owner is the one that creates .owner exclusively (see the top of this file).
if [ -e "$D" ] || ! mkdir "$D" 2>/dev/null || ! ( set -C; : > "$D/.owner" ) 2>/dev/null; then
  n=0
  while [ ! -f "$D/script.sha256" ] && [ "$n" -lt 25 ]; do nap; n=$((n + 1)); done
  if [ ! -f "$D/script.sha256" ]; then echo "SWRESULT incomplete"; exit 0; fi
  HAVE=$(cat "$D/script.sha256")
  if [ "$HAVE" = "$WANT" ]; then echo "SWRESULT attached"; else echo "SWRESULT conflict"; fi
  exit 0
fi
getframe() {
  IFS=' ' read -r tag name sha || return 1
  [ "$tag" = FRAME ] && [ "$name" = "$1" ] || return 1
  [ "$sha" = - ] && return 0
  : > "$D/$2" && chmod "$3" "$D/$2" || return 1
  while IFS= read -r line; do [ "$line" = . ] && break; printf '%s\\n' "$line"; done | base64 -d > "$D/$2" || return 1
  got=$(sha256sum "$D/$2" | cut -d' ' -f1)
  [ "$got" = "$sha" ] || return 2
  return 0
}
fail() { echo "swellwright: $1" >&2; rm -rf "$D"; exit "$2"; }
getframe script script.sh 700 || fail "the script did not arrive intact" 67
getframe stdin stdin 600 || fail "the stdin file did not arrive intact" 67
getframe env env 600 || fail "the env file did not arrive intact" 67
getframe run run.sh 700 || fail "the wrapper did not arrive intact" 67
# Zero or more secrets follow: a line SECRET NAME sha256 and the base64 lines of the value (ADR 0042). Each becomes a file in
# "$D/secrets" (0700, files 0600, owned by whoever runs this: the owner of the step directory), written from this
# standard input only. Any failure takes the whole step directory with it.
while IFS=' ' read -r tag sname ssha; do
  [ "$tag" = SECRET ] || fail "unexpected input after the frames" 67
  case $sname in ''|[!A-Z]*|*[!A-Z0-9_]*) fail "a secret has a bad name" 67;; esac
  [ "\${#sname}" -le 64 ] || fail "a secret has a bad name" 67
  [ -d "$D/secrets" ] || mkdir "$D/secrets" || fail "cannot create the secrets directory" 66
  : > "$D/secrets/$sname" && chmod 600 "$D/secrets/$sname" || fail "cannot create a secret file" 66
  while IFS= read -r line; do [ "$line" = . ] && break; printf '%s\\n' "$line"; done | base64 -d > "$D/secrets/$sname" || fail "a secret did not arrive intact" 67
  got=$(sha256sum "$D/secrets/$sname" | cut -d' ' -f1)
  [ "$got" = "$ssha" ] || fail "a secret did not arrive intact" 67
done
[ "$(sha256sum "$D/script.sh" | cut -d' ' -f1)" = "$WANT" ] || fail "the script hash differs" 67
command -v setsid >/dev/null 2>&1 || fail "setsid is not installed on the server" 68
: > "$D/out"; : > "$D/err"; chmod 600 "$D/out" "$D/err"
# A launch that lost the race reads this file as soon as it exists, so it appears whole (written aside, then renamed).
printf '%s\\n' "$WANT" > "$D/script.sha256.tmp" && mv -f "$D/script.sha256.tmp" "$D/script.sha256" || fail "the script hash could not be recorded" 66
if [ "$USESUDO" = 1 ]; then
  as_root sh -c 'setsid sh "$1" "$2" </dev/null >/dev/null 2>&1 &' swellwright-start "$D/run.sh" "$D" || { echo "swellwright: sudo failed" >&2; rm -rf "$D"; exit 69; }
else
  setsid sh "$D/run.sh" "$D" </dev/null >/dev/null 2>&1 &
fi
n=0
while [ ! -f "$D/started" ] && [ "$n" -lt 50 ]; do nap; n=$((n + 1)); done
if [ -f "$D/started" ]; then echo "SWRESULT started"; else echo "swellwright: the step did not start" >&2; exit 69; fi
`;

/** Reports a step as `key=value` lines. Positional parameters: base directory, step id. */
export const STATUS_SCRIPT = `${PRELUDE}
D=$1/$2
if [ ! -d "$D" ]; then echo "state=notfound"; exit 0; fi
code=; fin=; st=; sha=; so=0; se=0
[ -f "$D/script.sha256" ] && sha=$(cat "$D/script.sha256")
[ -f "$D/started" ] && st=$(cat "$D/started")
[ -f "$D/out" ] && so=$(wc -c < "$D/out" | tr -d ' ')
[ -f "$D/err" ] && se=$(wc -c < "$D/err" | tr -d ' ')
read_exit() { { IFS= read -r code; IFS= read -r fin; } < "$D/exit"; }
if [ -f "$D/exit" ]; then
  read_exit
  state=exited
elif [ -f "$D/pid" ]; then
  pid=$(cat "$D/pid")
  if alive "$pid" "$2"; then
    state=running
  elif [ -f "$D/exit" ]; then
    # The step finished between the look at the exit marker above and the look at the process: the wrapper writes
    # the marker before it exits, so a dead process with no marker is lost only if the marker is still missing now.
    read_exit
    state=exited
  else
    state=lost
  fi
else
  state=unknown
fi
# A step that is over has no use for its secrets: the wrapper removes them first, this is for a wrapper that was killed.
# (Secrets that belong to root are out of reach of the login user: for those \`removeStepSecrets\` runs through sudo.)
case $state in exited|lost) [ -d "$D/secrets" ] && rm -rf "$D/secrets" 2>/dev/null;; esac
printf 'state=%s\\ncode=%s\\nstarted=%s\\nfinished=%s\\nsha=%s\\nout=%s\\nerr=%s\\n' "$state" "$code" "$st" "$fin" "$sha" "$so" "$se"
exit 0
`;

/**
 * Reads a slice of out or err. Positional parameters: base directory, step id, `out` or `err`, byte offset to start
 * from, the most bytes to return. Prints `SWO <exited 0|1> <size> <n>` and a newline, then exactly `n` bytes.
 * The exit marker is looked at before the size, so "exited and read everything" is never reported too early.
 */
export const READ_SCRIPT = `
D=$1/$2
F=$D/$3
if [ ! -d "$D" ]; then echo "SWO notfound"; exit 0; fi
fin=0
[ -f "$D/exit" ] && fin=1
size=0
[ -f "$F" ] && size=$(wc -c < "$F" | tr -d ' ')
from=$4
max=$5
n=$((size - from))
[ "$n" -lt 0 ] && n=0
[ "$n" -gt "$max" ] && n=$max
printf 'SWO %s %s %s\\n' "$fin" "$size" "$n"
if [ "$n" -gt 0 ]; then tail -c +"$((from + 1))" "$F" | head -c "$n"; fi
exit 0
`;

/**
 * Stops a step: TERM to the whole process group, KILL after the grace period, then the exit marker if the wrapper
 * could not write it. Positional parameters: base directory, step id, grace period in 0.2 s ticks. Run as root
 * (through the sudo wrapper) for a step that runs as root.
 * Prints `SWRESULT cancelled|finished|notfound|denied`.
 */
export const CANCEL_SCRIPT = `${PRELUDE}
D=$1/$2
GRACE=$3
if [ ! -d "$D" ]; then echo "SWRESULT notfound"; exit 0; fi
if [ -f "$D/exit" ]; then rm -rf "$D/secrets"; echo "SWRESULT finished"; exit 0; fi
pid=
[ -f "$D/pid" ] && pid=$(cat "$D/pid")
if [ -z "$pid" ] || ! alive "$pid" "$2"; then
  rm -rf "$D/secrets"
  publish_exit "$D" 143
  echo "SWRESULT cancelled"
  exit 0
fi
if ! kill -s TERM -- "-$pid" 2>/dev/null; then
  if alive "$pid" "$2"; then echo "SWRESULT denied"; exit 0; fi
fi
i=0
while [ ! -f "$D/exit" ] && alive "$pid" "$2" && [ "$i" -lt "$GRACE" ]; do nap; i=$((i + 1)); done
if alive "$pid" "$2"; then
  kill -s KILL -- "-$pid" 2>/dev/null
  i=0
  while alive "$pid" "$2" && [ "$i" -lt 25 ]; do nap; i=$((i + 1)); done
fi
rm -rf "$D/secrets"
[ -f "$D/exit" ] || publish_exit "$D" 137
echo "SWRESULT cancelled"
exit 0
`;

/**
 * Removes a finished (or lost) step directory. Positional parameters: base directory, step id, force (0|1).
 * Without force a running step is left alone. Prints `SWRESULT removed|running|notfound`.
 */
export const REMOVE_SCRIPT = `${PRELUDE}
D=$1/$2
if [ ! -d "$D" ]; then echo "SWRESULT notfound"; exit 0; fi
pid=
[ -f "$D/pid" ] && pid=$(cat "$D/pid")
if [ ! -f "$D/exit" ] && [ -n "$pid" ] && alive "$pid" "$2" && [ "$3" != 1 ]; then echo "SWRESULT running"; exit 0; fi
rm -rf "$D"
echo "SWRESULT removed"
exit 0
`;

/**
 * Removes only the secrets of a step, whatever state it is in. Positional parameters: base directory, step id. Run as
 * root (through the sudo wrapper) for a step that runs as root, whose secrets the login user cannot remove. Prints
 * `SWRESULT removed|notfound`.
 */
export const SECRETS_REMOVE_SCRIPT = `
D=$1/$2
if [ ! -d "$D" ]; then echo "SWRESULT notfound"; exit 0; fi
rm -rf "$D/secrets"
echo "SWRESULT removed"
exit 0
`;
