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
        printf '#!/bin/sh\nSTUB_LOG=%s; STUB_STATE=%s; STUB_R=%s; STUB_BIN=%s\n' "'$STUB_LOG'" "'$STATE'" "'$R'" "'$BIN'"
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
    for _c in hostnamectl modprobe journalctl chown add-apt-repository rsync python3 sleep flock sudo; do
        mkstub "$_c" <<'EOF'
exit 0
EOF
    done
    # chmod and install do their work as well, so that the files the installer writes exist.
    _real_chmod=$(command -v chmod); _real_install=$(command -v install)
    mkstub chmod <<EOF
"$_real_chmod" "\$@" 2>/dev/null
exit 0
EOF
    mkstub install <<EOF
exec "$_real_install" "\$@"
EOF
    # stat reports the mode written in FILE.mode when there is one (file systems that cannot hold a mode), the real one otherwise.
    mkstub stat <<EOF
if [ "\${1:-}" = -c ] && [ "\${2:-}" = %a ] && [ -f "\${3:-}.mode" ]; then cat "\$3.mode"; exit 0; fi
exec "$(command -v stat)" "\$@"
EOF
    mkstub id <<EOF
case "\${1:-}" in
    ''|-*) exec "$(command -v id)" "\$@" ;;
esac
grep -qx "\$1" "\$STUB_STATE/users" 2>/dev/null
EOF
    mkstub getent <<'EOF'
case "$1" in
    passwd)
        grep -qx "$2" "$STUB_STATE/users" 2>/dev/null || exit 2
        printf '%s:x:1000:1000::%s/home/%s:/bin/bash\n' "$2" "$STUB_R" "$2" ;;
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
exit 0
EOF
    mkstub adduser <<'EOF'
for _a in "$@"; do _u=$_a; done
echo "$_u" >>"$STUB_STATE/users"
mkdir -p "$STUB_R/home/$_u"
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
    mkstub systemctl <<'EOF'
case "$1" in
    is-active)
        if grep -qx "$2" "$STUB_STATE/active_units" 2>/dev/null; then echo active; exit 0; fi
        echo inactive; exit 3 ;;
    is-enabled) echo enabled; exit 0 ;;
esac
exit 0
EOF
    mkstub ufw <<'EOF'
case "$1" in
    status) if [ -f "$STUB_STATE/ufw_status" ]; then cat "$STUB_STATE/ufw_status"; else echo "Status: inactive"; fi ;;
    --force) [ "${2:-}" = enable ] && printf 'Status: active\n\nTo   Action   From\n62050/tcp   ALLOW   192.0.2.20\n' >"$STUB_STATE/ufw_status" ;;
esac
exit 0
EOF
    mkstub sshd <<'EOF'
if [ "${1:-}" = -T ]; then
    if [ -f "$STUB_STATE/sshd_T" ]; then cat "$STUB_STATE/sshd_T"; else printf 'port 22\npermitrootlogin yes\npasswordauthentication yes\n'; fi
fi
exit 0
EOF
    mkstub docker <<'EOF'
case "$1" in
    --version) echo "Docker version 28.0.0, build stub" ;;
    compose)
        case "$2" in version) echo "Docker Compose version v2.40.0" ;; esac ;;
    ps) [ -f "$STUB_STATE/container" ] && echo "remnanode" ;;
    inspect)
        [ -f "$STUB_STATE/container" ] || exit 1
        case "$*" in
            *State.Status*) echo running ;;
            *Config.Image*) cat "$STUB_STATE/container" ;;
            *Config.Env*) cat "$STUB_STATE/container_env" 2>/dev/null ;;
        esac ;;
esac
exit 0
EOF
    mkstub iptables <<'EOF'
case "$1 $2" in
    "-S DOCKER-USER") cat "$STUB_STATE/iptables_rules" 2>/dev/null ;;
esac
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
    mkstub ss <<'EOF'
cat "$STUB_STATE/ss"
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
    # gpg: the "keys" are marker texts; the stub prints the fingerprints that belong to the marker.
    mkstub gpg <<'EOF'
case "$1" in
    --show-keys)
        for _a in "$@"; do _f=$_a; done
        if grep -q 'KEY-DOCKER' "$_f" 2>/dev/null; then
            printf 'pub:-:4096:1:8D81803C0EBFCD88:1487788586:::-:::escaESCA::::::23::0:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\nuid:-::::1487792064::X::Docker Release::::::::::0:\nsub:-:4096:1:7EA0A9C3F273FCD8:1487788586:::::s::::::23:\nfpr:::::::::D3306A018370199E527AE7997EA0A9C3F273FCD8:\n'
        elif grep -q 'KEY-NGINX' "$_f" 2>/dev/null; then
            printf 'pub:-:4096:1:2FD21310B49F6B46:1716988950:::-:::scSC::::::23::0:\nfpr:::::::::8540A6F18833A80E9C1653A42FD21310B49F6B46:\nuid:-::::1::X::nginx signing key::::::::::0:\npub:-:2048:1:ABF5BD827BD9BF62:1313747554:1811172661::-:::scSC::::::23::0:\nfpr:::::::::573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62:\nuid:-::::1::X::nginx signing key::::::::::0:\n'
        elif grep -q 'KEY-BAD' "$_f" 2>/dev/null; then
            printf 'pub:-:4096:1:AAAAAAAAAAAAAAAA:1:::-:::scSC::::::23::0:\nfpr:::::::::0123456789ABCDEF0123456789ABCDEF01234567:\n'
        fi ;;
    --dearmor)
        # gpg --dearmor --yes -o OUT IN
        _in=; _out=
        while [ $# -gt 0 ]; do case "$1" in -o) _out=$2; shift ;; --dearmor|--yes) ;; *) _in=$1 ;; esac; shift; done
        cp "$_in" "$_out" ;;
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
        --connect-timeout|-m|--max-time|--resolve) shift ;;
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

# The state of a healthy node: what verify expects to see.
healthy_state() {
    printf '%s\n' docker nginx haproxy fail2ban sw-certs-reload.path sw-node-api-acl.service >"$STATE/active_units"
    printf 'remnawave/node:3.4.6\n' >"$STATE/container"
    printf 'NODE_PORT=62050\nSNI_VERIFICATION=true\n' >"$STATE/container_env"
    printf -- '-N DOCKER-USER\n-A DOCKER-USER -s 192.0.2.20/32 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j RETURN\n-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j DROP\n' >"$STATE/iptables_rules"
    printf 'Status: active\n\nTo   Action   From\n62050/tcp   ALLOW   192.0.2.20\n' >"$STATE/ufw_status"
    printf 'port 22\npermitrootlogin no\npasswordauthentication no\n' >"$STATE/sshd_T"
    printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 4096 192.0.2.10:443 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:8444 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:443 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:62050 0.0.0.0:*\n' >"$STATE/ss"
    printf 'CN = node1.example.com\n' >"$STATE/cert_subject"
    printf 'CN = Example CA\n' >"$STATE/cert_issuer"
    printf 'notAfter=Jan  1 00:00:00 2099 GMT\n' >"$STATE/cert_end"
    printf 'certsync\nadmin\n' >"$STATE/users"
    printf 'admin\n' >"$STATE/sudo_members"
    mkdir -p "$R/home/certsync/.ssh" "$R/opt/certs" "$R/etc/haproxy"
    printf 'command="rrsync /opt/certs/",restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAM sender@example\n' >"$R/home/certsync/.ssh/authorized_keys"
    printf 'CERT\n' >"$R/opt/certs/fullchain.cer"
    printf 'KEY\n' >"$R/opt/certs/private.key"
    chmod 640 "$R/opt/certs/private.key" 2>/dev/null
    printf '# stub\n' >"$R/etc/haproxy/haproxy.cfg"
    have docker nginx haproxy fail2ban-client ufw
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
    printf 'KEY-DOCKER\n' >"$STATE/key_docker"
    printf 'KEY-NGINX\n' >"$STATE/key_nginx"
    printf '127.0.0.1 localhost\n' >"$R/etc/hosts"
    set_os ubuntu
    make_stubs
    have hostnamectl modprobe journalctl chown add-apt-repository rsync python3 sleep flock chmod install id getent useradd adduser usermod passwd chpasswd systemctl sshd
    have iptables openssl gpg curl apt-get hostname pgrep dpkg ip ss sysctl timedatectl rrsync stat
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
