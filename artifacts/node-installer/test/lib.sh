# Helpers of the node installer test suite (sourced by run-tests.sh; POSIX sh).
#
# Every test runs in a fresh temporary directory T that holds the root of a fake system (R, handed to the installer as
# SW_TEST_ROOT), a directory of stub commands (BIN, first in PATH), a state directory the stubs read and write (STATE) and
# the record of every stub call (STUB_LOG, one line per call: the command and its arguments). The installer is run with
# `env -i`, so nothing of the developer's environment leaks in. Nothing here touches the real system.

NL='
'

# ---------------------------------------------------------------- assertions (a failing assertion ends the test)

fail() {
    printf '    FAIL: %s\n' "$*" >&2
    for _f in out err; do
        if [ -s "$T/$_f" ]; then
            printf '    --- %s (last 25 lines) ---\n' "$_f" >&2
            tail -n 25 "$T/$_f" | sed 's/^/    | /' >&2
        fi
    done
    exit 1
}

assert_rc() { [ "$RC" = "$1" ] || fail "exit code $RC, expected $1"; }
assert_file() { [ -f "$1" ] || fail "missing file ${1#"$T"/}"; }
assert_no_file() { [ ! -e "$1" ] || fail "file ${1#"$T"/} must not exist"; }
assert_contains() { grep -qF -- "$2" "$1" 2>/dev/null || fail "${1#"$T"/} does not contain: $2"; }
assert_not_contains() { ! grep -qF -- "$2" "$1" 2>/dev/null || fail "${1#"$T"/} must not contain: $2"; }
assert_line() { grep -qxF -- "$2" "$1" 2>/dev/null || fail "${1#"$T"/} has no line exactly: $2"; }
assert_called() { grep -qxF -- "$1" "$STUB_LOG" || fail "stub call missing: $1"; }
assert_not_called() { ! grep -qxF -- "$1" "$STUB_LOG" || fail "stub call must not happen: $1"; }
assert_called_like() { grep -qE -- "$1" "$STUB_LOG" || fail "no stub call matches: $1"; }
assert_not_called_like() { ! grep -qE -- "$1" "$STUB_LOG" || fail "a stub call matches (must not): $1"; }
assert_out() { cat "$T/out" "$T/err" 2>/dev/null | grep -qF -- "$1" || fail "output does not contain: $1"; }
assert_not_out() { ! cat "$T/out" "$T/err" 2>/dev/null | grep -qF -- "$1" || fail "output must not contain: $1"; }

# assert_order "call A" "call B": the first call A is recorded before the first call B.
assert_order() {
    _la=$(grep -nxF -- "$1" "$STUB_LOG" | head -n1 | cut -d: -f1)
    _lb=$(grep -nxF -- "$2" "$STUB_LOG" | head -n1 | cut -d: -f1)
    [ -n "$_la" ] || fail "stub call missing: $1"
    [ -n "$_lb" ] || fail "stub call missing: $2"
    [ "$_la" -lt "$_lb" ] || fail "'$1' must come before '$2'"
}

# assert_order_like "RE A" "RE B": the first call matching A is recorded before the first call matching B.
assert_order_like() {
    _la=$(grep -nE -- "$1" "$STUB_LOG" | head -n1 | cut -d: -f1)
    _lb=$(grep -nE -- "$2" "$STUB_LOG" | head -n1 | cut -d: -f1)
    [ -n "$_la" ] || fail "no stub call matches: $1"
    [ -n "$_lb" ] || fail "no stub call matches: $2"
    [ "$_la" -lt "$_lb" ] || fail "'$1' must come before '$2'"
}

# assert_mode_recorded MODE FILE: the installer asked for this mode (install -m MODE, or chmod MODE). Modes cannot be read back
# on every file system the suite runs on, so the calls are what is checked.
assert_mode_recorded() {
    grep -qE -- "^(install -m $1 .* $2|chmod $1 $2)\$" "$STUB_LOG" || fail "no install -m / chmod $1 for $2"
}

# assert_no_secret VALUE: the value appears in no output, no journal and no stub argument.
assert_no_secret() {
    for _f in "$T/out" "$T/err" "$STUB_LOG" "$R/var/log/swellwright-node-installer.log"; do
        [ ! -f "$_f" ] || ! grep -qF -- "$1" "$_f" || fail "a secret was found in ${_f#"$T"/}"
    done
}

# ---------------------------------------------------------------- the fake system

# mkstub NAME < body: a stub command. Every stub records its call, and fails when the state file `fail` lists a prefix of it.
mkstub() {
    {
        printf '#!/bin/sh\nSTUB_LOG=%s; STUB_STATE=%s; STUB_R=%s; STUB_BIN=%s; STUB_SHELL=%s\n' "'$STUB_LOG'" "'$STATE'" "'$R'" "'$BIN'" "'$SHELL_UNDER_TEST'"
        cat <<'EOF'
_n=${0##*/}
{ printf '%s' "$_n"; for _a in "$@"; do printf ' %s' "$_a"; done; printf '\n'; } >>"$STUB_LOG"
if [ -f "$STUB_STATE/fail" ]; then
    while IFS= read -r _p; do case "$_n $*" in "$_p"*) exit 1 ;; esac; done <"$STUB_STATE/fail"
fi
EOF
        cat
    } >"$STATE/stubs/$1"
    chmod +x "$STATE/stubs/$1"
}

# have NAME...: the command is installed (a copy of its stub goes into BIN).
have() { for _b in "$@"; do cp "$STATE/stubs/$_b" "$BIN/$_b"; chmod +x "$BIN/$_b"; done; }
# remove_cmd NAME...: the command is not installed.
remove_cmd() { for _b in "$@"; do rm -f "$BIN/$_b"; done; }
# fail_on "prefix": any stub call that starts with this text exits 1 (for example "nginx -t", "docker compose").
fail_on() { printf '%s\n' "$1" >>"$STATE/fail"; }

make_stubs() {
    mkdir -p "$STATE/stubs"
    # Commands that only record.
    for _c in hostnamectl modprobe journalctl chown add-apt-repository rsync python3 sleep sync systemd-notify; do
        mkstub "$_c" <<'EOF'
exit 0
EOF
    done
    mkstub flock <<'EOF'
if [ "$*" = "-u 8" ]; then
    if [ -f "$STUB_STATE/interrupt_before_confirmation" ]; then
        kill -KILL "$PPID"
        exit 1
    fi
    if [ -f "$STUB_STATE/fire_on_unlock" ]; then
        rm -f "$STUB_STATE/fire_on_unlock"
        sh "$STUB_R/var/lib/swellwright-ssh-rollback/rollback.sh" automatic || exit 1
    fi
fi
exit 0
EOF
    # chmod and install do their work as well, so that the files the installer writes exist.
    _real_chmod=$(command -v chmod); _real_install=$(command -v install)
    mkstub chmod <<EOF
"$_real_chmod" "\$@" 2>/dev/null
exit 0
EOF
    mkstub install <<EOF
exec "$_real_install" "\$@"
EOF
    # stat [-L] -c FORMAT FILE reports the mode written in FILE.mode when there is one (file systems that cannot hold a mode, and
    # the tests that need a mode the file does not have), the real one otherwise. The owner is FILE.owner when there is one;
    # a file in the home of a user of the fake system belongs to that user (user id 1000 unless uid_NAME says otherwise), any other file to
    # whoever really owns it (the user that runs the suite, which is the user the installer sees through `id -u`).
    mkstub stat <<EOF
_fmt=; _prev=; _f=
for _x in "\$@"; do
    [ "\$_prev" = -c ] && _fmt=\$_x
    _prev=\$_x; _f=\$_x
done
case "\$_fmt" in
    %a) if [ -f "\$_f.mode" ]; then cat "\$_f.mode"; exit 0; fi ;;
    %u)
        if [ -f "\$_f.owner" ]; then cat "\$_f.owner"; exit 0; fi
        case "\$_f" in
            "\$STUB_R"/home/*)
                _n=\${_f#"\$STUB_R"/home/}; _n=\${_n%%/*}
                if [ -f "\$STUB_STATE/uid_\$_n" ]; then cat "\$STUB_STATE/uid_\$_n"; else echo 1000; fi
                exit 0 ;;
        esac ;;
esac
exec "$(command -v stat)" "\$@"
EOF
    # id NAME: is there such a user. id -Gn NAME: its groups (its own, sudo for the members, and what groups_NAME adds).
    mkstub id <<EOF
case "\${1:-}" in
    -Gn)
        grep -qx "\$2" "\$STUB_STATE/users" 2>/dev/null || exit 1
        printf '%s' "\$2"
        grep -qx "\$2" "\$STUB_STATE/sudo_members" 2>/dev/null && printf ' sudo'
        [ -f "\$STUB_STATE/groups_\$2" ] && printf ' %s' "\$(cat "\$STUB_STATE/groups_\$2")"
        printf '\n'; exit 0 ;;
    ''|-*) exec "$(command -v id)" "\$@" ;;
esac
grep -qx "\$1" "\$STUB_STATE/users" 2>/dev/null
EOF
    # The users of the fake system are the lines of "$STUB_STATE/users". A user has user id 1000, group id 1000 and the shell
    # "$R/bin/bash" unless uid_NAME, gid_NAME or shell_NAME say otherwise; shadow_NAME is what follows the name on its line of
    # /etc/shadow (no file: no entry).
    mkstub getent <<'EOF'
_pw_line() {
    _u=1000; [ -f "$STUB_STATE/uid_$1" ] && _u=$(cat "$STUB_STATE/uid_$1")
    _g=$_u; [ -f "$STUB_STATE/gid_$1" ] && _g=$(cat "$STUB_STATE/gid_$1")
    _s=$STUB_R/bin/bash; [ -f "$STUB_STATE/shell_$1" ] && _s=$(cat "$STUB_STATE/shell_$1")
    printf '%s:x:%s:%s::%s/home/%s:%s\n' "$1" "$_u" "$_g" "$STUB_R" "$1" "$_s"
}
case "$1" in
    passwd)
        if [ -z "${2:-}" ]; then while IFS= read -r _n; do _pw_line "$_n"; done <"$STUB_STATE/users"; exit 0; fi
        grep -qx "$2" "$STUB_STATE/users" 2>/dev/null || exit 2
        _pw_line "$2" ;;
    shadow)
        [ -f "$STUB_STATE/shadow_$2" ] || exit 2
        printf '%s:%s\n' "$2" "$(cat "$STUB_STATE/shadow_$2")" ;;
    group)
        _m=$(tr '\n' ',' <"$STUB_STATE/sudo_members" 2>/dev/null | sed 's/,$//')
        printf 'sudo:x:27:%s\n' "$_m" ;;
    ahostsv4)
        _l=$(grep "^$2 " "$STUB_STATE/dns" 2>/dev/null | head -n1) || exit 2
        [ -n "$_l" ] || exit 2
        printf '%s STREAM %s\n' "${_l#* }" "$2" ;;
    *) exit 2 ;;
esac
EOF
    mkstub useradd <<'EOF'
for _a in "$@"; do _u=$_a; done
echo "$_u" >>"$STUB_STATE/users"
mkdir -p "$STUB_R/home/$_u"
chmod 755 "$STUB_R/home/$_u"
exit 0
EOF
    mkstub adduser <<'EOF'
for _a in "$@"; do _u=$_a; done
echo "$_u" >>"$STUB_STATE/users"
mkdir -p "$STUB_R/home/$_u"
chmod 755 "$STUB_R/home/$_u"
exit 0
EOF
    mkstub usermod <<'EOF'
case "$*" in "-aG sudo "*) echo "$3" >>"$STUB_STATE/sudo_members" ;; esac
exit 0
EOF
    mkstub passwd <<'EOF'
if [ "${1:-}" = -S ]; then
    if grep -qx "$2" "$STUB_STATE/haspw" 2>/dev/null; then echo "$2 P 2026-11-21 0 99999 7 -1"; else echo "$2 L 2026-11-21 0 99999 7 -1"; fi
    exit 0
fi
exit 0
EOF
    mkstub chpasswd <<'EOF'
cat >"$STUB_STATE/chpasswd.in"
_u=$(cut -d: -f1 "$STUB_STATE/chpasswd.in" | head -n1)
echo "$_u" >>"$STUB_STATE/haspw"
exit 0
EOF
    # Tests drive the unit's real helper; the wait stub returns immediately rather than owning a background process.
    mkstub systemctl <<'EOF'
_node_unit="$STUB_R/etc/systemd/system/sw-node.service"
_node_helper="$STUB_R/usr/local/sbin/sw-node-lifecycle.sh"
_acl_helper="$STUB_R/usr/local/sbin/sw-node-api-acl.sh"
_acl_unit="$STUB_R/etc/systemd/system/sw-node-api-acl.service"
_active="$STUB_STATE/active_units"
deactivate() {
    if [ -f "$_active" ]; then
        grep -vx "$1" "$_active" >"$_active.new"
        mv "$_active.new" "$_active"
    fi
}
activate() { deactivate "$1"; echo "$1" >>"$_active"; }
node_stop() {
    _stop_rc=0
    if grep -qxF sw-node.service "$_active" 2>/dev/null &&
       grep -q '^ExecStop=' "$_node_unit"; then
        "$STUB_SHELL" "$_node_helper" stop "$STUB_R" || _stop_rc=$?
    fi
    deactivate sw-node.service
    if grep -q '^ExecStopPost=' "$_node_unit"; then
        "$STUB_SHELL" "$_node_helper" stop "$STUB_R" || _stop_rc=$?
    fi
    if ! grep -qxF 'RuntimeDirectoryPreserve=yes' "$_node_unit"; then rm -rf "$STUB_R/run/sw-node"; fi
    return "$_stop_rc"
}
acl_start() {
    [ ! -e "$STUB_STATE/fail_acl_service" ] || return 1
    "$STUB_SHELL" "$_acl_helper" "$(sed -n 's/^ExecStart=[^ ]* //p' "$_acl_unit")" || return 1
    activate sw-node-api-acl.service
}
node_start() {
    [ -f "$_node_unit" ] || return 1
    if grep -qxF 'Wants=sw-node-api-acl.service' "$_node_unit" &&
        ! grep -qxF sw-node-api-acl.service "$_active" 2>/dev/null; then
        acl_start || :
    fi
    mkdir -p "$STUB_R/run/sw-node"
    "$STUB_SHELL" "$_node_helper" start "$STUB_R" || return 1
    activate sw-node.service
}
case "$1" in
    is-active)
        if [ "$2" = --quiet ]; then set -- is-active "$3"; fi
        if [ "$2" = docker.service ] && [ ! -f "$STUB_STATE/docker_inactive" ]; then echo active; exit 0; fi
        if [ "$2" = docker.service ]; then echo inactive; exit 3; fi
        if grep -qx "$2" "$STUB_STATE/active_units" 2>/dev/null; then echo active; exit 0; fi
        case "$2" in ssh|sshd) [ -f "$STUB_STATE/ssh_down" ] || { echo active; exit 0; } ;; esac
        echo inactive; exit 3 ;;
    show)
        case "$*" in
            'show -p LoadState --value docker.service')
                if [ -x "$STUB_BIN/docker" ]; then echo loaded; else echo not-found; fi ;;
            'show -p LoadState -p FragmentPath -p DropInPaths -p NeedDaemonReload '*)
                _target=/etc/systemd/system/${10}
                if [ -f "$STUB_R$_target" ]; then
                    printf 'LoadState=loaded\nFragmentPath=%s\n' "$_target"
                else
                    printf 'LoadState=not-found\nFragmentPath=\n'
                fi
                if [ "${10}" = sw-node.service ] && [ -f "$STUB_STATE/node_unit_override" ]; then
                    printf 'DropInPaths=/etc/systemd/system/sw-node.service.d/local.conf\n'
                else echo 'DropInPaths='; fi
                [ ! -f "$STUB_STATE/node_unit_stale" ] && echo 'NeedDaemonReload=no' || echo 'NeedDaemonReload=yes' ;;
        esac ;;
    is-enabled)
        if [ "$2" = sw-node.service ] && [ ! -f "$STUB_STATE/node_enabled" ]; then echo disabled; exit 1; fi
        echo enabled; exit 0 ;;
    disable)
        if [ "${2:-}" = sw-ssh-rollback.timer ] && [ -f "$STUB_STATE/interrupt_disable" ]; then
            rm -f "$STUB_STATE/interrupt_disable"
            kill -KILL "$PPID"
            exit 1
        fi ;;
    stop)
        if [ "${2:-}" = docker.service ]; then
            if [ -f "$STUB_STATE/node_enabled" ]; then node_stop || exit 1; fi
            if grep -qxF 'PartOf=docker.service' "$_acl_unit" 2>/dev/null; then deactivate sw-node-api-acl.service; fi
            deactivate docker.service
            exit 0
        fi
        if [ "${2:-}" = sw-node.service ]; then node_stop; exit $?; fi
        # fire_on_stop: the timer has just fired when it is stopped (its rollback service runs before the stop returns).
        if [ "${2:-}" = sw-ssh-rollback.timer ] && [ -f "$STUB_STATE/fire_on_stop" ]; then
            rm -f "$STUB_STATE/fire_on_stop"
            sh "$STUB_R/var/lib/swellwright-ssh-rollback/rollback.sh"
        fi
        if [ -f "$STUB_STATE/active_units" ]; then
            grep -vx "$2" "$STUB_STATE/active_units" >"$STUB_STATE/active_units.new"
            mv "$STUB_STATE/active_units.new" "$STUB_STATE/active_units"
        fi ;;
    enable|start)
        if [ "$*" = "enable sw-node.service" ]; then
            : >"$STUB_STATE/node_enabled"
        elif [ "$*" = "enable sw-node-api-acl.service" ]; then
            grep -qxF 'WantedBy=docker.service' "$_acl_unit" && : >"$STUB_STATE/acl_wanted_by_docker"
        elif [ "$*" = "start sw-node-api-acl.service" ]; then
            if ! grep -qxF sw-node-api-acl.service "$_active" 2>/dev/null; then acl_start || exit 1; fi
        elif [ "$*" = "start sw-node.service" ]; then
            node_start || exit 1
        elif [ "$*" = "start docker.service" ]; then
            activate docker.service
            if [ -f "$STUB_STATE/acl_wanted_by_docker" ]; then acl_start || :; fi
            if [ -f "$STUB_STATE/node_enabled" ]; then node_start || exit 1; fi
        elif [ "${2:-}" = --now ] && [ "${3:-}" = sw-ssh-rollback.timer ]; then
            [ -f "$STUB_R/etc/systemd/system/$3" ] || exit 1
            echo "$3" >>"$STUB_STATE/active_units"
        elif [ "$1" = start ] && [ "${2:-}" = sw-ssh-rollback.timer ]; then
            echo "$2" >>"$STUB_STATE/active_units"
        fi ;;
    restart)
        if [ "${2:-}" = sw-node-api-acl.service ] && [ -f "$_acl_helper" ]; then
            acl_start || exit 1
        elif [ "${2:-}" = sw-node.service ] ||
             { [ "${2:-}" = docker.service ] && [ -f "$STUB_STATE/node_enabled" ]; }; then
            node_stop && node_start || exit 1
        fi ;;
esac
exit 0
EOF
    mkstub ufw <<'EOF'
case "$1" in
    status) if [ -f "$STUB_STATE/ufw_status" ]; then cat "$STUB_STATE/ufw_status"; else echo "Status: inactive"; fi ;;
    show) if [ -f "$STUB_STATE/ufw_added" ]; then cat "$STUB_STATE/ufw_added"; fi ;;
    --force) [ "${2:-}" = enable ] && printf 'Status: active\n\nTo   Action   From\n62050/tcp   ALLOW   192.0.2.20\n' >"$STUB_STATE/ufw_status" ;;
esac
exit 0
EOF
    # sshd -T [-C user=NAME,...] prints sshd_T.NAME, else sshd_T, else what a stock configuration says; the drop-ins the ssh step
    # writes are in effect as on a stock Ubuntu (they win), unless "$STUB_STATE/sshd_ignores_dropins" exists (or, for a login of
    # root only, sshd_ignores_dropins_for_root: a Match block that wins for it).
    mkstub sshd <<'EOF'
if [ "${1:-}" = -t ] && [ -f "$STUB_STATE/sshd_reject_candidate" ] &&
   { [ -f "$STUB_R/etc/ssh/sshd_config.d/00-sw-hardening.conf" ] ||
     [ -f "$STUB_R/etc/ssh/sshd_config.d/01-sw-keys-only.conf" ]; }; then exit 1; fi
if [ "${1:-}" = -T ]; then
    _u=
    case "${3:-}" in user=*) _u=${3#user=}; _u=${_u%%,*} ;; esac
    _nr=0; _np=0
    if [ ! -f "$STUB_STATE/sshd_ignores_dropins" ] && { [ "$_u" != root ] || [ ! -f "$STUB_STATE/sshd_ignores_dropins_for_root" ]; }; then
        grep -qx 'PermitRootLogin no' "$STUB_R/etc/ssh/sshd_config.d/00-sw-hardening.conf" 2>/dev/null && _nr=1
        grep -qx 'PasswordAuthentication no' "$STUB_R/etc/ssh/sshd_config.d/01-sw-keys-only.conf" 2>/dev/null && _np=1
    fi
    {
        if [ -n "$_u" ] && [ -f "$STUB_STATE/sshd_T.$_u" ]; then cat "$STUB_STATE/sshd_T.$_u"
        elif [ -f "$STUB_STATE/sshd_T" ]; then cat "$STUB_STATE/sshd_T"
        else printf 'port 22\npermitrootlogin yes\npasswordauthentication yes\npubkeyauthentication yes\nusepam yes\nstrictmodes yes\nauthorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2\nauthenticationmethods any\n'; fi
    } | awk -v nr="$_nr" -v np="$_np" '
        nr == 1 && $1 == "permitrootlogin" { print "permitrootlogin no"; next }
        np == 1 && ($1 == "passwordauthentication" || $1 == "kbdinteractiveauthentication") { print $1 " no"; next }
        { print }'
fi
exit 0
EOF
    # sudo -n -l -U NAME lists what NAME may run: sudo_l_NAME, else "may run everything" (with a password).
    mkstub sudo <<'EOF'
if [ "${1:-}" = -n ] && [ "${2:-}" = -l ] && [ "${3:-}" = -U ]; then
    if [ -f "$STUB_STATE/sudo_l_$4" ]; then cat "$STUB_STATE/sudo_l_$4"
    else printf 'User %s may run the following commands on node1:\n    (ALL : ALL) ALL\n' "$4"; fi
fi
exit 0
EOF
    # ssh-keygen -l -f FILE: a line that looks like a public key (a known type and a long enough base64 blob) has a fingerprint.
    mkstub ssh-keygen <<'EOF'
if [ "${1:-}" = -l ] && [ "${2:-}" = -f ]; then
    if grep -Eq '^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) AAAA[A-Za-z0-9+/]{16,}={0,3}( .*)?$' "$3" 2>/dev/null; then
        echo "256 SHA256:stub comment (ED25519)"; exit 0
    fi
    echo "$3 is not a public key file." >&2; exit 255
fi
exit 0
EOF
    mkstub docker <<'EOF'
[ -z "${SECRET_KEY+x}${NEW_USER_PASSWORD+x}" ] || { echo 'secret parameter inherited by Docker' >&2; exit 1; }
_id=abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234
[ "$1" != --host ] || shift 2
inspect_node() {
    [ -f "$STUB_STATE/container" ] || return 1
    _port=$(sed -n 's/^NODE_PORT=//p' "$STUB_STATE/container_env" 2>/dev/null)
    _state=$(cat "$STUB_STATE/node_state" 2>/dev/null || echo running)
    case "$*" in
        *State.Status*) printf '%s\n' "$_state" ;;
        *Config.Image*) cat "$STUB_STATE/container" ;;
        *SNI_VERIFICATION*) if grep -qxF 'SNI_VERIFICATION=true' "$STUB_STATE/container_env"; then echo true; fi ;;
        *Config.Env*) if [ -n "$_port" ]; then printf '"%s"\n' "$_port"; fi ;;
        *HostConfig.NetworkMode*)
            [ ! -f "$STUB_STATE/foreign_node" ] || { echo 'unrecognized'; return 0; }
            echo "/remnanode|remnanode|remnanode|$STUB_R/opt/remnanode/docker-compose.yml|$STUB_R/opt/remnanode|False|remnanode_default|false" ;;
        *HostConfig.PortBindings*|*NetworkSettings.Ports*)
            if [ -f "$STUB_STATE/node_bindings" ]; then cat "$STUB_STATE/node_bindings"
            else printf '443/tcp|127.0.0.1|443\n%s/tcp|0.0.0.0|%s\n' "$_port" "$_port"; fi ;;
        *NetworkSettings.Networks*) echo remnanode_default ;;
        *HostConfig.RestartPolicy*) cat "$STUB_STATE/restart_policy" 2>/dev/null || echo no ;;
        *) return 1 ;;
    esac
}
case "$1" in
    --version) echo "Docker version 28.0.0, build stub" ;;
    info)
        case "${3:-}" in
            *LiveRestoreEnabled*) cat "$STUB_STATE/docker_info" 2>/dev/null || echo 'linux false []' ;;
            *FirewallBackend*) cat "$STUB_STATE/docker_backend" 2>/dev/null || echo iptables ;;
            *) exit 1 ;;
        esac ;;
    network)
        case "$*" in
            'network ls '*)
                if [ -f "$STUB_STATE/container" ] || [ -f "$STUB_STATE/node_network" ]; then echo remnanode_default; fi ;;
            *' .Containers'*)
                if [ -f "$STUB_STATE/node_members" ]; then cat "$STUB_STATE/node_members"; fi ;;
            *) cat "$STUB_STATE/node_network" 2>/dev/null || echo 'bridge|local|false|false|{}|remnanode|default' ;;
        esac ;;
    compose)
        case "$*" in
            'compose version') echo "Docker Compose version v2.40.0" ;;
            *' pull remnanode')
                for _staging in "$STUB_R"/run/.sw-write.*; do [ ! -e "$_staging" ] || exit 1; done ;;
            *' create --no-build remnanode')
                sed -n 's/^    image: //p' "$3" >"$STUB_STATE/container"
                sed -n 's/^      - \(NODE_PORT=.*\|SNI_VERIFICATION=.*\)$/\1/p' "$3" >"$STUB_STATE/container_env"
                echo created >"$STUB_STATE/node_state"
                echo no >"$STUB_STATE/restart_policy"
                ;;
        esac ;;
    ps)
        if [ -f "$STUB_STATE/container" ]; then
            case "$*" in *'{{.ID}}'*) echo "$_id" ;; *) echo remnanode ;; esac
        fi
        case "$*" in *'label=com.docker.compose.project=remnanode'*)
            if [ -f "$STUB_STATE/node_siblings" ]; then cat "$STUB_STATE/node_siblings"; fi ;;
        esac ;;
    inspect) inspect_node "$@" || exit 1 ;;
    update)
        [ "$*" = "update --restart=no $_id" ] || exit 1
        printf 'no\n' >"$STUB_STATE/restart_policy" ;;
    container)
        case "$2" in
            inspect) [ "$5" = "$_id" ] && inspect_node "$@" || exit 1 ;;
            stop|start|wait)
                [ "$3" = "$_id" ] || exit 1
                case "$2" in stop) echo exited >"$STUB_STATE/node_state" ;; start) echo running >"$STUB_STATE/node_state" ;; esac ;;
            *) exit 1 ;;
        esac ;;
esac
exit 0
EOF
    # iptables keeps its chains in files: DOCKER-USER in "$STUB_STATE/iptables_rules", any other chain in ipt.CHAIN, each in the
    # format of `iptables -S` (a -N line first). -S of a chain that does not exist fails, as -N of one that does.
    mkstub iptables <<'EOF'
[ "$1" != -w ] || shift 2
if [ "$1" = -t ] && [ "$2" = nat ]; then
    [ ! -f "$STUB_STATE/no_docker_nat" ] || exit 1
    case "$4" in
        PREROUTING) printf -- '-P PREROUTING ACCEPT\n-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER\n' ;;
        DOCKER) printf -- '-N DOCKER\n' ;;
        *) exit 1 ;;
    esac
    exit 0
fi
_cf() { if [ "$1" = DOCKER-USER ]; then echo "$STUB_STATE/iptables_rules"; else echo "$STUB_STATE/ipt.$1"; fi; }
case "$1" in
    -S)
        _f=$(_cf "$2"); [ -f "$_f" ] || exit 1
        if [ "$2" = DOCKER-USER ] && [ -s "$STUB_STATE/fail_acl_readback" ] &&
           grep -qF -- "$(cat "$STUB_STATE/fail_acl_readback")" "$_f"; then
            rm -f "$STUB_STATE/fail_acl_readback"
            exit 1
        fi
        cat "$_f" ;;
    -N) _f=$(_cf "$2"); [ -f "$_f" ] && exit 1; printf -- '-N %s\n' "$2" >"$_f" ;;
esac
exit 0
EOF
    # iptables-restore --noflush: applies -N -F -X -A -I -D to the files of the iptables stub, all or nothing (a line that fails,
    # as -D of a rule that is not there or -X of a chain still jumped to, leaves every file as it was). The input is kept in
    # restore.in and appended to restore.log.
    mkstub iptables-restore <<'EOF'
cat >"$STUB_STATE/restore.in"
cat "$STUB_STATE/restore.in" >>"$STUB_STATE/restore.log"
_w=$(mktemp -d) || exit 1
[ -f "$STUB_STATE/iptables_rules" ] && cp "$STUB_STATE/iptables_rules" "$_w/DOCKER-USER"
for _c in "$STUB_STATE"/ipt.*; do [ -f "$_c" ] && cp "$_c" "$_w/${_c##*/ipt.}"; done
_err=0; _l=
while IFS= read -r _l; do
    # shellcheck disable=SC2086
    set -- $_l
    case "${1:-}" in
        '*filter'|COMMIT|'') continue ;;
        -N) if [ -f "$_w/$2" ]; then _err=1; break; fi; printf -- '-N %s\n' "$2" >"$_w/$2" ;;
        -F) [ -f "$_w/$2" ] || { _err=1; break; }; printf -- '-N %s\n' "$2" >"$_w/$2" ;;
        -X) [ -f "$_w/$2" ] || { _err=1; break; }
            if grep -q -- " -j $2\$" "$_w"/*; then _err=1; break; fi
            rm -f "$_w/$2" ;;
        -A) [ -f "$_w/$2" ] || { _err=1; break; }; printf '%s\n' "$_l" >>"$_w/$2" ;;
        -I) _c=$2; _p=$3; shift 3; [ -f "$_w/$_c" ] || { _err=1; break; }
            # Rule number _p is line _p + 1 (the -N line is first).
            awk -v p="$_p" -v r="-A $_c $*" 'NR == p + 1 { print r; d = 1 } { print } END { if (!d) print r }' "$_w/$_c" >"$_w/.t" && mv "$_w/.t" "$_w/$_c" ;;
        -D) _c=$2; _r="-A ${_l#-D }"
            grep -qxF -- "$_r" "$_w/$_c" 2>/dev/null || { _err=1; break; }
            awk -v r="$_r" '!d && $0 == r { d = 1; next } { print }' "$_w/$_c" >"$_w/.t" && mv "$_w/.t" "$_w/$_c" ;;
        *) _err=1; break ;;
    esac
done <"$STUB_STATE/restore.in"
if [ "$_err" = 0 ]; then
    for _c in "$STUB_STATE"/ipt.*; do [ -f "$_c" ] && rm -f "$_c"; done
    for _c in "$_w"/*; do
        [ -f "$_c" ] || continue
        if [ "${_c##*/}" = DOCKER-USER ]; then cp "$_c" "$STUB_STATE/iptables_rules"; else cp "$_c" "$STUB_STATE/ipt.${_c##*/}"; fi
    done
fi
rm -rf "$_w"
[ "$_err" = 0 ] || { echo "iptables-restore: line failed: $_l" >&2; exit 1; }
exit 0
EOF
    mkstub nginx <<'EOF'
case "${1:-}" in -v) echo "nginx version: nginx/1.28.0" >&2 ;; esac
exit 0
EOF
    mkstub haproxy <<'EOF'
case "${1:-}" in -v) echo "HAProxy version 3.2.5-stub 2026/01/01" ;; esac
exit 0
EOF
    mkstub fail2ban-client <<'EOF'
echo "Status for the jail: sshd"
exit 0
EOF
    mkstub timedatectl <<'EOF'
echo yes
exit 0
EOF
    mkstub sysctl <<'EOF'
case "$*" in
    *tcp_congestion_control*) echo bbr ;;
    *default_qdisc*) echo fq ;;
esac
exit 0
EOF
    mkstub hostname <<'EOF'
echo node1
exit 0
EOF
    # A process table is "$STUB_STATE/processes", one process per line: the process name, a tab, the command line. As
    # the real pgrep, -x compares the whole process name and -f matches the command line with an extended expression.
    mkstub pgrep <<'EOF'
[ -f "$STUB_STATE/processes" ] || exit 1
_mode=$1; _pattern=$2
while IFS="$(printf '\t')" read -r _comm _args; do
    case "$_mode" in
        -x) [ "$_comm" = "$_pattern" ] && exit 0 ;;
        -f) printf '%s\n' "$_args" | grep -Eq -- "$_pattern" && exit 0 ;;
    esac
done <"$STUB_STATE/processes"
exit 1
EOF
    # fuser (psmisc): the lock files are busy while "$STUB_STATE/locked" exists. Not installed unless a test says `have fuser`.
    mkstub fuser <<'EOF'
[ -f "$STUB_STATE/locked" ]
EOF
    mkstub dpkg <<'EOF'
[ "${1:-}" = --print-architecture ] && echo amd64
exit 0
EOF
    mkstub ip <<'EOF'
case "$*" in
    *"route get"*) echo "192.0.2.1 via 192.0.2.254 dev eth0 src 192.0.2.10 uid 0" ;;
    *"addr show"*) cat "$STUB_STATE/ip_addr" ;;
esac
exit 0
EOF
    # ss: the listening sockets are "$STUB_STATE/ss", the established connections (state established) "$STUB_STATE/ss_est".
    mkstub ss <<'EOF'
case "$*" in
    *established*) cat "$STUB_STATE/ss_est" 2>/dev/null ;;
    *) cat "$STUB_STATE/ss" ;;
esac
exit 0
EOF
    # openssl: certificates are dummy files; x509 answers from state.
    mkstub openssl <<'EOF'
case "$1" in
    req)
        while [ $# -gt 0 ]; do
            case "$1" in -keyout) printf 'KEY\n' >"$2" ;; -out) printf 'CERT\n' >"$2" ;; esac
            shift
        done ;;
    x509)
        case "$*" in
            *-subject*) cat "$STUB_STATE/cert_subject" ;;
            *-issuer*) cat "$STUB_STATE/cert_issuer" ;;
            *-enddate*) cat "$STUB_STATE/cert_end" ;;
        esac ;;
esac
exit 0
EOF
    # gpg: a "key file" is lines of markers, one key bundle per line: KEY-DOCKER (Docker's key), KEY-NGINX (two keys of
    # nginx.org), KEY-BAD (a key nobody pinned). --show-keys prints the primary key (and a subkey) of every marker, --import
    # adds the markers to the GnuPG home, --export prints the imported markers that hold one of the fingerprints asked for.
    mkstub gpg <<'EOF'
_fprs_of() {
    case "$1" in
        KEY-DOCKER) echo 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ;;
        KEY-NGINX) echo 8540A6F18833A80E9C1653A42FD21310B49F6B46 573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62 ;;
        KEY-BAD) echo 0123456789ABCDEF0123456789ABCDEF01234567 ;;
    esac
}
_home=; _mode=; _args=
while [ $# -gt 0 ]; do
    case "$1" in
        --homedir) _home=$2; shift ;;
        --show-keys|--import|--export) _mode=$1 ;;
        -*) ;;
        *) _args="$_args $1" ;;
    esac
    shift
done
if [ -f "$STUB_STATE/gpg_requires_isolated_home" ]; then
    case "$_home" in
        "$TMPDIR"/*) [ -d "$_home" ] || exit 2 ;;
        *) echo "GnuPG default home is absent or unavailable" >&2; exit 2 ;;
    esac
fi
case "$_mode" in
    --show-keys)
        for _f in $_args; do :; done
        [ -f "$_f" ] || exit 2
        while IFS= read -r _l; do
            for _p in $(_fprs_of "$_l"); do
                printf 'pub:-:4096:1:%s:1:::-:::scSC::::::23::0:\nfpr:::::::::%s:\nsub:-:4096:1:0000000000000000:1:::::s::::::23:\nfpr:::::::::FFFFFFFF%s:\n' "$(printf '%s' "$_p" | cut -c25-40)" "$_p" "$(printf '%s' "$_p" | cut -c9-40)"
            done
        done <"$_f" ;;
    --import) for _f in $_args; do cat "$_f" >>"$_home/ring" || exit 2; done ;;
    --export)
        [ -f "$_home/ring" ] || exit 0
        sort -u "$_home/ring" | while IFS= read -r _l; do
            for _p in $(_fprs_of "$_l"); do
                case " $_args " in *" $_p "*) printf '%s\n' "$_l"; break ;; esac
            done
        done ;;
esac
exit 0
EOF
    # curl: keys and the Docker script are written to -o FILE; the verify requests get a status code from state.
    mkstub curl <<'EOF'
_o=; _w=; _u=
while [ $# -gt 0 ]; do
    case "$1" in
        -o) _o=$2; shift ;;
        -w) _w=$2; shift ;;
        --connect-timeout|-m|--max-time|--resolve|--proto) shift ;;
        -*) ;;
        *) _u=$1 ;;
    esac
    shift
done
case "$_u" in
    *docker.com/linux/*/gpg) [ -z "$_o" ] || cat "$STUB_STATE/key_docker" >"$_o" ;;
    *nginx.org/keys/nginx_signing.key) [ -z "$_o" ] || cat "$STUB_STATE/key_nginx" >"$_o" ;;
    https://get.docker.com*) [ -z "$_o" ] || printf '#!/bin/sh\ncp "%s/stubs/docker" "%s/docker"\n' "$STUB_STATE" "$STUB_BIN" >"$_o" ;;
esac
if [ -n "$_w" ]; then
    case "$_u" in
        https://node1.example.com/) cat "$STUB_STATE/http_sni" 2>/dev/null || echo 200 ;;
        https://decoy.invalid/) cat "$STUB_STATE/http_decoy" 2>/dev/null || echo 404 ;;
        https://192.0.2.10/) cat "$STUB_STATE/http_ip" 2>/dev/null || echo 404 ;;
        http://192.0.2.10/) cat "$STUB_STATE/http_port80" 2>/dev/null || echo 404 ;;
        *) echo 200 ;;
    esac
fi
exit 0
EOF
    # apt-get: installing a package makes its command appear.
    mkstub apt-get <<'EOF'
case " $* " in
    *" install "*)
        for _a in "$@"; do
            case "$_a" in
                docker-ce) cp "$STUB_STATE/stubs/docker" "$STUB_BIN/docker" ;;
                nginx) cp "$STUB_STATE/stubs/nginx" "$STUB_BIN/nginx" ;;
                haproxy|haproxy=*) cp "$STUB_STATE/stubs/haproxy" "$STUB_BIN/haproxy" ;;
                fail2ban) cp "$STUB_STATE/stubs/fail2ban-client" "$STUB_BIN/fail2ban-client" ;;
                ufw) cp "$STUB_STATE/stubs/ufw" "$STUB_BIN/ufw" ;;
                sudo) cp "$STUB_STATE/stubs/sudo" "$STUB_BIN/sudo" ;;
                software-properties-common) cp "$STUB_STATE/stubs/add-apt-repository" "$STUB_BIN/add-apt-repository" ;;
            esac
        done ;;
esac
exit 0
EOF
    mkstub rrsync <<'EOF'
exit 0
EOF
}

node_acl_ready() {
    have docker
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20 "${1:-NODE_PORT=62050}"
    assert_rc 0
}

# The state of a healthy node: what verify expects to see.
healthy_state() {
    node_acl_ready
    printf '%s\n' docker nginx haproxy fail2ban sw-certs-reload.path sw-node-api-acl.service sw-node.service >"$STATE/active_units"
    : >"$STATE/node_enabled"
    mkdir -p "$R/run/sw-node"
    printf '%s\n' abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234 >"$R/run/sw-node/container"
    printf 'remnawave/node:3.4.6\n' >"$STATE/container"
    printf 'NODE_PORT=62050\nSNI_VERIFICATION=true\n' >"$STATE/container_env"
    printf -- '-N DOCKER-USER\n-A DOCKER-USER -s 192.0.2.20/32 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j RETURN\n-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j DROP\n' >"$STATE/iptables_rules"
    printf 'Status: active\n\nTo   Action   From\n62050/tcp   ALLOW   192.0.2.20\n' >"$STATE/ufw_status"
    printf 'port 22\npermitrootlogin no\npasswordauthentication no\n' >"$STATE/sshd_T"
    printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 4096 192.0.2.10:443 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:8444 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:443 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:62050 0.0.0.0:*\n' >"$STATE/ss"
    printf 'CN = node1.example.com\n' >"$STATE/cert_subject"
    printf 'CN = Example CA\n' >"$STATE/cert_issuer"
    printf 'notAfter=Jan  1 00:00:00 2099 GMT\n' >"$STATE/cert_end"
    printf 'certsync\n' >"$STATE/users"; : >"$STATE/sudo_members"; : >"$STATE/haspw"
    add_admin admin
    mkdir -p "$R/home/certsync/.ssh" "$R/opt/certs" "$R/etc/haproxy"
    printf 'command="rrsync /opt/certs/",restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAM sender@example\n' >"$R/home/certsync/.ssh/authorized_keys"
    printf 'CERT\n' >"$R/opt/certs/fullchain.cer"
    printf 'KEY\n' >"$R/opt/certs/private.key"
    chmod 640 "$R/opt/certs/private.key" 2>/dev/null
    printf '# stub\n' >"$R/etc/haproxy/haproxy.cfg"
    have docker nginx haproxy fail2ban-client ufw
}

# add_admin NAME [KEY LINE]: an administrator that counts: in the sudo group, with a password, a home only it can write, a
# ~/.ssh and a key, and sudo installed. A test breaks one thing at a time.
add_admin() {
    echo "$1" >>"$STATE/users"; echo "$1" >>"$STATE/sudo_members"; echo "$1" >>"$STATE/haspw"
    mkdir -p "$R/home/$1/.ssh"
    printf '%s\n' "${2:-$KEY1}" >"$R/home/$1/.ssh/authorized_keys"
    chmod 755 "$R/home/$1"; chmod 700 "$R/home/$1/.ssh"; chmod 600 "$R/home/$1/.ssh/authorized_keys"
    have sudo ssh-keygen
}

# setup_env: a fresh fake system for one test.
setup_env() {
    R=$T/root; BIN=$T/bin; STATE=$T/state; STUB_LOG=$T/calls.log
    mkdir -p "$R/etc/ssh/sshd_config.d" "$R/var/log" "$R/run" "$R/opt" "$R/home" "$R/usr/share/keyrings" "$R/etc/apt/sources.list.d" "$BIN" "$STATE" "$T/tmp"
    : >"$STUB_LOG"
    : >"$STATE/users"; : >"$STATE/sudo_members"; : >"$STATE/haspw"
    printf 'node1.example.com 192.0.2.10\n' >"$STATE/dns"
    printf '2: eth0    inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\n' >"$STATE/ip_addr"
    printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\n' >"$STATE/ss"
    printf -- '-P FORWARD DROP\n-A FORWARD -j DOCKER-USER\n' >"$STATE/ipt.FORWARD"
    printf -- '-N DOCKER-USER\n' >"$STATE/iptables_rules"
    printf 'KEY-DOCKER\n' >"$STATE/key_docker"
    printf 'KEY-NGINX\n' >"$STATE/key_nginx"
    printf '127.0.0.1 localhost\n' >"$R/etc/hosts"
    set_os ubuntu
    make_stubs
    have hostnamectl modprobe journalctl chown add-apt-repository rsync python3 sleep sync flock chmod install id getent useradd adduser usermod passwd chpasswd systemctl systemd-notify sshd
    have iptables iptables-restore openssl gpg curl apt-get hostname pgrep dpkg ip ss sysctl timedatectl rrsync stat ssh-keygen
    # The login shell of the fake accounts.
    mkdir -p "$R/bin"
    printf '#!/bin/sh\n' >"$R/bin/bash"
    chmod +x "$R/bin/bash"
    # The installer sees only the stubs and the basic tools (CORE): a real docker, nginx or sudo on the machine that runs the
    # suite must not be found by `command -v`, let alone run.
    SUT_PATH=$BIN:$CORE
}

# set_os ubuntu|debian|other
set_os() {
    case $1 in
        ubuntu) printf 'PRETTY_NAME="Ubuntu 24.04.2 LTS"\nID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n' ;;
        debian) printf 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n' ;;
        *) printf 'PRETTY_NAME="Example Linux 1"\nID=examplelinux\nVERSION_ID="1"\n' ;;
    esac >"$R/etc/os-release"
}

# run_inst ACTION [NAME=value ...]: runs the installer in the fake system; RC is its exit code, T/out and T/err its output.
run_inst() {
    _act=$1; shift
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} HOME="$T" TMPDIR="$T/tmp" SW_TEST_ROOT="$R" SW_NONINTERACTIVE=1 NO_COLOR=1 TERM=dumb "$@" \
        "$SHELL_UNDER_TEST" "$INSTALLER" "$_act" >"$T/out" 2>"$T/err" </dev/null
    RC=$?
}

# Model explicit confirmation in an isolated fake terminal. The all phase asks for three account fields
# first, and does not ask for the name and key again during hardening.
run_ssh_confirmed() {
    _rsc_phase=$1; shift
    case "$_rsc_phase" in
        all) printf '\n\n\n\n\ny\ny\n' ;;
        *)   printf '\n\n\n\ny\ny\n' ;;
    esac >"$T/confirm.in"
    run_inst ssh SSH_PHASE="$_rsc_phase" SW_NONINTERACTIVE=0 SW_TTY_IN="$T/confirm.in" SW_TTY_OUT="$T/tty" "$@"
}

# run_inst_args ARG...: the same with command line arguments and no default action.
run_inst_args() {
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} HOME="$T" TMPDIR="$T/tmp" SW_TEST_ROOT="$R" NO_COLOR=1 TERM=dumb \
        "$SHELL_UNDER_TEST" "$INSTALLER" "$@" >"$T/out" 2>"$T/err" </dev/null
    RC=$?
}

# in_inst 'code': source the installer (functions only) in a clean shell and run the code.
in_inst() {
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} HOME="$T" TMPDIR="$T/tmp" SW_TEST_ROOT="$R" SW_SOURCE_ONLY=1 NO_COLOR=1 TERM=dumb \
        "$SHELL_UNDER_TEST" -c ". '$INSTALLER'; $1" >"$T/out" 2>"$T/err" </dev/null
    RC=$?
}

# The parameters of a typical node, as arguments for run_inst (values without spaces; the keys are passed on their own).
SECRET=SENTINELnodeSECRETkey0123456789abcdef
NODE_ARGS="NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10 PANEL_ALLOW_IP=192.0.2.20 SECRET_KEY=$SECRET"
KEY1='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAM sender@example'
KEY2='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAABACKUPBACKUPBACKUPBACKUPBACKUPBACKUPBACK backup@example'

# A real unix socket at PATH, where the platform allows it (for the checks that look for the SelfSNI socket).
make_socket() {
    mkdir -p "$(dirname "$1")"
    for _py in python3 python; do
        command -v "$_py" >/dev/null 2>&1 || continue
        "$_py" -c 'import socket, sys; s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$1" 2>/dev/null && [ -S "$1" ] && return 0
    done
    return 1
}
