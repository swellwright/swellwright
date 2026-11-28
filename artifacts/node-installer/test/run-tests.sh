#!/bin/sh
# Test suite of the node installer: syntax checks, the validators, and every step run in a temporary fake root with stubbed
# commands (apt-get, ufw, systemctl, docker, sshd, useradd, ...). Nothing touches the real system.
#
#   sh artifacts/node-installer/test/run-tests.sh [filter[,filter...]]   (the tests whose name contains a filter word; none: all)
#
# Runs on the Linux CI runner and in Git Bash. The installer runs under dash when it is there (SW_TEST_SHELL overrides).
# Environment: SW_TEST_SHELL (the shell that runs the installer).
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER=$(cd "$HERE/.." && pwd)/install.sh
REPO=$(cd "$HERE/../../.." && pwd)
ORIG_PATH=$PATH

# The real root path ignores SW_TEST_ROOT. Never run the harness with that effective UID, even in a container.
if [ "$(id -u)" -eq 0 ]; then
    echo "Refusing to run the test suite as root. Use an unprivileged account." >&2
    exit 2
fi

if [ -n "${SW_TEST_SHELL:-}" ]; then SHELL_UNDER_TEST=$SW_TEST_SHELL
elif command -v dash >/dev/null 2>&1; then SHELL_UNDER_TEST=dash
else SHELL_UNDER_TEST=sh; fi
# An absolute path: env -i would look a bare name up in the restricted PATH of the run.
SHELL_UNDER_TEST=$(command -v "$SHELL_UNDER_TEST") || { echo "no such shell: $SHELL_UNDER_TEST" >&2; exit 2; }
REAL_HAPROXY=$(command -v haproxy 2>/dev/null || true)
REAL_SHELLCHECK=$(command -v shellcheck 2>/dev/null || true)
REAL_NODE=$(command -v node 2>/dev/null || true)

# CORE: the basic tools the installer and the stubs use. The installer runs with PATH=BIN:CORE only, so a real docker, nginx or
# sudo on the machine that runs the suite cannot be found by `command -v`, let alone run. On Git Bash the programs are MSYS
# executables that find their runtime only in /usr/bin, so there /usr/bin itself is CORE.
case $(uname -s) in
    MINGW*|MSYS*|CYGWIN*) CORE=/usr/bin ;;
    *)
        CORE=$(mktemp -d) || exit 2
        trap 'rm -rf "$CORE"' EXIT
        for _t in awk basename cat cmp cp cut date df dirname fold grep head ls mkdir mktemp mv nproc rm sed sort stat tail tee touch tr uname wc; do
            _p=$(command -v "$_t" 2>/dev/null) || continue
            case $_p in /*) ln -s "$_p" "$CORE/$_t" ;; esac
        done
        ln -s "$SHELL_UNDER_TEST" "$CORE/sh"
        ;;
esac

. "$HERE/lib.sh"
. "$HERE/t-static.sh"
. "$HERE/t-params.sh"
. "$HERE/t-steps.sh"
. "$HERE/t-flow.sh"
. "$HERE/t-access.sh"

FILTER=${1:-}
PASS=0; FAILED=0; SKIPPED=0
FAILED_NAMES=

# skip "reason": ends the current test as skipped.
skip() { printf '%s\n' "$1" >"$T/skip"; exit 0; }

run_one() {
    T=$(mktemp -d) || exit 2
    ( setup_env; set -u; "$1" )
    _rc=$?
    if [ -f "$T/skip" ]; then
        SKIPPED=$((SKIPPED + 1))
        printf '  skip  %s  (%s)\n' "$1" "$(cat "$T/skip")"
    elif [ "$_rc" -eq 0 ]; then
        PASS=$((PASS + 1))
        printf '  ok    %s\n' "$1"
    else
        FAILED=$((FAILED + 1))
        FAILED_NAMES="$FAILED_NAMES $1"
        printf '  FAIL  %s\n' "$1"
    fi
    rm -rf "$T"
}

printf 'installer: %s\nshell under test: %s (%s)\n' "${INSTALLER#"$REPO"/}" "$SHELL_UNDER_TEST" "$SHELL_UNDER_TEST"
# matches NAME: no filter, or the name contains one of the comma-separated filter words.
matches() {
    [ -n "$FILTER" ] || return 0
    _oifs=$IFS; IFS=,
    for _w in $FILTER; do
        case $1 in *"$_w"*) IFS=$_oifs; return 0 ;; esac
    done
    IFS=$_oifs
    return 1
}
for _t in $(cat "$HERE"/t-*.sh | sed -n 's/^\(t_[a-z0-9_]*\)().*/\1/p'); do
    if matches "$_t"; then run_one "$_t"; fi
done

printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAILED" "$SKIPPED"
[ "$FAILED" -eq 0 ] || { printf 'failed:%s\n' "$FAILED_NAMES"; exit 1; }
exit 0
