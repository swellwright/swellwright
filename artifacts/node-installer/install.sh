#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Swellwright node installer: installs and hardens a Remnawave node on Debian or Ubuntu.
#
#   Internet -> HAProxy (SNI routing, public IP:443)
#                 |- node domain ----> remnanode container (Xray on 127.0.0.1:443)
#                 |                       \-> nginx "SelfSNI" site (unix socket, PROXY protocol)
#                 \- any other SNI, or none -> nginx default site (404) on 127.0.0.1:8444
#
# Usage:        sudo sh install.sh [options] [action]
# Actions:      full redeploy preflight base system hostname firewall fail2ban docker apiacl certsync nginx haproxy node
#               verify ssh rename menu help version demo        (no action: the menu)
# Options:      --env-file FILE     read parameters from FILE (NAME=value lines, never executed)
#               --non-interactive   never ask; a missing required parameter stops the run
# Parameters:   NODE_DOMAIN NODE_IP NODE_PORT SECRET_KEY PANEL_ALLOW_IP SSH_PORT CERTSYNC_PUBKEY NODE_IMAGE_TAG ...
#               `sh install.sh help` lists them all; the same list is in manifest.json and the README.
# Exit codes:   0 success, 1 error (the run stopped), 2 the checks of verify or preflight found a failure.
#
# This file is a Swellwright artifact: immutable once released, shipped to a server and verified by its SHA-256 from
# manifest.json. The manifest is generated from the `#@` lines below by scripts/artifact-manifest.mjs; do not edit it by hand.
#
# Design rules: one function per step; every change to the system goes through run_cmd, q, write_file or apt_install;
# every file path under /etc, /opt, /var, /home is written as $R/path so that the test suite can run all steps in a
# temporary root with stubbed commands (SW_TEST_ROOT is for tests only). Nothing is ever evaluated from a file or a
# parameter: values are validated and only then used in configuration files.

set -u

INSTALLER_VERSION=1.0.1

DEFAULT_NODE_PORT=62050
# The node image is pinned (never :latest). Update the default with the artifact version when the supported node release changes.
DEFAULT_NODE_IMAGE_TAG=3.4.6
DEFAULT_HAPROXY_VERSION=3.2

#@meta {"name":"node-installer","description":"Installs and hardens a Remnawave node: firewall, Docker, HAProxy SNI routing, nginx default site, the node container and the checks.","interpreter":"sh","minOs":"debian 12 / ubuntu 22.04"}

# Steps, in the order the manifest lists them. inFull: run by `full`, in this order (see PHASES below).
#@step {"id":"preflight","title":"Preflight checks","readOnly":true,"needsRoot":true,"inFull":false,"params":[],"requires":[]}
#@step {"id":"base","title":"Base packages and system upgrade","readOnly":false,"needsRoot":true,"inFull":true,"params":["BASE_UPGRADE"],"requires":[]}
#@step {"id":"system","title":"System tuning: BBR, journald, NTP","readOnly":false,"needsRoot":true,"inFull":true,"params":[],"requires":[]}
#@step {"id":"hostname","title":"Host name and /etc/hosts","readOnly":false,"needsRoot":true,"inFull":true,"params":["NODE_DOMAIN","NODE_IP"],"requires":["NODE_DOMAIN","NODE_IP"]}
#@step {"id":"firewall","title":"Firewall (UFW)","readOnly":false,"needsRoot":true,"inFull":true,"params":["SSH_PORT","NODE_PORT","PANEL_ALLOW_IP"],"requires":["PANEL_ALLOW_IP"]}
#@step {"id":"fail2ban","title":"fail2ban for SSH","readOnly":false,"needsRoot":true,"inFull":true,"params":["SSH_PORT","PANEL_ALLOW_IP","FAIL2BAN_IGNORE_EXTRA"],"requires":[]}
#@step {"id":"docker","title":"Docker","readOnly":false,"needsRoot":true,"inFull":true,"params":["DOCKER_SOURCE"],"requires":[]}
#@step {"id":"apiacl","title":"Node API port open to the panel only (DOCKER-USER and UFW)","readOnly":false,"needsRoot":true,"inFull":true,"params":["NODE_PORT","PANEL_ALLOW_IP"],"requires":["PANEL_ALLOW_IP"]}
#@step {"id":"certsync","title":"Certificate receiver (restricted rsync key)","readOnly":false,"needsRoot":true,"inFull":true,"params":["CERTSYNC_PUBKEY","NODE_DOMAIN"],"requires":["CERTSYNC_PUBKEY","NODE_DOMAIN"]}
#@step {"id":"nginx","title":"nginx: SelfSNI site and default site","readOnly":false,"needsRoot":true,"inFull":true,"params":["NODE_DOMAIN"],"requires":["NODE_DOMAIN"]}
#@step {"id":"haproxy","title":"HAProxy: SNI routing with a default backend","readOnly":false,"needsRoot":true,"inFull":true,"params":["NODE_DOMAIN","NODE_IP","HAPROXY_SOURCE","HAPROXY_VERSION"],"requires":["NODE_DOMAIN","NODE_IP"]}
#@step {"id":"node","title":"Remnawave node container","readOnly":false,"needsRoot":true,"inFull":true,"params":["NODE_PORT","SECRET_KEY","NODE_IMAGE_TAG"],"requires":["SECRET_KEY"]}
#@step {"id":"verify","title":"Verify the node","readOnly":true,"needsRoot":true,"inFull":true,"params":["NODE_DOMAIN","NODE_IP","NODE_PORT","NODE_IMAGE_TAG"],"requires":[]}
#@step {"id":"ssh","title":"SSH: administrator account, keys, root login","readOnly":false,"needsRoot":true,"inFull":false,"params":["SSH_PHASE","NEW_USER","NEW_USER_PUBKEY","NEW_USER_PUBKEY2","NEW_USER_PASSWORD","SSH_DISABLE_ROOT","SSH_DISABLE_PASSWORD"],"requires":["NEW_USER","NEW_USER_PUBKEY"]}
#@step {"id":"rename","title":"Rename the node on this server","readOnly":false,"needsRoot":true,"inFull":false,"params":["NODE_DOMAIN","RENAME_FROM","RENAME_ALIAS","NODE_IP"],"requires":["NODE_DOMAIN"]}

# Parameters. pattern and default may name a constant of this file as "@NAME": the manifest takes its text from the
# assignment below, so the validators and the manifest cannot drift. group node: read from the environment, an
# env file or the saved configuration; group installer: environment or option only.
#@param {"name":"NODE_DOMAIN","group":"node","description":"Public domain name of the node: SNI, host name and SelfSNI site. Upper case is converted to lower case.","secret":false,"pattern":"@RE_DOMAIN","example":"node1.example.com"}
#@param {"name":"NODE_IP","group":"node","description":"Public IPv4 address of this server; HAProxy binds it on port 443.","secret":false,"pattern":"@RE_IPV4","example":"192.0.2.10"}
#@param {"name":"NODE_PORT","group":"node","description":"TCP port of the node API (panel to node).","secret":false,"pattern":"@RE_PORT","default":"@DEFAULT_NODE_PORT","example":"62050"}
#@param {"name":"SECRET_KEY","group":"node","description":"Node secret key from the panel (the SECRET_KEY of the compose file the panel shows for the node). 16 to 8192 characters of letters, digits and + / = _ . : -. Kept only in the compose file, mode 600.","secret":true,"pattern":"@RE_SECRET"}
#@param {"name":"PANEL_ALLOW_IP","group":"node","description":"IPv4 addresses (space separated) that may reach the node API port: the panel. Nobody else can.","secret":false,"pattern":"@RE_IPV4_LIST","example":"192.0.2.20 198.51.100.7"}
#@param {"name":"SSH_PORT","group":"node","description":"SSH port that the firewall keeps open. Default: the port sshd reports, else 22.","secret":false,"pattern":"@RE_PORT","default":"22","example":"22"}
#@param {"name":"CERTSYNC_PUBKEY","group":"node","description":"Public key of whatever delivers certificates to /opt/certs. Installed for the user certsync, limited to rrsync in that directory (command=, restrict). Empty: the receiver is not set up and full skips it.","secret":false,"pattern":"@RE_PUBKEY","example":"ssh-ed25519 AAAA... sender@example"}
#@param {"name":"NODE_IMAGE_TAG","group":"node","description":"Tag of the remnawave/node image, pinned in the compose file.","secret":false,"pattern":"@RE_TAG","default":"@DEFAULT_NODE_IMAGE_TAG","example":"3.4.6"}
#@param {"name":"FAIL2BAN_IGNORE_EXTRA","group":"node","description":"Extra IPv4 addresses or CIDR ranges (prefix 8 to 32, space separated) that fail2ban never bans, for example the Swellwright server.","secret":false,"pattern":"@RE_IPV4_CIDR_LIST","example":"192.0.2.0/24 198.51.100.7"}
#@param {"name":"BASE_UPGRADE","group":"node","description":"Run apt upgrade in the base step.","secret":false,"enum":["yes","no"],"default":"yes"}
#@param {"name":"DOCKER_SOURCE","group":"node","description":"apt: Docker's apt repository with its signing key checked against a pinned fingerprint. script: the get.docker.com convenience script.","secret":false,"enum":["apt","script"],"default":"apt"}
#@param {"name":"HAPROXY_SOURCE","group":"node","description":"auto: the PPA on Ubuntu, the distribution package on Debian. ppa: the vbernat PPA of HAPROXY_VERSION. distro: the distribution package.","secret":false,"enum":["auto","ppa","distro"],"default":"auto"}
#@param {"name":"HAPROXY_VERSION","group":"node","description":"HAProxy series for the PPA (major.minor).","secret":false,"pattern":"@RE_VERSION2","default":"@DEFAULT_HAPROXY_VERSION","example":"3.2"}
#@param {"name":"SSH_PHASE","group":"node","description":"user: create the administrator and its keys. root: close root login (needs an administrator). all: both.","secret":false,"enum":["user","root","all"],"default":"all"}
#@param {"name":"NEW_USER","group":"node","description":"Administrator account with sudo (not required for SSH_PHASE=root). Not root and not certsync.","secret":false,"pattern":"@RE_USER","example":"admin"}
#@param {"name":"NEW_USER_PUBKEY","group":"node","description":"Public SSH key of the administrator (not required for SSH_PHASE=root).","secret":false,"pattern":"@RE_PUBKEY","example":"ssh-ed25519 AAAA... admin@example"}
#@param {"name":"NEW_USER_PUBKEY2","group":"node","description":"Optional second (backup) public SSH key of the administrator.","secret":false,"pattern":"@RE_PUBKEY","example":"ssh-ed25519 AAAA... backup@example"}
#@param {"name":"NEW_USER_PASSWORD","group":"node","description":"Password of a newly created administrator (sudo needs it). Required without a terminal. Only through the environment or an env file, never logged.","secret":true,"pattern":"@RE_PASSWORD"}
#@param {"name":"SSH_DISABLE_ROOT","group":"node","description":"Close root login over SSH (only when an administrator exists).","secret":false,"enum":["yes","no"],"default":"yes"}
#@param {"name":"SSH_DISABLE_PASSWORD","group":"node","description":"Close password login over SSH (only when an administrator has a key). Check the key login in another window first.","secret":false,"enum":["yes","no"],"default":"no"}
#@param {"name":"RENAME_FROM","group":"node","description":"The former domain in the rename step. Default: the domain from the saved configuration.","secret":false,"pattern":"@RE_DOMAIN","example":"node1.example.com"}
#@param {"name":"RENAME_ALIAS","group":"node","description":"Domains (space separated) that nginx and HAProxy keep accepting besides the new one, until clients have the new name.","secret":false,"pattern":"@RE_DOMAIN_LIST","example":"node1.example.com"}
#@param {"name":"INSTALL_MODE","group":"node","description":"new: a node that is not in the panel yet. redeploy: an existing node on a new or reinstalled server (changes the closing checklist).","secret":false,"enum":["new","redeploy"],"default":"new"}
#@param {"name":"SW_NONINTERACTIVE","group":"installer","description":"1: never ask; a missing required parameter stops the run.","secret":false,"enum":["0","1"],"default":"0"}
#@param {"name":"SW_ENV_FILE","group":"installer","description":"File with NAME=value lines for the parameters above (the option --env-file does the same). Mode 600, owned by root.","secret":false,"example":"/root/node.env"}
#@param {"name":"SW_VERBOSE","group":"installer","description":"1: show the output of apt and docker on the screen (it always goes to the journal).","secret":false,"enum":["0","1"],"default":"0"}
#@param {"name":"SW_ASCII","group":"installer","description":"1: plain ASCII symbols instead of Unicode ones.","secret":false,"enum":["0","1"],"default":"0"}
#@param {"name":"NO_COLOR","group":"installer","description":"Any non-empty value switches colours off (no-color.org).","secret":false,"example":"1"}

# Parameters read from the environment, an env file and the saved configuration (the group node above).
PARAM_NAMES="NODE_DOMAIN NODE_IP NODE_PORT SECRET_KEY PANEL_ALLOW_IP SSH_PORT CERTSYNC_PUBKEY NODE_IMAGE_TAG FAIL2BAN_IGNORE_EXTRA BASE_UPGRADE DOCKER_SOURCE HAPROXY_SOURCE HAPROXY_VERSION SSH_PHASE NEW_USER NEW_USER_PUBKEY NEW_USER_PUBKEY2 NEW_USER_PASSWORD SSH_DISABLE_ROOT SSH_DISABLE_PASSWORD RENAME_FROM RENAME_ALIAS INSTALL_MODE"
# Parameters that are saved to the configuration file (never a secret).
SAVED_PARAMS="NODE_DOMAIN NODE_IP NODE_PORT SSH_PORT CERTSYNC_PUBKEY PANEL_ALLOW_IP FAIL2BAN_IGNORE_EXTRA"
# What `full` runs, in this order.
PHASES="base system hostname firewall fail2ban docker apiacl certsync nginx haproxy node verify"

# Validators: extended regular expressions for grep -E, ASCII only. A value that contains a line break never matches.
RE_DOMAIN='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$'
RE_IPV4='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'
RE_IPV4_LIST='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])( ((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9]))*$'
RE_IPV4_CIDR_LIST='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(/(8|9|[12][0-9]|3[0-2]))?( ((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(/(8|9|[12][0-9]|3[0-2]))?)*$'
RE_PORT='^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$'
# No large upper bound in a pattern: grep -E expands {16,8192} into thousands of states and needs half a minute to compile it. The upper limit is checked by v_secret.
RE_SECRET='^[A-Za-z0-9+/=_.:-]{16,}$'
RE_PUBKEY='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]{16,}={0,3}( [A-Za-z0-9@._:+=/ -]{1,128})?$'
RE_TAG='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
RE_VERSION2='^[0-9]{1,2}\.[0-9]{1,2}$'
RE_USER='^[a-z_][a-z0-9_-]{0,31}$'
RE_PASSWORD='^[ -~]{8,128}$'
RE_DOMAIN_LIST='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})( ([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59}))*$'

# Paths. R is empty in production. The names without $R are what configuration files and commands see.
R=${SW_TEST_ROOT:-}
CONF_FILE=$R/etc/swellwright-node-installer.conf
LOG_FILE=$R/var/log/swellwright-node-installer.log
LOCK_FILE=$R/run/swellwright-node-installer.lock
CERT_DIR=/opt/certs
CERT_FILE=fullchain.cer
KEY_FILE=private.key
CERT_USER=certsync
SITE_ROOT=/var/www/html/site
NODE_DIR=/opt/remnanode
NODE_CONTAINER=remnanode
NGINX_SOCK=/dev/shm/nginx.sock
DECOY_PORT=8444
API_ACL_CONF=/etc/sw-node-api-allow.conf
API_ACL_BIN=/usr/local/sbin/sw-node-api-acl.sh
API_ACL_UNIT=/etc/systemd/system/sw-node-api-acl.service
# Fingerprints of the primary keys that sign the packages; a downloaded key is accepted only if it carries one of them.
DOCKER_KEY_FPRS="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
NGINX_KEY_FPRS="573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62 8540A6F18833A80E9C1653A42FD21310B49F6B46 9E9BE90EACBCDE69FE9B204CBCDCD8A38D88A2B3"

ASKED=""
NL='
'
CR=$(printf '\r')
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- appearance

ESC=$(printf '\033')
UI_TTY=0; UI_COLOR=0; UI_UTF=1
[ -t 1 ] && UI_TTY=1
if [ "${SW_FORCE_COLOR:-0}" = 1 ]; then
    UI_COLOR=1
elif [ "$UI_TTY" = 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
    UI_COLOR=1
fi
case "${TERM:-}" in linux) UI_UTF=0 ;; esac
[ "${SW_ASCII:-0}" = 1 ] && UI_UTF=0

if [ "$UI_COLOR" = 1 ]; then
    C_0="${ESC}[0m"; C_B="${ESC}[1m"; C_D="${ESC}[2m"
    C_R="${ESC}[31m"; C_G="${ESC}[32m"; C_Y="${ESC}[33m"; C_BL="${ESC}[34m"; C_C="${ESC}[36m"
    C_W="${ESC}[97m"; C_GR="${ESC}[90m"
else
    C_0=; C_B=; C_D=; C_R=; C_G=; C_Y=; C_BL=; C_C=; C_W=; C_GR=
fi

if [ "$UI_UTF" = 1 ]; then
    S_OK="✔"; S_ERR="✖"; S_WARN="⚠"; S_INFO="ℹ"; S_RUN="▶"; S_DOT="●"; S_RING="○"; S_ARROW="➜"; S_BOX="☐"
    H="─"; V="│"; TL="╭"; TR="╮"; BL="╰"; BR="╯"; DOTS="·"
    SPIN="⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏"
else
    S_OK="+"; S_ERR="x"; S_WARN="!"; S_INFO="i"; S_RUN=">"; S_DOT="*"; S_RING="o"; S_ARROW="->"; S_BOX="[ ]"
    H="-"; V="|"; TL="+"; TR="+"; BL="+"; BR="+"; DOTS="-"
    # shellcheck disable=SC1003
    SPIN='| / - \'
fi

UI_W=72
if [ "$UI_TTY" = 1 ]; then
    _cols=$(tput cols 2>/dev/null || printf 80)
    case "$_cols" in ''|*[!0-9]*) _cols=80 ;; esac
    UI_W=$((_cols - 2))
    [ "$UI_W" -gt 76 ] && UI_W=76
    [ "$UI_W" -lt 56 ] && UI_W=56
fi
KV_W=24
CHK_W=38

# Every label and message of the installer is ASCII, so the length of a string in characters is what ${#} gives.
ulen() { printf '%s' "${#1}"; }
rep() { _n=$2; _s=; while [ "$_n" -gt 0 ]; do _s="$_s$1"; _n=$((_n - 1)); done; printf '%s' "$_s"; }
fmt_dur() { _s=$1; if [ "$_s" -ge 60 ]; then printf '%dm %02ds' $((_s / 60)) $((_s % 60)); else printf '%ds' "$_s"; fi; }

# The journal. Nothing secret is ever passed to these functions.
logf() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG_FILE" 2>/dev/null; return 0; }
log()  { printf ' %s%s%s %s\n' "$C_BL" "$S_INFO" "$C_0" "$*"; logf "INFO $*"; }
ok()   { printf ' %s%s%s %s\n' "$C_G" "$S_OK" "$C_0" "$*"; logf "OK $*"; }
note() { printf '   %s%s%s\n' "$C_GR" "$*" "$C_0"; logf "NOTE $*"; }
warn() { printf ' %s%s%s %s\n' "$C_Y" "$S_WARN" "$C_0" "$*" >&2; logf "WARN $*"; }
die()  { printf ' %s%s %s%s\n' "$C_R$C_B" "$S_ERR" "$*" "$C_0" >&2; logf "ERROR $*"; exit 1; }
rule() { printf '%s%s%s\n' "$C_GR" "$(rep "$H" "$UI_W")" "$C_0"; }
dimcat() { while IFS= read -r _dl; do printf '     %s%s%s\n' "$C_GR" "$_dl" "$C_0"; done; }
# q: run a command quietly; its output goes to the journal.
q()    { "$@" >>"$LOG_FILE" 2>&1; }

# A step header: "> Step 3/12 - Name" and a rule.
title() {
    _tt=$1
    if [ -n "${STEP_TOTAL:-}" ] && [ "${STEP_N:-0}" -gt 0 ]; then _pre="Step $STEP_N/$STEP_TOTAL $DOTS "; else _pre=; fi
    printf '\n%s%s %s%s%s\n' "$C_C$C_B" "$S_RUN" "$_pre" "$_tt" "$C_0"
    rule
    logf "== $_tt"
}
sect() { printf '\n  %s%s%s\n' "$C_Y$C_B" "$1" "$C_0"; }
kv() {
    _kl=$1; shift
    _pad=$((KV_W - $(ulen "$_kl"))); [ "$_pad" -lt 1 ] && _pad=1
    printf '   %s%s%s%s%s%s%s\n' "$C_GR" "$_kl" "$C_0" "$(rep ' ' "$_pad")" "$C_W" "$*" "$C_0"
}

bx_top() { printf '%s%s%s%s%s\n' "$C_C" "$TL" "$(rep "$H" $((UI_W - 2)))" "$TR" "$C_0"; }
bx_bot() { printf '%s%s%s%s%s\n' "$C_C" "$BL" "$(rep "$H" $((UI_W - 2)))" "$BR" "$C_0"; }
bx_row() {
    _bt=$1; _bc=${2:-}
    _pad=$((UI_W - 4 - $(ulen "$_bt"))); [ "$_pad" -lt 0 ] && _pad=0
    printf '%s%s%s %s%s%s%s %s%s%s\n' "$C_C" "$V" "$C_0" "$_bc" "$_bt" "$C_0" "$(rep ' ' "$_pad")" "$C_C" "$V" "$C_0"
}

# The source address of the default route (the address of a documentation range is only used to ask the kernel for a route).
host_ip() { ip -4 route get 192.0.2.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}'; }

banner() {
    printf '\n'
    bx_top
    bx_row "Swellwright node installer   v$INSTALLER_VERSION" "$C_B$C_W"
    bx_row "HAProxy / nginx SelfSNI / Remnawave node container" "$C_GR"
    bx_row "Server: $(hostname 2>/dev/null) / $(host_ip)" "$C_GR"
    bx_row "System: ${PRETTY_NAME:-Linux} / kernel $(uname -r)" "$C_GR"
    bx_bot
}

# A spinner: spin PID "description"
spin() {
    _sp=$1; _sd=$2
    while kill -0 "$_sp" 2>/dev/null; do
        for _sf in $SPIN; do
            kill -0 "$_sp" 2>/dev/null || break
            printf '\r %s%s%s %s%s%s ' "$C_C" "$_sf" "$C_0" "$C_D" "$_sd" "$C_0"
            sleep 0.1 2>/dev/null || sleep 1
        done
    done
    printf '\r%s[2K' "$ESC"
}

# run_cmd "description" command args...: the output of the command goes to the journal; the screen shows a spinner and the
# result, and on failure the last lines of the output. Never pass a secret as an argument: arguments are journaled.
run_cmd() {
    _rd=$1; shift
    _ro=$(mktemp) || die "mktemp failed"
    _rt0=$(date +%s)
    logf "RUN $_rd :: $*"
    if [ "${SW_VERBOSE:-0}" = 1 ]; then
        printf ' %s%s%s %s\n' "$C_C" "$S_RUN" "$C_0" "$_rd"
        _rrc=$(mktemp) || die "mktemp failed"
        ( "$@" </dev/null; echo $? >"$_rrc" ) 2>&1 | tee "$_ro"
        _rc=$(cat "$_rrc" 2>/dev/null || echo 1); rm -f "$_rrc"
    elif [ "$UI_TTY" = 1 ]; then
        "$@" >"$_ro" 2>&1 </dev/null &
        _rp=$!
        spin "$_rp" "$_rd"
        wait "$_rp"; _rc=$?
    else
        printf ' %s %s\n' "$S_RUN" "$_rd"
        "$@" >"$_ro" 2>&1 </dev/null; _rc=$?
    fi
    _rdt=$(($(date +%s) - _rt0))
    cat "$_ro" >>"$LOG_FILE" 2>/dev/null
    if [ "$_rc" -eq 0 ]; then
        printf ' %s%s%s %s %s(%s)%s\n' "$C_G" "$S_OK" "$C_0" "$_rd" "$C_GR" "$(fmt_dur "$_rdt")" "$C_0"
    else
        printf ' %s%s%s %s %s(exit code %s, %s)%s\n' "$C_R" "$S_ERR" "$C_0" "$_rd" "$C_GR" "$_rc" "$(fmt_dur "$_rdt")" "$C_0" >&2
        printf '   %slast lines of the output (full journal: %s):%s\n' "$C_GR" "$LOG_FILE" "$C_0" >&2
        tail -n 15 "$_ro" | sed 's/^/     | /' >&2
    fi
    rm -f "$_ro"
    return "$_rc"
}

# A check result: res ok|warn|fail "label" "detail"
R_OK=0; R_WARN=0; R_FAIL=0
res() {
    _rk=$1; _rl=$2; _rdet=${3:-}
    case "$_rk" in
        ok)   _ic="$C_G$S_OK$C_0"; _dc=$C_GR; R_OK=$((R_OK + 1)) ;;
        warn) _ic="$C_Y$S_WARN$C_0"; _dc=$C_Y; R_WARN=$((R_WARN + 1)) ;;
        *)    _ic="$C_R$S_ERR$C_0"; _dc=$C_R; R_FAIL=$((R_FAIL + 1)) ;;
    esac
    _pad=$((CHK_W - $(ulen "$_rl"))); [ "$_pad" -lt 1 ] && _pad=1
    printf '  %s  %s%s%s%s%s\n' "$_ic" "$_rl" "$(rep ' ' "$_pad")" "$_dc" "$_rdet" "$C_0"
    logf "CHECK $_rk | $_rl | $_rdet"
}
res_summary() {
    printf '\n'; rule
    printf '  Total: %s%s %s%s   %s%s %s%s   %s%s %s%s\n' "$C_G" "$S_OK" "$R_OK" "$C_0" "$C_Y" "$S_WARN" "$R_WARN" "$C_0" "$C_R" "$S_ERR" "$R_FAIL" "$C_0"
}

# ---------------------------------------------------------------- parameters

has_ctl() { case $1 in *"$NL"*|*"$CR"*) return 0 ;; esac; return 1; }
re_match() { has_ctl "$1" && return 1; printf '%s\n' "$1" | LC_ALL=C grep -Eq "$2"; }

v_domain() { re_match "$1" "$RE_DOMAIN" && [ "${#1}" -le 253 ]; }
v_domain_list() {
    re_match "$1" "$RE_DOMAIN_LIST" || return 1
    for _d in $1; do [ "${#_d}" -le 253 ] || return 1; done
    return 0
}
v_port() { re_match "$1" "$RE_PORT"; }
v_secret() { re_match "$1" "$RE_SECRET" && [ "${#1}" -le 8192 ]; }
v_user() { re_match "$1" "$RE_USER" && [ "$1" != root ] && [ "$1" != "$CERT_USER" ]; }
# A unicast address that can be the address of a server: not 0.x, not loopback, not multicast or above.
ip_usable() {
    _o1=${1%%.*}
    [ "$_o1" -ge 1 ] && [ "$_o1" -le 223 ] && [ "$_o1" -ne 127 ]
}
v_ipv4() { re_match "$1" "$RE_IPV4" && ip_usable "$1"; }
v_ips() {
    re_match "$1" "$RE_IPV4_LIST" || return 1
    for _i in $1; do ip_usable "$_i" || return 1; done
    return 0
}

# param_valid NAME VALUE: 0 if the value is acceptable for the parameter (an empty value is the caller's business).
param_valid() {
    _pv=$2
    case $1 in
        NODE_DOMAIN|RENAME_FROM) v_domain "$_pv" ;;
        RENAME_ALIAS) v_domain_list "$_pv" ;;
        NODE_IP) v_ipv4 "$_pv" ;;
        NODE_PORT|SSH_PORT) v_port "$_pv" ;;
        SECRET_KEY) v_secret "$_pv" ;;
        PANEL_ALLOW_IP) v_ips "$_pv" ;;
        CERTSYNC_PUBKEY|NEW_USER_PUBKEY|NEW_USER_PUBKEY2) re_match "$_pv" "$RE_PUBKEY" ;;
        NODE_IMAGE_TAG) re_match "$_pv" "$RE_TAG" ;;
        HAPROXY_VERSION) re_match "$_pv" "$RE_VERSION2" ;;
        FAIL2BAN_IGNORE_EXTRA) re_match "$_pv" "$RE_IPV4_CIDR_LIST" ;;
        NEW_USER) v_user "$_pv" ;;
        NEW_USER_PASSWORD) re_match "$_pv" "$RE_PASSWORD" ;;
        BASE_UPGRADE|SSH_DISABLE_ROOT|SSH_DISABLE_PASSWORD) case $_pv in yes|no) return 0 ;; esac; return 1 ;;
        DOCKER_SOURCE) case $_pv in apt|script) return 0 ;; esac; return 1 ;;
        HAPROXY_SOURCE) case $_pv in auto|ppa|distro) return 0 ;; esac; return 1 ;;
        SSH_PHASE) case $_pv in user|root|all) return 0 ;; esac; return 1 ;;
        INSTALL_MODE) case $_pv in new|redeploy) return 0 ;; esac; return 1 ;;
        SW_NONINTERACTIVE|SW_VERBOSE|SW_ASCII|SW_FORCE_COLOR) case $_pv in 0|1) return 0 ;; esac; return 1 ;;
        *) return 1 ;;
    esac
}

# What a valid value looks like. The value itself is never printed: it may be a secret.
param_hint() {
    case $1 in
        NODE_DOMAIN|RENAME_FROM) echo "a domain name such as node1.example.com (letters, digits, hyphens, dots)" ;;
        RENAME_ALIAS) echo "domain names separated by spaces" ;;
        NODE_IP) echo "a public IPv4 address such as 192.0.2.10" ;;
        NODE_PORT|SSH_PORT) echo "a TCP port from 1 to 65535" ;;
        SECRET_KEY) echo "the key from the panel (letters, digits and + / = _ . : -, 16 to 8192 characters)" ;;
        PANEL_ALLOW_IP) echo "IPv4 addresses separated by spaces (not 0.x, 127.x or 224 and above)" ;;
        CERTSYNC_PUBKEY|NEW_USER_PUBKEY|NEW_USER_PUBKEY2) echo "a public key: ssh-ed25519, ssh-rsa or ecdsa-sha2-nistp256/384/521, the key, an optional comment" ;;
        NODE_IMAGE_TAG) echo "a Docker image tag (letters, digits, _ . -, up to 128 characters)" ;;
        HAPROXY_VERSION) echo "a version such as 3.2 (major.minor)" ;;
        FAIL2BAN_IGNORE_EXTRA) echo "IPv4 addresses or CIDR ranges (prefix 8 to 32) separated by spaces" ;;
        NEW_USER) echo "a lower-case account name of up to 32 characters, not root and not $CERT_USER" ;;
        NEW_USER_PASSWORD) echo "8 to 128 printable ASCII characters" ;;
        BASE_UPGRADE|SSH_DISABLE_ROOT|SSH_DISABLE_PASSWORD) echo "yes or no" ;;
        DOCKER_SOURCE) echo "apt or script" ;;
        HAPROXY_SOURCE) echo "auto, ppa or distro" ;;
        SSH_PHASE) echo "user, root or all" ;;
        INSTALL_MODE) echo "new or redeploy" ;;
        SW_NONINTERACTIVE|SW_VERBOSE|SW_ASCII|SW_FORCE_COLOR) echo "0 or 1" ;;
        *) echo "a known parameter" ;;
    esac
}

is_param() { case " $PARAM_NAMES " in *" $1 "*) return 0 ;; esac; return 1; }

# Whitespace and case that do not change the meaning are normalised before validation.
param_normalize() {  # param_normalize NAME VALUE -> the normalised value on stdout
    case $1 in
        NODE_DOMAIN|RENAME_FROM) printf '%s' "$2" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' ;;
        RENAME_ALIAS) printf '%s' "$2" | tr '[:upper:]' '[:lower:]' | tr ',\t' '  ' | tr -s ' ' | sed 's/^ //; s/ $//' ;;
        PANEL_ALLOW_IP|FAIL2BAN_IGNORE_EXTRA) printf '%s' "$2" | tr ',\t' '  ' | tr -s ' ' | sed 's/^ //; s/ $//' ;;
        NODE_IP|NODE_PORT|SSH_PORT|NODE_IMAGE_TAG|HAPROXY_VERSION|NEW_USER) printf '%s' "$2" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' ;;
        CERTSYNC_PUBKEY|NEW_USER_PUBKEY|NEW_USER_PUBKEY2) printf '%s' "$2" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' ;;
        *) printf '%s' "$2" ;;
    esac
}

# set_param_if_empty NAME VALUE: used for the environment file and the saved configuration, which never beat a value that was given.
set_param_if_empty() {
    eval "_cur=\${$1:-}"
    [ -n "$_cur" ] || eval "$1=\$2"
}

# Reads NAME=value lines. Nothing in the file is executed: a line is split at the first =, the name must be a known
# parameter, one pair of matching quotes around the value is removed. strict: an unknown name stops the run (an env file);
# otherwise it is skipped (the saved configuration of a newer or older installer).
load_params_file() {  # load_params_file FILE strict|lenient
    _lf=$1; _lm=$2
    [ -f "$_lf" ] || die "Parameter file not found: $_lf"
    while IFS= read -r _l || [ -n "$_l" ]; do
        _l=$(printf '%s' "$_l" | sed 's/\r$//; s/^[[:space:]]*//')
        case $_l in ''|'#'*) continue ;; esac
        _l=${_l#export }
        case $_l in *=*) ;; *) [ "$_lm" = strict ] && die "Parameter file $_lf: a line without ="; continue ;; esac
        _k=${_l%%=*}
        _v=${_l#*=}
        if ! is_param "$_k"; then
            [ "$_lm" = strict ] && die "Parameter file $_lf: unknown parameter $_k"
            continue
        fi
        case $_v in
            \"*\") _v=${_v#\"}; _v=${_v%\"} ;;
            \'*\') _v=${_v#\'}; _v=${_v%\'} ;;
        esac
        set_param_if_empty "$_k" "$_v"
    done <"$_lf"
}

# The environment file must not be readable or writable by others: it can hold the node secret and a password.
check_env_file() {
    [ -f "$1" ] || die "Parameter file not found: $1"
    _em=$(stat -c '%a' "$1" 2>/dev/null) || die "Cannot read the mode of $1"
    case $_em in 600|400|0600|0400) ;; *) die "$1 must have mode 600 (it is $_em): it may hold secrets" ;; esac
    _eo=$(stat -c '%u' "$1" 2>/dev/null)
    [ "$_eo" = "$(id -u)" ] || die "$1 must be owned by the user running the installer"
}

param_check() {
    eval "_pc=\${$1:-}"
    [ -z "$_pc" ] && return 0
    param_valid "$1" "$_pc" || die "Invalid value for $1: expected $(param_hint "$1")"
}

# Normalise, then validate, every parameter that has a value. Called once before any step.
validate_params() {
    for _p in $PARAM_NAMES SW_NONINTERACTIVE SW_VERBOSE SW_ASCII; do
        eval "_pv0=\${$_p:-}"
        [ -n "$_pv0" ] || continue
        case $_p in SW_*) ;; *) _pv1=$(param_normalize "$_p" "$_pv0"); eval "$_p=\$_pv1" ;; esac
        param_check "$_p"
    done
}

# Defaults come last: the environment, the env file and the saved configuration all beat them.
apply_defaults() {
    : "${BASE_UPGRADE:=yes}" "${DOCKER_SOURCE:=apt}" "${HAPROXY_SOURCE:=auto}" "${HAPROXY_VERSION:=$DEFAULT_HAPROXY_VERSION}"
    : "${NODE_IMAGE_TAG:=$DEFAULT_NODE_IMAGE_TAG}" "${SSH_PHASE:=all}" "${SSH_DISABLE_ROOT:=yes}" "${SSH_DISABLE_PASSWORD:=no}"
    : "${INSTALL_MODE:=new}" "${NODE_PORT:=$DEFAULT_NODE_PORT}"
}

conf_get() { sed -n "s/^$1='\\(.*\\)'\$/\\1/p" "$CONF_FILE" 2>/dev/null | head -n1; }

save_conf() {
    (
        umask 077
        {
            echo "# swellwright node installer: saved parameters (the node secret is kept only in the compose file)"
            for _v in $SAVED_PARAMS; do
                eval "_x=\${$_v:-}"
                [ -n "$_x" ] && printf "%s='%s'\\n" "$_v" "$_x"
            done
            :
        } >"$CONF_FILE"
    ) || warn "Could not write $CONF_FILE"
    return 0
}

# ---------------------------------------------------------------- input

# Interactive input comes from the terminal through two descriptors opened once: 3 for answers, 4 for prompts.
NONINTERACTIVE=0

is_asked() { case " $ASKED " in *" $1 "*) return 0 ;; esac; return 1; }
prompt_q() { printf ' %s?%s %s' "$C_C$C_B" "$C_0" "$*" >&4; }
tty_say() { [ "$NONINTERACTIVE" = 1 ] && return 0; printf "$@" >&4; }

# ask NAME "prompt" [default] [optional]: a value that is already set is validated and used (with a terminal it is
# offered once as the default); without a terminal a missing value without a default stops the run, unless the
# value is optional. An optional value may be answered with nothing.
ask() {
    _an=$1; _ap=$2; _ad=${3:-}; _ao=${4:-}
    eval "_ac=\${$_an:-}"
    if [ -n "$_ac" ]; then
        if [ "$NONINTERACTIVE" = 1 ] || is_asked "$_an"; then param_check "$_an"; return 0; fi
        _ad=$_ac
    elif [ "$NONINTERACTIVE" = 1 ]; then
        if [ -n "$_ad" ]; then
            eval "$_an=\$_ad"
            param_check "$_an"
            return 0
        fi
        [ -n "$_ao" ] && return 0
        die "$_an is required: set it in the environment or in the --env-file file"
    fi
    while :; do
        if [ -n "$_ad" ]; then
            printf ' %s?%s %s %s[%s]%s: ' "$C_C$C_B" "$C_0" "$_ap" "$C_GR" "$_ad" "$C_0" >&4
        elif [ -n "$_ao" ]; then
            printf ' %s?%s %s %s(Enter: skip)%s: ' "$C_C$C_B" "$C_0" "$_ap" "$C_GR" "$C_0" >&4
        else
            printf ' %s?%s %s: ' "$C_C$C_B" "$C_0" "$_ap" >&4
        fi
        IFS= read -r _a <&3 || die "No input for $_an"
        [ -n "$_a" ] || _a=$_ad
        if [ -z "$_a" ]; then
            [ -n "$_ao" ] && { ASKED="$ASKED $_an"; return 0; }
            warn "A value is required"
            continue
        fi
        _a=$(param_normalize "$_an" "$_a")
        if ! param_valid "$_an" "$_a"; then warn "Not valid: expected $(param_hint "$_an")"; continue; fi
        break
    done
    eval "$_an=\$_a"
    ASKED="$ASKED $_an"
}

# confirm "question" [default y|n]: asks with a terminal; without one it answers with the default.
confirm() {
    _p=$1; _d=${2:-y}
    [ "$NONINTERACTIVE" = 1 ] && { [ "$_d" = y ]; return; }
    if [ "$_d" = y ]; then
        printf ' %s?%s %s %s[Y/n]%s: ' "$C_C$C_B" "$C_0" "$_p" "$C_GR" "$C_0" >&4
    else
        printf ' %s?%s %s %s[y/N]%s: ' "$C_C$C_B" "$C_0" "$_p" "$C_GR" "$C_0" >&4
    fi
    IFS= read -r _a <&3 || _a=
    [ -n "$_a" ] || _a=$_d
    case "$_a" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

ask_domain() { ask NODE_DOMAIN "Node domain (SNI, host name, SelfSNI), for example node1.example.com"; }

# IPv4 addresses of the interfaces (global scope), one per line.
local_ips() { ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4}'; }

ask_node_ip() {
    if [ -n "${NODE_IP:-}" ] && { is_asked NODE_IP || [ "$NONINTERACTIVE" = 1 ]; }; then return 0; fi
    ask_domain
    _ips=$(local_ips)
    _dns=$(getent ahostsv4 "$NODE_DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
    _def=
    if [ -n "$_dns" ] && printf '%s\n' "$_ips" | grep -qx "$_dns"; then _def=$_dns; fi
    [ -n "$_def" ] || _def=$(printf '%s\n' "$_ips" | head -n1)
    if [ "$NONINTERACTIVE" = 1 ] && [ -z "${NODE_IP:-}" ]; then
        # No terminal: guess only when the guess cannot be wrong (one address on the server, or the A record names one of them).
        _unamb=0
        [ "$(printf '%s\n' "$_ips" | grep -c .)" -eq 1 ] && _unamb=1
        [ -n "$_dns" ] && printf '%s\n' "$_ips" | grep -qx "$_dns" && _unamb=1
        [ "$_unamb" = 1 ] || die "NODE_IP is required: the server has no single public IPv4 address to choose"
    fi
    tty_say '   %sIPv4 addresses of the interfaces:%s %s\n' "$C_GR" "$C_0" "$(printf '%s ' $_ips)"
    if [ -n "$_dns" ]; then
        tty_say '   %sA record %s ->%s %s\n' "$C_GR" "$NODE_DOMAIN" "$C_0" "$_dns"
        printf '%s\n' "$_ips" | grep -qx "$_dns" || warn "The A record of the domain matches no address of this server"
    else
        warn "Could not resolve $NODE_DOMAIN"
    fi
    [ -n "${NODE_IP:-}" ] || NODE_IP=$_def
    param_check NODE_IP
    ask NODE_IP "Public IPv4 address for HAProxy (bind :443)" "$_def"
    check_dns_a
}

# The A record of the domain must point at NODE_IP: clients, HAProxy (by SNI) and whatever delivers certificates use the name.
check_dns_a() {
    [ -n "${NODE_DOMAIN:-}" ] && [ -n "${NODE_IP:-}" ] || return 0
    _dns=$(getent ahostsv4 "$NODE_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
    case " $_dns " in
        *" $NODE_IP "*) ok "DNS: $NODE_DOMAIN -> $NODE_IP (the A record is right)"; return 0 ;;
    esac
    warn "The A record of $NODE_DOMAIN points to: ${_dns:-<no record>}; this node is $NODE_IP"
    cat <<EOF

   ${C_Y}Add or change the A record in the DNS zone of the domain:${C_0}
       ${C_W}$NODE_DOMAIN.   A   $NODE_IP${C_0}      (TTL 300)
   If the server was replaced, delete the old A record with the old address.
   ${C_GR}Check after the DNS update:  getent ahostsv4 $NODE_DOMAIN${C_0}

EOF
    confirm "Continue without a correct A record?" y || die "Stopped: fix the A record and run the step again"
}

ask_node_port() { ask NODE_PORT "Node API port (panel to node)" "$DEFAULT_NODE_PORT"; }

ask_panel_ip() {
    ask PANEL_ALLOW_IP "Address of the panel for the node API port (several: separated by spaces)"
}

ask_ssh_port() {
    _d=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}')
    ask SSH_PORT "SSH port to keep open in the firewall" "${_d:-22}"
}

# The certificate receiver is optional in `full` (an empty answer skips it) and required by the certsync step itself.
ask_certsync_pubkey() {  # ask_certsync_pubkey [optional]
    ask CERTSYNC_PUBKEY "Public key of the certificate sender (ssh-ed25519 AAAA... comment)" "" "${1:-}"
}

current_secret() {
    [ -f "$R$NODE_DIR/docker-compose.yml" ] || return 0
    sed -n 's/^[[:space:]]*-[[:space:]]*SECRET_KEY=//p' "$R$NODE_DIR/docker-compose.yml" | head -n1 | sed 's/^"//; s/"$//'
}

# The node secret is read without echo, or taken from the existing compose file (Enter), or from SECRET_KEY.
ask_secret() {
    if [ -n "${SECRET_KEY:-}" ] && { is_asked SECRET_KEY || [ "$NONINTERACTIVE" = 1 ]; }; then return 0; fi
    _cur=$(current_secret)
    if [ "$NONINTERACTIVE" = 1 ]; then
        [ -n "$_cur" ] || die "SECRET_KEY is required: set it in the environment or in the --env-file file"
        SECRET_KEY=$_cur
        param_check SECRET_KEY
        return 0
    fi
    while :; do
        if [ -n "$_cur" ]; then
            prompt_q "SECRET_KEY from the panel (Enter keeps the current one): "
        else
            prompt_q "SECRET_KEY from the panel (the node's compose file): "
        fi
        stty -echo <&3 2>/dev/null
        IFS= read -r _a <&3 || _a=
        stty echo <&3 2>/dev/null
        printf '\n' >&4
        _a=$(printf '%s' "$_a" | sed 's/^[[:space:]]*-\{0,1\}[[:space:]]*//; s/^SECRET_KEY=//; s/^"//; s/"$//')
        [ -n "$_a" ] || _a=$_cur
        if [ -z "$_a" ]; then warn "SECRET_KEY is required"; continue; fi
        if ! param_valid SECRET_KEY "$_a"; then warn "Not valid: expected $(param_hint SECRET_KEY)"; continue; fi
        break
    done
    SECRET_KEY=$_a
    ASKED="$ASKED SECRET_KEY"
}

# ---------------------------------------------------------------- files and packages

backup_file() { [ -f "$1" ] && cp -a "$1" "$1.bak.$(date +%Y%m%d%H%M%S)"; return 0; }

# write_file PATH [MODE] < content: writes only when the content changes, keeps a backup of the old file.
write_file() {
    _dst=$1; _mode=${2:-644}
    _tmp=$(mktemp) || die "mktemp failed"
    cat >"$_tmp"
    if [ -f "$_dst" ] && cmp -s "$_tmp" "$_dst"; then
        rm -f "$_tmp"
        note "unchanged: ${_dst#"$R"}"
        return 0
    fi
    backup_file "$_dst"
    mkdir -p "$(dirname "$_dst")"
    install -m "$_mode" "$_tmp" "$_dst" || die "Could not write ${_dst#"$R"}"
    rm -f "$_tmp"
    ok "written: ${_dst#"$R"}"
}

# make_dir MODE OWNER PATH (OWNER is user:group or empty)
make_dir() {
    mkdir -p "$3" || die "Could not create ${3#"$R"}"
    chmod "$1" "$3" || die "Could not set the mode of ${3#"$R"}"
    [ -z "$2" ] || chown "$2" "$3" || die "Could not change the owner of ${3#"$R"}"
}

# The backups are named file.bak.YYYYMMDDHHMMSS, so the last name is the newest (the time stamps of the files themselves are those of the originals).
restore_newest_backup() { _b=$(ls -1 "$1".bak.* 2>/dev/null | sort | tail -n 1); [ -n "$_b" ] && cp -a "$_b" "$1"; return 0; }

# A fresh Ubuntu starts unattended-upgrades and holds the dpkg lock for a while: wait (up to 15 minutes), do not fail with
# "Could not get lock". apt itself also waits (DPkg::Lock::Timeout). Not every process called unattended-upgr* is a run:
# the watcher of the same package (unattended-upgrade-shutdown, started by unattended-upgrades.service) runs for as long
# as the machine is up and holds no lock, so a run is told apart by its command line and not by the name of its process.
apt_wait() {
    _aw=0
    while pgrep -x apt >/dev/null 2>&1 || pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1 \
        || pgrep -f '/usr/bin/unattended-upgrade( |$)' >/dev/null 2>&1 \
        || pgrep -x packagekitd >/dev/null 2>&1 || pgrep -f apt.systemd.daily >/dev/null 2>&1; do
        [ "$_aw" -eq 0 ] && echo "waiting for another apt or dpkg process (usually unattended-upgrades) to release the lock ..."
        if [ "$_aw" -ge "${APT_WAIT_MAX:-900}" ]; then echo "the dpkg lock was not released in $_aw s, going on"; return 0; fi
        sleep "${APT_WAIT_STEP:-5}"; _aw=$((_aw + ${APT_WAIT_STEP:-5}))
    done
    [ "$_aw" -gt 0 ] && echo "the lock was released after $_aw s"
    return 0
}
apt_get() { apt_wait; apt-get -o DPkg::Lock::Timeout=600 "$@"; }
apt_run() { apt_wait; "$@"; }

apt_install() { run_cmd "Installing packages: $*" apt_get install -y -o Dpkg::Options::=--force-confold "$@" || die "Could not install: $*"; }

# After a kernel update (the base step) the server needs a reboot.
reboot_hint() {
    if [ -f "$R/var/run/reboot-required" ]; then
        warn "A reboot is needed (a kernel update is installed; running kernel: $(uname -r)). Reboot after the installation and check:"
        warn "docker ps, systemctl is-active haproxy nginx fail2ban sw-node-api-acl, and that the node is online in the panel."
    fi
}

# gpg_has_fpr FILE "FPR1 FPR2": 0 when the primary key of some OpenPGP key in FILE has one of the fingerprints.
gpg_has_fpr() {
    _gf=$(gpg --show-keys --with-colons "$1" 2>/dev/null | awk -F: '$1=="pub"{p=1;next} p&&$1=="fpr"{print $10;p=0}')
    for _w in $2; do
        printf '%s\n' "$_gf" | grep -qx "$_w" && return 0
    done
    return 1
}

# fetch_key URL DEST "FPRS" armored|binary: downloads a signing key to a temporary file, accepts it only if it carries a pinned
# fingerprint, then installs it at DEST (armored: as is; binary: dearmored). https first, then http: the fingerprint makes
# the transport irrelevant.
fetch_key() {
    _fu=$1; _fd=$2; _ff=$3; _fm=$4
    _kt=$(mktemp) || return 1
    for _try in "$_fu" "http://${_fu#https://}"; do
        : >"$_kt"
        if curl -fsS --connect-timeout 10 -m 40 -o "$_kt" "$_try" && gpg_has_fpr "$_kt" "$_ff"; then
            mkdir -p "$(dirname "$_fd")"
            if [ "$_fm" = binary ]; then
                gpg --dearmor --yes -o "$_fd" "$_kt" || { rm -f "$_kt"; return 1; }
            else
                cp "$_kt" "$_fd" || { rm -f "$_kt"; return 1; }
            fi
            chmod 644 "$_fd"
            rm -f "$_kt"
            return 0
        fi
        echo "signing key: the attempt with $_try failed or the key has no expected fingerprint" >&2
        sleep 3
    done
    rm -f "$_kt"
    return 1
}

# ---------------------------------------------------------------- preflight

# net_check LABEL URL: reachable means that some HTTP answer came back.
net_check() {
    _nc=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null)
    case "$_nc" in ''|000) res warn "$1" "$2 is not reachable" ;; *) res ok "$1" "$2 answers" ;; esac
}

step_preflight() {
    title "Preflight checks"
    R_OK=0; R_WARN=0; R_FAIL=0
    case "${ID:-}:${VERSION_ID:-}" in
        ubuntu:22.04|ubuntu:24.04|debian:12) res ok "Operating system" "${PRETTY_NAME:-$ID}" ;;
        *) res warn "Operating system" "${PRETTY_NAME:-unknown}: written for Debian 12 and Ubuntu 22.04 / 24.04" ;;
    esac
    if command -v apt-get >/dev/null 2>&1; then res ok "Package manager" "apt"; else res fail "Package manager" "apt-get not found: only Debian and Ubuntu are supported"; fi
    case "$(uname -m)" in
        x86_64|aarch64) res ok "Architecture" "$(uname -m)" ;;
        *) res warn "Architecture" "$(uname -m): the node image may not exist for it" ;;
    esac
    _mem=$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
    if [ "${_mem:-0}" -ge 900 ]; then res ok "Memory" "${_mem} MB, CPUs: $(nproc 2>/dev/null)"; else res warn "Memory" "${_mem:-?} MB (1 GB or more is recommended)"; fi
    _free=$(df -Pm / 2>/dev/null | awk 'NR==2{print $4}')
    if [ "${_free:-0}" -ge 3000 ]; then res ok "Free space on /" "${_free} MB"; else res warn "Free space on /" "${_free:-?} MB (3 GB or more is recommended)"; fi
    if [ "${DOCKER_SOURCE:-apt}" = script ]; then net_check "Internet: Docker" "https://get.docker.com"; else net_check "Internet: Docker" "https://download.docker.com/linux/ubuntu/gpg"; fi
    net_check "Internet: nginx repository" "https://nginx.org/keys/nginx_signing.key"
    if [ "$(haproxy_source)" = ppa ]; then net_check "Internet: HAProxy PPA" "https://ppa.launchpadcontent.net/vbernat/haproxy-${HAPROXY_VERSION:-$DEFAULT_HAPROXY_VERSION}/ubuntu/"; fi
    if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then res ok "Time synchronisation" "NTP works"; else res warn "Time synchronisation" "not synchronised (REALITY tolerates a skew of 60 s); the system step sets up NTP"; fi
    _busy=$(ss -tlnp 2>/dev/null | awk 'NR>1 && $4 ~ /:(80|443)$/ {print $4 " " $6}' | grep -Ev 'nginx|haproxy|docker-proxy' | head -n2 | tr '\n' ';')
    if [ -z "$_busy" ]; then res ok "Ports 80 and 443" "free, or held by the components of the node"; else res warn "Ports 80 and 443" "in use: $_busy"; fi
    if [ -f "$R/var/run/reboot-required" ]; then res warn "Pending reboot" "required (a kernel update is already installed)"; else res ok "Pending reboot" "none"; fi
    res_summary
    [ "$R_FAIL" -eq 0 ] || return 2
    return 0
}

# ---------------------------------------------------------------- steps

step_base() {
    title "Base packages and system upgrade"
    run_cmd "Updating the package lists" apt_get update || die "apt-get update failed"
    if [ "$BASE_UPGRADE" = yes ]; then
        run_cmd "Upgrading the installed packages (apt upgrade)" apt_get -y -o Dpkg::Options::=--force-confold upgrade || die "apt-get upgrade failed"
    else
        note "BASE_UPGRADE=no: the installed packages are not upgraded"
    fi
    apt_install curl ca-certificates gnupg rsync openssl ufw iproute2 procps
}

# BBR and a network profile, a journal size limit, NTP with fallback servers. fq takes effect for interfaces after a reboot;
# bbr applies to new connections at once.
step_system() {
    title "System tuning: sysctl (BBR), journald, NTP"
    mkdir -p "$R/etc/systemd/journald.conf.d" "$R/etc/systemd/timesyncd.conf.d" "$R/etc/modules-load.d" "$R/etc/sysctl.d"
    printf '[Journal]\nSystemMaxUse=200M\nMaxRetentionSec=1month\n' | write_file "$R/etc/systemd/journald.conf.d/99-sw.conf"
    q systemctl restart systemd-journald
    q journalctl --vacuum-size=200M
    # The Ubuntu NTP server is unreachable from some networks (UDP 123 filtered), so there are fallback servers.
    printf '[Time]\nNTP=time.cloudflare.com 0.pool.ntp.org 1.pool.ntp.org 2.pool.ntp.org\nFallbackNTP=ntp.ubuntu.com\n' \
        | write_file "$R/etc/systemd/timesyncd.conf.d/99-sw.conf"
    q systemctl restart systemd-timesyncd
    echo tcp_bbr | write_file "$R/etc/modules-load.d/sw-bbr.conf"
    q modprobe tcp_bbr
    write_file "$R/etc/sysctl.d/99-sw-net.conf" <<'EOF'
# Network profile of a Remnawave node. Server-side TCP Fast Open is deliberately not enabled.
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_max_syn_backlog = 4096
EOF
    q sysctl -q -p "$R/etc/sysctl.d/99-sw-net.conf"
    kv "TCP congestion control" "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)"
    kv "Queue discipline" "$(sysctl -n net.core.default_qdisc 2>/dev/null) (interfaces after a reboot)"
    kv "NTP synchronised" "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"
}

# fail2ban for SSH: a node sees tens of thousands of failed logins a day. Loopback, the panel and the extra list are never banned.
step_fail2ban() {
    title "fail2ban for SSH"
    ask_ssh_port; save_conf
    if ! command -v fail2ban-client >/dev/null 2>&1; then
        apt_install fail2ban python3-systemd
    elif ! python3 -c 'import systemd.journal' >/dev/null 2>&1; then
        apt_install python3-systemd
    fi
    _ign="127.0.0.1/8 ::1"
    [ -z "${PANEL_ALLOW_IP:-}" ] || _ign="$_ign $PANEL_ALLOW_IP"
    [ -z "${FAIL2BAN_IGNORE_EXTRA:-}" ] || _ign="$_ign $FAIL2BAN_IGNORE_EXTRA"
    write_file "$R/etc/fail2ban/jail.d/sw-sshd.local" <<EOF
[DEFAULT]
ignoreip = $_ign
bantime = 1h
findtime = 10m
maxretry = 5
backend = systemd

[sshd]
enabled = true
port = $SSH_PORT
EOF
    q systemctl enable fail2ban
    systemctl restart fail2ban || die "fail2ban did not start"
    sleep 2
    fail2ban-client status sshd 2>&1 | head -n 8 | dimcat
}

step_hostname() {
    title "Host name and /etc/hosts"
    ask_domain; ask_node_ip; save_conf
    hostnamectl set-hostname "$NODE_DOMAIN" || die "hostnamectl failed"
    _short=${NODE_DOMAIN%%.*}
    # Is there already a line of this address that names the domain (a comment ends the names)?
    if awk -v ip="$NODE_IP" -v d="$NODE_DOMAIN" '$1 == ip { for (i = 2; i <= NF; i++) { if ($i ~ /^#/) break; if ($i == d) f = 1 } } END { exit !f }' "$R/etc/hosts" 2>/dev/null; then
        note "/etc/hosts already has $NODE_IP $NODE_DOMAIN"
    else
        backup_file "$R/etc/hosts"
        printf '%s %s %s\n' "$NODE_IP" "$NODE_DOMAIN" "$_short" >>"$R/etc/hosts"
        ok "added to /etc/hosts: $NODE_IP $NODE_DOMAIN $_short"
    fi
    kv "hostname" "$(hostname)"
    kv "hostname -f" "$(hostname -f 2>/dev/null)"
}

# UFW: SSH first, so that enabling the firewall cannot cut the session. The node API port is opened for the panel only.
step_firewall() {
    title "Firewall (UFW)"
    ask_ssh_port; ask_node_port; ask_panel_ip; save_conf
    command -v ufw >/dev/null 2>&1 || apt_install ufw
    q ufw allow "$SSH_PORT/tcp"
    # The port of the SSH session that runs this installer is kept open too, whatever SSH_PORT says.
    _sp=${SSH_CONNECTION:-}; _sp=${_sp##* }
    if v_port "$_sp" && [ "$_sp" != "$SSH_PORT" ]; then
        warn "This session uses SSH port $_sp, not $SSH_PORT: keeping $_sp open as well"
        q ufw allow "$_sp/tcp"
    fi
    q ufw allow 80/tcp
    q ufw allow 443/tcp
    # The node API port only for the panel: an older rule that opened it to everyone is removed.
    q ufw delete allow "$NODE_PORT/tcp"
    for _ip in $PANEL_ALLOW_IP; do
        q ufw allow from "$_ip" to any port "$NODE_PORT" proto tcp
    done
    q ufw --force enable || die "UFW could not be enabled (see the journal $LOG_FILE)"
    ok "UFW is on: SSH $SSH_PORT, 80, 443, node API port $NODE_PORT only for $PANEL_ALLOW_IP"
    ufw status | sed -n '1,14p' | dimcat
    warn "UFW does not close a port that Docker publishes: the step for the node API port adds the DOCKER-USER chain rules"
}

# Docker publishes the node port with DNAT, around UFW. The rules in DOCKER-USER: the allowed sources RETURN, everything else
# is dropped. Both --ctorigdstport (the port before DNAT) and --ctdir ORIGINAL are needed, or reply packets are dropped too.
# A unit applies them after docker.service. When the panel's address changes, run this step again with the new PANEL_ALLOW_IP.
step_apiacl() {
    title "Node API port open to the panel only (DOCKER-USER and UFW)"
    command -v docker >/dev/null 2>&1 || die "Docker is not installed: run the docker step first"
    ask_node_port; ask_panel_ip; save_conf

    printf 'ALLOW_SRC="%s"\nNODE_PORT=%s\n' "$PANEL_ALLOW_IP" "$NODE_PORT" | write_file "$R$API_ACL_CONF" 644

    write_file "$R$API_ACL_BIN" 755 <<'EOF'
#!/bin/sh
# Applies or removes the restriction of the node API port in the DOCKER-USER chain.
# Written by the Swellwright node installer; its settings are in /etc/sw-node-api-allow.conf.
CONF=/etc/sw-node-api-allow.conf
[ -r "$CONF" ] || { echo "cannot read $CONF" >&2; exit 1; }
. "$CONF"
del_old() {
  iptables -S DOCKER-USER 2>/dev/null | grep -- "--ctorigdstport ${NODE_PORT} " | sed 's/^-A /-D /' | while read -r r; do iptables $r; done
}
case "${1:-apply}" in
  apply)
    iptables -N DOCKER-USER 2>/dev/null
    del_old
    # Order: the allowed sources first (RETURN: Docker's own rules go on), then DROP for everybody else.
    pos=1
    for ip in $ALLOW_SRC; do
      iptables -I DOCKER-USER $pos -p tcp -m conntrack --ctorigdstport "$NODE_PORT" --ctdir ORIGINAL -s "$ip" -j RETURN
      pos=$((pos+1))
    done
    iptables -I DOCKER-USER $pos -p tcp -m conntrack --ctorigdstport "$NODE_PORT" --ctdir ORIGINAL -j DROP
    ;;
  remove) del_old ;;
  status) iptables -S DOCKER-USER ;;
  *) echo "usage: $0 apply|remove|status"; exit 2 ;;
esac
EOF

    write_file "$R$API_ACL_UNIT" 644 <<'EOF'
[Unit]
Description=Restrict the Remnawave node API port to the panel (DOCKER-USER)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/sw-node-api-acl.sh apply

[Install]
WantedBy=multi-user.target
EOF
    q systemctl daemon-reload
    q systemctl enable sw-node-api-acl.service
    systemctl restart sw-node-api-acl.service || die "sw-node-api-acl.service did not start"
    "$R$API_ACL_BIN" status 2>/dev/null | grep -- "--ctorigdstport $NODE_PORT " | dimcat

    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
        q ufw delete allow "$NODE_PORT/tcp"
        for _ip in $PANEL_ALLOW_IP; do
            q ufw allow from "$_ip" to any port "$NODE_PORT" proto tcp
        done
        ufw status | grep "$NODE_PORT" | dimcat
    fi
    warn "If the external address of the panel changes it loses the node (users keep working): run this step again with the new PANEL_ALLOW_IP"
}

# Docker's own apt repository. The signing key is accepted only with the pinned fingerprint.
docker_apt_repo() {
    case "${ID:-}" in ubuntu|debian) ;; *) die "Docker's apt repository is set up for Debian and Ubuntu only (this is ${ID:-unknown})" ;; esac
    _cn=${VERSION_CODENAME:-}
    [ "${ID:-}" = ubuntu ] && _cn=${UBUNTU_CODENAME:-$_cn}
    [ -n "$_cn" ] || die "Cannot tell the release name from /etc/os-release"
    run_cmd "Fetching Docker's signing key (fingerprint is checked)" fetch_key "https://download.docker.com/linux/$ID/gpg" "$R/etc/apt/keyrings/docker.asc" "$DOCKER_KEY_FPRS" armored \
        || die "Could not get Docker's signing key with the expected fingerprint"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $_cn stable" \
        | write_file "$R/etc/apt/sources.list.d/docker.list"
    run_cmd "Updating the package lists (Docker repository)" apt_get update || die "apt-get update failed"
}

step_docker() {
    title "Docker"
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        ok "Docker is already installed: $(docker --version)"
    elif command -v docker >/dev/null 2>&1; then
        die "Docker is installed without the compose plugin: install docker-compose-plugin (or remove the old Docker package) and run the step again"
    elif [ "$DOCKER_SOURCE" = script ]; then
        _dk=$(mktemp) || die "mktemp failed"
        run_cmd "Downloading the Docker convenience script" curl -fsSL -o "$_dk" https://get.docker.com || { rm -f "$_dk"; die "Could not download get.docker.com"; }
        run_cmd "Installing Docker (get.docker.com script)" apt_run sh "$_dk" || { rm -f "$_dk"; die "Docker installation failed"; }
        rm -f "$_dk"
    else
        docker_apt_repo
        apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    fi
    systemctl enable --now docker || die "docker did not start"
    kv "Docker" "$(docker --version)"
    kv "Docker Compose" "$(docker compose version)"
}

# A temporary self-signed certificate keeps nginx able to start until the real one is delivered to CERT_DIR.
ensure_cert() {
    if [ -s "$R$CERT_DIR/$CERT_FILE" ] && [ -s "$R$CERT_DIR/$KEY_FILE" ]; then return 0; fi
    ask_domain
    warn "There is no certificate in $CERT_DIR yet: creating a temporary self-signed one (it is replaced when the real one is delivered)"
    mkdir -p "$R$CERT_DIR"
    openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 30 \
        -subj "/CN=$NODE_DOMAIN" -keyout "$R$CERT_DIR/$KEY_FILE" -out "$R$CERT_DIR/$CERT_FILE" >/dev/null 2>&1 \
        || die "Could not create the temporary certificate"
    if id "$CERT_USER" >/dev/null 2>&1; then chown "$CERT_USER:" "$R$CERT_DIR/$CERT_FILE" "$R$CERT_DIR/$KEY_FILE"; fi
    # Only the root process of nginx (the master) reads the key; the sender keeps the same mode (rsync --chmod=D755,F640).
    chmod 640 "$R$CERT_DIR/$KEY_FILE"
}

# The receiving end of certificate delivery: a user who can only write into CERT_DIR, through rrsync, with a restricted key.
step_certsync() {
    title "Certificate receiver (restricted rsync key)"
    ask_domain; ask_certsync_pubkey; save_conf
    command -v rsync >/dev/null 2>&1 || apt_install rsync
    command -v rrsync >/dev/null 2>&1 || die "rrsync not found (expected /usr/bin/rrsync from the rsync package)"

    id "$CERT_USER" >/dev/null 2>&1 || useradd -r -m -s /bin/bash "$CERT_USER" || die "useradd $CERT_USER failed"
    _home=$(getent passwd "$CERT_USER" | cut -d: -f6)
    [ -n "$_home" ] || die "Cannot find the home directory of $CERT_USER"
    make_dir 755 "$CERT_USER:" "$R$CERT_DIR"
    make_dir 700 "$CERT_USER:" "$_home/.ssh"
    printf 'command="rrsync %s/",restrict %s\n' "$CERT_DIR" "$CERTSYNC_PUBKEY" \
        | write_file "$_home/.ssh/authorized_keys" 600
    chown "$CERT_USER:" "$_home/.ssh/authorized_keys"

    ensure_cert
    [ -f "$R$CERT_DIR/$KEY_FILE" ] && chmod 640 "$R$CERT_DIR/$KEY_FILE"
    log "Deliver the certificate of $NODE_DOMAIN (files $CERT_FILE and $KEY_FILE) to $CERT_DIR over SSH as $CERT_USER with the private key of the public key you gave"
    warn "The sender connects to this node by the name $NODE_DOMAIN: its A record must point to this server"
}

step_nginx() {
    title "nginx (nginx.org): SelfSNI site and default site"
    ask_domain; save_conf

    _nid=${ID:-}
    case "$_nid" in ubuntu|debian) ;; *) die "The nginx.org repository is set up for Debian and Ubuntu only (this is ${_nid:-unknown})" ;; esac
    _ncn=${VERSION_CODENAME:-}
    [ "$_nid" = ubuntu ] && _ncn=${UBUNTU_CODENAME:-$_ncn}
    [ -n "$_ncn" ] || die "Cannot tell the release name from /etc/os-release"
    _ngx_new=0
    if ! gpg_has_fpr "$R/usr/share/keyrings/nginx-archive-keyring.gpg" "$NGINX_KEY_FPRS"; then
        run_cmd "Fetching the nginx.org signing key (fingerprint is checked)" fetch_key https://nginx.org/keys/nginx_signing.key "$R/usr/share/keyrings/nginx-archive-keyring.gpg" "$NGINX_KEY_FPRS" binary \
            || die "Could not get the nginx.org signing key with an expected fingerprint (check: curl -fsSI https://nginx.org/keys/nginx_signing.key; journal: $LOG_FILE)"
        _ngx_new=1
    fi
    if [ ! -f "$R/etc/apt/sources.list.d/nginx.list" ]; then
        echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/$_nid $_ncn nginx" \
            | write_file "$R/etc/apt/sources.list.d/nginx.list"
        printf 'Package: *\nPin: origin nginx.org\nPin-Priority: 900\n\n' | write_file "$R/etc/apt/preferences.d/99nginx"
        _ngx_new=1
    fi
    if [ "$_ngx_new" = 1 ]; then
        run_cmd "Updating the package lists (nginx.org)" apt_get update || die "apt-get update failed"
    fi
    apt_install nginx
    kv "nginx" "$(nginx -v 2>&1)"

    ensure_cert

    write_file "$R/etc/nginx/conf.d/default.conf" <<EOF
server {
    listen 80;
    server_name $NODE_DOMAIN;
    return 301 https://\$host\$request_uri;
}
EOF

    write_file "$R/etc/nginx/conf.d/selfsni.conf" <<EOF
# SelfSNI: the REALITY fallback over a unix socket. xver=1 means PROXY protocol.
server {
    listen unix:$NGINX_SOCK ssl proxy_protocol;
    http2 on;
    server_name $NODE_DOMAIN;

    ssl_certificate     $CERT_DIR/$CERT_FILE;
    ssl_certificate_key $CERT_DIR/$KEY_FILE;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_session_cache    shared:SSL:1m;
    ssl_session_timeout  1d;
    ssl_session_tickets  off;

    real_ip_header      proxy_protocol;
    set_real_ip_from    unix:;

    root $SITE_ROOT;
    index index.html;
    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF

    # The default site: HTTPS without SNI or with a foreign SNI (HAProxy -> 127.0.0.1:$DECOY_PORT with PROXY protocol) and port 80
    # with a foreign Host. A connection that is simply dropped is a recognisable sign; a plain 404 is not. No server_name:
    # default_server takes everything. server_names_hash_bucket_size 64: on some virtual CPUs nginx picks a cache line of 32
    # and cannot build the hash with two servers.
    mkdir -p "$R/etc/nginx/ssl-default"
    if [ ! -s "$R/etc/nginx/ssl-default/default.key" ]; then
        openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -subj "/CN=localhost" \
            -addext "subjectAltName=DNS:localhost" -keyout "$R/etc/nginx/ssl-default/default.key" \
            -out "$R/etc/nginx/ssl-default/default.crt" >/dev/null 2>&1 || die "Could not create the certificate of the default site"
        chmod 600 "$R/etc/nginx/ssl-default/default.key"; chmod 644 "$R/etc/nginx/ssl-default/default.crt"
    fi
    write_file "$R/etc/nginx/conf.d/default-decoy.conf" <<EOF
server_names_hash_bucket_size 64;

# HTTPS without SNI or with a foreign SNI (HAProxy -> 127.0.0.1:$DECOY_PORT, PROXY protocol v1)
server {
    listen 127.0.0.1:$DECOY_PORT ssl proxy_protocol default_server;
    http2 on;
    ssl_certificate     /etc/nginx/ssl-default/default.crt;
    ssl_certificate_key /etc/nginx/ssl-default/default.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_tickets off;
    real_ip_header      proxy_protocol;
    set_real_ip_from    127.0.0.1;
    server_tokens       off;
    return 404;
}

# Port 80 with a foreign Host (a request by IP): 404, the name of the node is not revealed
server {
    listen 80 default_server;
    server_tokens off;
    return 404;
}
EOF

    mkdir -p "$R$SITE_ROOT"
    if [ ! -f "$R$SITE_ROOT/index.html" ]; then
        echo '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Welcome</title></head><body><h1>Welcome</h1></body></html>' \
            | write_file "$R$SITE_ROOT/index.html"
    fi

    # nginx does not notice a certificate that was replaced on disk: reload it when the files in CERT_DIR change.
    write_file "$R/etc/systemd/system/sw-certs-reload.service" <<EOF
[Unit]
Description=Reload nginx after the certificate in $CERT_DIR changed

[Service]
Type=oneshot
ExecStartPre=/bin/sleep 5
ExecStart=/bin/sh -c 'nginx -t && systemctl reload nginx'
EOF
    write_file "$R/etc/systemd/system/sw-certs-reload.path" <<EOF
[Unit]
Description=Watch $CERT_DIR for a new certificate

[Path]
PathChanged=$CERT_DIR
Unit=sw-certs-reload.service

[Install]
WantedBy=multi-user.target
EOF
    q systemctl daemon-reload
    q systemctl enable --now sw-certs-reload.path

    _o=$(nginx -t 2>&1) || { printf '%s\n' "$_o" | dimcat; die "nginx -t: configuration error"; }
    ok "nginx -t: the configuration is valid"
    q systemctl enable nginx
    systemctl restart nginx || die "nginx did not restart"
    if [ -S "$R$NGINX_SOCK" ]; then ok "SelfSNI socket exists: $NGINX_SOCK"; else warn "The socket $NGINX_SOCK did not appear"; fi
}

haproxy_source() {
    case "$HAPROXY_SOURCE" in
        auto) if [ "${ID:-}" = ubuntu ]; then echo ppa; else echo distro; fi ;;
        *) echo "$HAPROXY_SOURCE" ;;
    esac
}

step_haproxy() {
    title "HAProxy"
    ask_domain; ask_node_ip; save_conf

    _hsrc=$(haproxy_source)
    if [ "$_hsrc" = ppa ]; then
        [ "${ID:-}" = ubuntu ] || die "The HAProxy PPA is for Ubuntu: use HAPROXY_SOURCE=distro on ${ID:-this system}"
        if ! haproxy -v 2>/dev/null | grep -qF "version $HAPROXY_VERSION."; then
            command -v add-apt-repository >/dev/null 2>&1 || apt_install software-properties-common
            run_cmd "Adding the HAProxy $HAPROXY_VERSION repository (PPA vbernat)" apt_run add-apt-repository -y "ppa:vbernat/haproxy-$HAPROXY_VERSION" || die "add-apt-repository failed"
            run_cmd "Updating the package lists" apt_get update || die "apt-get update failed"
            apt_install "haproxy=$HAPROXY_VERSION.*"
        fi
    else
        command -v haproxy >/dev/null 2>&1 || apt_install haproxy
    fi
    kv "HAProxy" "$(haproxy -v | head -n1)"

    write_file "$R/etc/haproxy/haproxy.cfg" <<EOF
# /etc/haproxy/haproxy.cfg
# Remnawave node: HAProxy on the public IP:443 -> Xray on 127.0.0.1:443

global
    log /dev/log local0
    log /dev/log local1 notice
    chroot /var/lib/haproxy
    user haproxy
    group haproxy
    daemon
    maxconn 50000

defaults
    log global
    mode tcp
    option tcplog
    option dontlognull
    timeout connect  5s
    timeout client   30s
    timeout server   30s
    timeout tunnel   1h

# Front end on the public IP of the node
frontend https_in
    bind $NODE_IP:443
    mode tcp
    option tcplog
    tcp-request inspect-delay 5s
    tcp-request content accept if { req_ssl_hello_type 1 }
    # The domain that carries VLESS/REALITY (the SNI the panel gives to clients)
    use_backend xray_vless if { req_ssl_sni -i $NODE_DOMAIN }
    # A foreign SNI, or a ClientHello without SNI: the default site (nginx, 404), not a dropped connection
    default_backend decoy_default

backend xray_vless
    mode tcp
    server xray 127.0.0.1:443 check

backend decoy_default
    mode tcp
    server nginx_default 127.0.0.1:$DECOY_PORT send-proxy
EOF

    _o=$(haproxy -c -f "$R/etc/haproxy/haproxy.cfg" 2>&1) || { printf '%s\n' "$_o" | dimcat; die "haproxy -c: configuration error"; }
    ok "haproxy -c: the configuration is valid"
    q systemctl enable haproxy
    systemctl restart haproxy || die "haproxy did not restart"
}

step_node() {
    title "Remnawave node (docker compose)"
    command -v docker >/dev/null 2>&1 || die "Docker is not installed: run the docker step first"
    if ! is_asked SECRET_KEY && [ "$NONINTERACTIVE" != 1 ]; then
        note "A node that already exists in the panel (redeploy, new server): do not create a new one in the panel; use the SECRET_KEY of the existing node."
    fi
    ask_node_port; ask_secret; save_conf

    mkdir -p "$R$NODE_DIR"
    write_file "$R$NODE_DIR/docker-compose.yml" 600 <<EOF
services:
  $NODE_CONTAINER:
    container_name: $NODE_CONTAINER
    hostname: $NODE_CONTAINER
    image: remnawave/node:$NODE_IMAGE_TAG
    restart: always
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "3"
    cap_add:
      - NET_ADMIN
    ulimits:
      nofile:
        soft: 1048576
        hard: 1048576
    environment:
      - NODE_PORT=$NODE_PORT
      - SNI_VERIFICATION=true
      - SECRET_KEY="$SECRET_KEY"
    ports:
      - "127.0.0.1:443:443"
      - "0.0.0.0:$NODE_PORT:$NODE_PORT"
    volumes:
      - /dev/shm:/dev/shm
EOF

    run_cmd "Pulling the image remnawave/node:$NODE_IMAGE_TAG" docker compose -f "$R$NODE_DIR/docker-compose.yml" pull || die "docker compose pull failed"
    run_cmd "Starting the node container" docker compose -f "$R$NODE_DIR/docker-compose.yml" up -d || die "docker compose up failed"
    kv "Container" "$(docker ps --filter "name=$NODE_CONTAINER" --format '{{.Names}}  {{.Image}}  {{.Status}}')"
}

# ---------------------------------------------------------------- verify

# The checks of a finished node. Exit code 2 when something failed (warnings do not count as a failure).
step_verify() {
    title "Verify the node"
    for _p in NODE_DOMAIN NODE_IP NODE_PORT; do
        eval "_vc=\${$_p:-}"
        [ -n "$_vc" ] || { _vc=$(conf_get "$_p"); [ -z "$_vc" ] || eval "$_p=\$_vc"; }
    done
    R_OK=0; R_WARN=0; R_FAIL=0
    _np=${NODE_PORT:-$DEFAULT_NODE_PORT}

    sect "System"
    res ok "Kernel" "$(uname -r)"
    if [ -f "$R/var/run/reboot-required" ]; then res warn "Reboot" "required (a kernel update is installed)"; else res ok "Reboot" "not required"; fi
    _cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null); _qd=$(sysctl -n net.core.default_qdisc 2>/dev/null)
    if [ "$_cc" = bbr ]; then res ok "TCP congestion control" "bbr, qdisc ${_qd:-?}"; else res warn "TCP congestion control" "${_cc:-?} (bbr expected, system step)"; fi
    if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then res ok "Time synchronisation (NTP)" "works"; else res warn "Time synchronisation (NTP)" "not synchronised (REALITY tolerates 60 s)"; fi

    sect "Services"
    for _u in "docker|Docker" "nginx|nginx" "haproxy|HAProxy" "fail2ban|fail2ban" "sw-certs-reload.path|nginx reload on a new certificate" "sw-node-api-acl.service|Node API port ACL (DOCKER-USER)"; do
        _un=${_u%%|*}; _ul=${_u#*|}
        _a=$(systemctl is-active "$_un" 2>/dev/null); _e=$(systemctl is-enabled "$_un" 2>/dev/null)
        if [ "$_a" = active ]; then res ok "$_ul" "active, ${_e:-?}"; else res fail "$_ul" "${_a:-no unit} (${_e:-?})"; fi
    done

    sect "Node container"
    _st=$(docker inspect -f '{{.State.Status}}' "$NODE_CONTAINER" 2>/dev/null)
    if [ "$_st" = running ]; then
        _img=$(docker inspect -f '{{.Config.Image}}' "$NODE_CONTAINER" 2>/dev/null)
        res ok "Container $NODE_CONTAINER" "running, $_img"
        case "$_img" in *":$NODE_IMAGE_TAG") res ok "Image tag" "$NODE_IMAGE_TAG (as pinned by the installer)" ;; *) res warn "Image tag" "$_img, the installer pins $NODE_IMAGE_TAG" ;; esac
    else
        res fail "Container $NODE_CONTAINER" "${_st:-no container}"
    fi
    if docker inspect "$NODE_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -qx 'SNI_VERIFICATION=true'; then
        res ok "SNI_VERIFICATION" "true"
    else
        res fail "SNI_VERIFICATION" "not true (a foreign SNI may be shown the certificate of the node)"
    fi

    sect "Network and ports"
    _lst=$(ss -tln 2>/dev/null | awk 'NR>1{print $4}')
    for _p in "0.0.0.0:80|nginx, port 80" "${NODE_IP:-0.0.0.0}:443|HAProxy, public :443" "127.0.0.1:$DECOY_PORT|Default site (:$DECOY_PORT)" "127.0.0.1:443|Xray (docker-proxy :443)" "0.0.0.0:$_np|Node API (port $_np)"; do
        _pa=${_p%%|*}; _pl=${_p#*|}
        if printf '%s\n' "$_lst" | grep -qx "$_pa"; then res ok "$_pl" "listening on $_pa"; else res fail "$_pl" "not listening on $_pa"; fi
    done
    if [ -S "$R$NGINX_SOCK" ]; then res ok "SelfSNI socket" "$NGINX_SOCK"; else res fail "SelfSNI socket" "missing $NGINX_SOCK"; fi
    if ! command -v nginx >/dev/null 2>&1; then res fail "nginx -t" "nginx is not installed"
    elif nginx -t >/dev/null 2>&1; then res ok "nginx -t" "the configuration is valid"
    else res fail "nginx -t" "configuration error"; fi
    if ! command -v haproxy >/dev/null 2>&1; then res fail "haproxy -c" "haproxy is not installed"
    elif haproxy -c -f "$R/etc/haproxy/haproxy.cfg" >/dev/null 2>&1; then res ok "haproxy -c" "the configuration is valid"
    else res fail "haproxy -c" "configuration error"; fi

    sect "Certificate"
    if [ -f "$R$CERT_DIR/$CERT_FILE" ]; then
        _s=$(openssl x509 -in "$R$CERT_DIR/$CERT_FILE" -noout -subject 2>/dev/null | sed 's/^subject= *//')
        _i=$(openssl x509 -in "$R$CERT_DIR/$CERT_FILE" -noout -issuer 2>/dev/null | sed 's/^issuer= *//')
        _e=$(openssl x509 -in "$R$CERT_DIR/$CERT_FILE" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
        _left=$((($(date -d "$_e" +%s 2>/dev/null || echo 0) - $(date +%s)) / 86400))
        if [ "$_s" = "$_i" ]; then
            res warn "SelfSNI certificate" "self-signed: the real certificate has not been delivered yet"
        elif [ "$_left" -lt 14 ]; then
            res fail "SelfSNI certificate" "expires in $_left days ($_s)"
        elif [ "$_left" -lt 30 ]; then
            res warn "SelfSNI certificate" "$_left days left ($_s)"
        else
            res ok "SelfSNI certificate" "$_s, $_left days left"
        fi
    else
        res fail "SelfSNI certificate" "missing $CERT_DIR/$CERT_FILE"
    fi
    _m=$(stat -c '%a %U:%G' "$R$CERT_DIR/$KEY_FILE" 2>/dev/null)
    case "$_m" in 640*) res ok "Certificate key mode" "$_m" ;; *) res warn "Certificate key mode" "${_m:-no file} (640 expected)" ;; esac
    _ck=$(getent passwd "$CERT_USER" | cut -d: -f6)
    if [ -n "$_ck" ] && [ -s "$_ck/.ssh/authorized_keys" ]; then res ok "Certificate receiver: key" "authorized_keys is there (rrsync, restrict)"; else res warn "Certificate receiver: key" "no authorized_keys for $CERT_USER (the certsync step)"; fi

    sect "Protection"
    if iptables -S DOCKER-USER 2>/dev/null | grep -q -- "--ctorigdstport $_np "; then res ok "Node API port: DOCKER-USER rules" "port $_np is for the panel only"; else res fail "Node API port: DOCKER-USER rules" "no rules: port $_np is open to everybody"; fi
    if ufw status 2>/dev/null | grep -q '^Status: active'; then
        if ufw status 2>/dev/null | grep -q "$_np"; then res ok "UFW" "active, the rule for port $_np is there"; else res warn "UFW" "active, but no rule for port $_np"; fi
    else
        res warn "UFW" "not active"
    fi
    if fail2ban-client status sshd >/dev/null 2>&1; then res ok "fail2ban: jail sshd" "active"; else res fail "fail2ban: jail sshd" "not active"; fi
    _prl=$(sshd -T 2>/dev/null | awk '$1=="permitrootlogin"{print $2}')
    if [ "$_prl" = no ]; then res ok "SSH: root login" "closed"; else res warn "SSH: root login" "${_prl:-?} (no expected, ssh step)"; fi
    _pwa=$(sshd -T 2>/dev/null | awk '$1=="passwordauthentication"{print $2}')
    if [ "$_pwa" = no ]; then res ok "SSH: password login" "closed"; else res warn "SSH: password login" "${_pwa:-?} (open; the ssh step with SSH_DISABLE_PASSWORD=yes closes it)"; fi

    sect "Answers from outside"
    if [ -n "${NODE_DOMAIN:-}" ] && [ -n "${NODE_IP:-}" ]; then
        _c=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 7 --resolve "$NODE_DOMAIN:443:$NODE_IP" "https://$NODE_DOMAIN/" 2>/dev/null)
        if [ "$_c" = 200 ]; then res ok "HTTPS with the SNI of the node" "200 (HAProxy -> Xray -> SelfSNI)"; else res warn "HTTPS with the SNI of the node" "${_c:-no answer}: 200 appears when the node has a config profile"; fi
        _c=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 7 --resolve "decoy.invalid:443:$NODE_IP" "https://decoy.invalid/" 2>/dev/null)
        if [ "$_c" = 404 ]; then res ok "HTTPS with a foreign SNI" "404 (the default site)"; else res fail "HTTPS with a foreign SNI" "${_c:-no answer} (404 expected: HAProxy decoy_default -> nginx :$DECOY_PORT)"; fi
        _c=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 7 "https://$NODE_IP/" 2>/dev/null)
        if [ "$_c" = 404 ]; then res ok "HTTPS without SNI (by IP)" "404"; else res warn "HTTPS without SNI (by IP)" "${_c:-no answer} (404 expected)"; fi
        _c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 7 "http://$NODE_IP/" 2>/dev/null)
        if [ "$_c" = 404 ]; then res ok "HTTP by IP (port 80)" "404, the name of the node is not shown"; else res warn "HTTP by IP (port 80)" "${_c:-no answer} (404 expected)"; fi
    else
        res warn "HTTPS checks" "NODE_DOMAIN and NODE_IP are not known: run the hostname and haproxy steps, or set them"
    fi

    res_summary
    [ -z "${VERIFY_STAT:-}" ] || echo "$R_OK $R_WARN $R_FAIL" >"$VERIFY_STAT" 2>/dev/null
    reboot_hint
    [ "$R_FAIL" -eq 0 ] || return 2
    return 0
}

# ---------------------------------------------------------------- SSH

# Is there a member of the sudo group with a key in authorized_keys?
ssh_admin_with_key() {
    for _m in $(getent group sudo | cut -d: -f4 | tr ',' ' '); do
        _mh=$(getent passwd "$_m" | cut -d: -f6)
        [ -n "$_mh" ] || continue
        grep -Eq '(^|[[:space:]])(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) ' "$_mh/.ssh/authorized_keys" 2>/dev/null && return 0
    done
    return 1
}

# Does the account have a usable password? (adduser --disabled-password leaves it locked: status L.)
has_password() { [ "$(passwd -S "$1" 2>/dev/null | awk '{print $2}')" = P ]; }

# An administrator with sudo and keys, then closing root login and, only if asked, password login. SSH_PHASE: user (the account and
# its keys), root (the closing), all. A caller that logs in as the new account between the two phases cannot lose access.
# Safety: root login is closed only when the sudo group has a member, password login only when a member has a key, a failed
# `sshd -t` reverts the change, and the current session is never touched (restart keeps it).
step_ssh() {
    title "SSH: administrator account, keys, root login"
    _phase=$SSH_PHASE
    if [ "$_phase" != root ]; then
        warn "Do not close this session until you have checked the login of the new account"
        ask NEW_USER "Administrator account name"
        ask NEW_USER_PUBKEY "Public SSH key of the administrator"
        ask NEW_USER_PUBKEY2 "Backup public SSH key" "" optional

        if ! id "$NEW_USER" >/dev/null 2>&1; then
            # sudo asks for a password: an account without one would be an administrator who cannot administer.
            if [ -z "${NEW_USER_PASSWORD:-}" ] && [ "$NONINTERACTIVE" = 1 ]; then
                die "NEW_USER_PASSWORD is required without a terminal when the account is created (sudo needs a password)"
            fi
            command -v sudo >/dev/null 2>&1 || apt_install sudo
            adduser --disabled-password --gecos "" "$NEW_USER" || die "adduser failed"
        fi
        if ! has_password "$NEW_USER"; then
            if [ -n "${NEW_USER_PASSWORD:-}" ]; then
                # The password goes in through the standard input of chpasswd: never in an argument, never in the journal.
                printf '%s:%s\n' "$NEW_USER" "$NEW_USER_PASSWORD" | chpasswd || die "chpasswd failed"
                ok "password of $NEW_USER set (sudo needs it)"
            elif [ "$NONINTERACTIVE" != 1 ]; then
                log "Set the password of $NEW_USER (sudo needs it)"
                passwd "$NEW_USER" <&3 >&4 2>&1 || die "passwd failed"
            fi
        fi
        usermod -aG sudo "$NEW_USER" || die "usermod failed"
        _home=$(getent passwd "$NEW_USER" | cut -d: -f6)
        [ -n "$_home" ] || die "Cannot find the home directory of $NEW_USER"
        make_dir 700 "$NEW_USER:" "$_home/.ssh"
        touch "$_home/.ssh/authorized_keys"
        grep -qxF "$NEW_USER_PUBKEY" "$_home/.ssh/authorized_keys" || printf '%s\n' "$NEW_USER_PUBKEY" >>"$_home/.ssh/authorized_keys"
        if [ -n "${NEW_USER_PUBKEY2:-}" ]; then
            grep -qxF "$NEW_USER_PUBKEY2" "$_home/.ssh/authorized_keys" || printf '%s\n' "$NEW_USER_PUBKEY2" >>"$_home/.ssh/authorized_keys"
        fi
        chown "$NEW_USER:" "$_home/.ssh/authorized_keys"
        chmod 600 "$_home/.ssh/authorized_keys"
        ok "keys of $NEW_USER written ($(grep -c . "$_home/.ssh/authorized_keys") in authorized_keys)"
    fi
    [ "$_phase" = user ] && return 0

    # Never close root login while nobody else can administer the server.
    if [ -z "$(getent group sudo | cut -d: -f4)" ]; then
        die "The sudo group has no members: run the user phase first (closing root login now would lose access)"
    fi

    _d=n; [ "$SSH_DISABLE_ROOT" = yes ] && _d=y
    if confirm "Close root login over SSH (PermitRootLogin no)?" "$_d"; then
        _had=0; [ -f "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf" ] && _had=1
        if [ -f "$R/etc/ssh/sshd_config" ]; then
            backup_file "$R/etc/ssh/sshd_config"
            sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' "$R/etc/ssh/sshd_config"
        fi
        # A drop-in of sshd_config.d is read first and wins over the main file.
        echo "PermitRootLogin no" | write_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
        if ! sshd -t; then
            restore_newest_backup "$R/etc/ssh/sshd_config"
            [ "$_had" = 1 ] || rm -f "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
            die "sshd -t: configuration error, the change was reverted"
        fi
        systemctl restart ssh 2>/dev/null || systemctl restart sshd || die "Could not restart SSH"
        ok "root login over SSH is closed (sessions stay open)"
    fi

    # Close password login only after the key login was checked in another window: otherwise access can be lost.
    _d=n; [ "$SSH_DISABLE_PASSWORD" = yes ] && _d=y
    if confirm "Close password login (keys only)? Check a key login in another window first" "$_d"; then
        ssh_admin_with_key || die "Refusing to close password login: no member of the sudo group has a key in authorized_keys"
        printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | write_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
        if ! sshd -t; then
            rm -f "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
            die "sshd -t: configuration error, the file was removed"
        fi
        systemctl reload ssh 2>/dev/null || systemctl reload sshd || die "Could not reload SSH"
        ok "password login is closed (undo: rm /etc/ssh/sshd_config.d/01-sw-keys-only.conf && systemctl reload ssh)"
    fi
}

# ---------------------------------------------------------------- rename

# Renaming the node on this server: host name, /etc/hosts, nginx (server_name), HAProxy (SNI), the saved parameters. The panel,
# DNS and clients are not touched here. NODE_DOMAIN is the new domain, RENAME_FROM the old one (default: the saved one),
# RENAME_ALIAS the names that stay valid beside the new one until clients have it: run the step again without
# RENAME_ALIAS to remove them.
step_rename() {
    title "Rename the node"
    _new=${NODE_DOMAIN:-}
    v_domain "$_new" || die "NODE_DOMAIN: the new domain is required"
    _from=${RENAME_FROM:-}
    [ -n "$_from" ] || _from=$(conf_get NODE_DOMAIN)
    [ -n "$_from" ] || die "RENAME_FROM: the former domain is unknown (no $CONF_FILE)"
    v_domain "$_from" || die "RENAME_FROM is not a valid domain"
    _alias=${RENAME_ALIAS:-}
    _names="$_new${_alias:+ $_alias}"
    for _f in "$R/etc/nginx/conf.d/default.conf" "$R/etc/nginx/conf.d/selfsni.conf" "$R/etc/haproxy/haproxy.cfg"; do
        [ -f "$_f" ] || die "Missing ${_f#"$R"}: renaming works on the configuration this installer writes"
    done
    for _f in "$R/etc/nginx/conf.d/default.conf" "$R/etc/nginx/conf.d/selfsni.conf"; do
        [ "$(grep -c '^[[:space:]]*server_name[[:space:]]' "$_f")" = 1 ] || die "${_f#"$R"}: exactly one server_name line is expected"
    done
    [ "$(grep -c 'use_backend xray_vless if { req_ssl_sni -i ' "$R/etc/haproxy/haproxy.cfg")" = 1 ] || die "haproxy.cfg: the use_backend xray_vless ... req_ssl_sni line is not there"
    kv "Was" "$_from"
    kv "Now" "$_names"

    for _f in "$R/etc/nginx/conf.d/default.conf" "$R/etc/nginx/conf.d/selfsni.conf"; do
        backup_file "$_f"
        sed -i "s/^\\([[:space:]]*server_name\\)[[:space:]].*;/\\1 $_names;/" "$_f"
    done
    backup_file "$R/etc/haproxy/haproxy.cfg"
    sed -i "s/^\\([[:space:]]*use_backend xray_vless if { req_ssl_sni -i \\)[^}]*}/\\1$_names }/" "$R/etc/haproxy/haproxy.cfg"

    if ! _o=$(nginx -t 2>&1); then
        printf '%s\n' "$_o" | dimcat
        for _f in "$R/etc/nginx/conf.d/default.conf" "$R/etc/nginx/conf.d/selfsni.conf"; do restore_newest_backup "$_f"; done
        restore_newest_backup "$R/etc/haproxy/haproxy.cfg"
        die "nginx -t: configuration error, the files were restored"
    fi
    if ! _o=$(haproxy -c -f "$R/etc/haproxy/haproxy.cfg" 2>&1); then
        printf '%s\n' "$_o" | dimcat
        for _f in "$R/etc/nginx/conf.d/default.conf" "$R/etc/nginx/conf.d/selfsni.conf"; do restore_newest_backup "$_f"; done
        restore_newest_backup "$R/etc/haproxy/haproxy.cfg"
        die "haproxy -c: configuration error, the files were restored"
    fi
    ok "nginx -t and haproxy -c: the configurations are valid"

    hostnamectl set-hostname "$_new" || die "hostnamectl failed"
    _short=${_new%%.*}; _fshort=${_from%%.*}
    if awk -v of="$_from" '{ for (i = 2; i <= NF; i++) if ($i == of) f = 1 } END { exit !f }' "$R/etc/hosts" 2>/dev/null; then
        backup_file "$R/etc/hosts"
        _tmp=$(mktemp) || die "mktemp failed"
        awk -v of="$_from" -v nf="$_new" -v os="$_fshort" -v ns="$_short" '
            { hit = 0; for (i = 2; i <= NF; i++) if ($i == of) hit = 1
              if (hit) for (i = 2; i <= NF; i++) { if ($i == of) $i = nf; else if ($i == os) $i = ns }
              print }' "$R/etc/hosts" >"$_tmp" || die "awk failed"
        cat "$_tmp" >"$R/etc/hosts"
        rm -f "$_tmp"
        ok "/etc/hosts: $_from -> $_new"
    elif [ -n "${NODE_IP:-}" ]; then
        backup_file "$R/etc/hosts"
        printf '%s %s %s\n' "$NODE_IP" "$_new" "$_short" >>"$R/etc/hosts"
        ok "added to /etc/hosts: $NODE_IP $_new $_short"
    fi

    q systemctl reload nginx || systemctl restart nginx || die "nginx did not reload its configuration"
    q systemctl reload haproxy || systemctl restart haproxy || die "haproxy did not reload its configuration"
    ok "nginx and HAProxy reloaded their configuration (connections were not cut)"
    NODE_DOMAIN=$_new
    save_conf
    kv "hostname" "$(hostname)"
    kv "Names in nginx and HAProxy" "$_names"
    [ -z "$_alias" ] || warn "The alias ($_alias) stays until clients have the new name: remove it by running this step again without RENAME_ALIAS"
    return 0
}

# A menu item: asks for the new domain and for keeping the old one as an alias (runs in a subshell of run_step).
rename_menu() {
    _cur=${NODE_DOMAIN:-}
    [ -n "$_cur" ] || _cur=$(conf_get NODE_DOMAIN)
    RENAME_FROM=$_cur
    NODE_DOMAIN=
    ask NODE_DOMAIN "New domain of the node (now: ${_cur:-not set})"
    prompt_q "Keep the old name as an alias until clients have the new one? [y/N]: "
    IFS= read -r _x <&3 || _x=
    case "$_x" in y|Y|yes) RENAME_ALIAS=$_cur ;; *) RENAME_ALIAS= ;; esac
    step_rename
}

# ---------------------------------------------------------------- full installation

phase_name() {
    case "$1" in
        base) echo "Base packages and upgrade" ;;
        system) echo "System tuning: BBR, journald, NTP" ;;
        hostname) echo "Host name and /etc/hosts" ;;
        firewall) echo "Firewall (UFW)" ;;
        fail2ban) echo "fail2ban for SSH" ;;
        docker) echo "Docker" ;;
        apiacl) echo "Node API port: panel only" ;;
        certsync) echo "Certificate receiver" ;;
        nginx) echo "nginx: SelfSNI and default site" ;;
        haproxy) echo "HAProxy" ;;
        node) echo "Remnawave node (container)" ;;
        verify) echo "Verify the node" ;;
        *) echo "$1" ;;
    esac
}

todo()  { printf '  %s%s%s %s%s.%s %s\n' "$C_Y" "$S_BOX" "$C_0" "$C_B" "$1" "$C_0" "$2"; }
todoc() { printf '       %s%s%s\n' "$C_GR" "$*" "$C_0"; }

checklist_redeploy() {
    todo 0 "DNS: A record $NODE_DOMAIN -> $NODE_IP (when the address of the server changed; wait for the TTL)."
    todo 1 "Panel: open the existing node. Do not create a node, a profile or hosts: the keys of the profile stay, clients are not affected."
    todoc "If the node is stored by address, set it to $NODE_IP. The SECRET_KEY is the one of this node."
    todo 2 "Hosts that carry the address of this node: set them to $NODE_IP when the address changed."
    todo 3 "Certificates: the SSH host key of this server changed. Remove the old key from the known_hosts of whatever delivers certificates, then deliver the certificate."
    todo 4 "Wait until the node is online in the panel."
    todo 5 "SSH: the ssh action (administrator, two keys, root login closed). The API port $NODE_PORT is open for $PANEL_ALLOW_IP only."
    todo 6 "Check: the verify action."
}

checklist_new() {
    todo 0 "DNS: A record $NODE_DOMAIN -> $NODE_IP (replace the old address when the server was replaced)."
    todo 1 "Panel: the node uses address $NODE_IP and port $NODE_PORT; give it a config profile."
    todo 2 "In the REALITY settings of its inbound: target \"$NGINX_SOCK\", xver 1, serverNames [\"$NODE_DOMAIN\"] (what the SelfSNI site expects)."
    todoc "Adding an inbound to a profile, or any change of a shared profile, restarts Xray on every node that uses it: pick a quiet time."
    todo 3 "Hosts for clients: address $NODE_IP (or the domain), SNI $NODE_DOMAIN, port 443."
    todo 4 "Certificate: deliver $CERT_FILE and $KEY_FILE for $NODE_DOMAIN to $CERT_DIR (the certsync step prepared the receiver); nginx reloads on its own."
    todo 5 "SSH: the ssh action (not part of full: it needs a key and a password). Without it root login stays open."
    todo 6 "The API port $NODE_PORT is open for $PANEL_ALLOW_IP only. If the address of the panel changes, run the apiacl step again."
    todo 7 "The node container runs with SNI_VERIFICATION=true: if the node stays offline in the panel, check that first."
    todo 8 "The image tag is pinned ($NODE_IMAGE_TAG). To update: change the tag in $NODE_DIR/docker-compose.yml, docker compose pull, docker compose up -d."
}

final_report() {  # final_report RESULT_FILE TOTAL_SECONDS
    _rf=$1; _tt=$2
    printf '\n'
    bx_top
    if [ "$INSTALL_MODE" = redeploy ]; then bx_row "Node redeployment: result" "$C_B$C_W"; else bx_row "Node installation: result" "$C_B$C_W"; fi
    bx_bot
    _failed=0
    while IFS='|' read -r _ph _rc _dt; do
        [ -n "$_ph" ] || continue
        _nm=$(phase_name "$_ph")
        _pad=$((40 - $(ulen "$_nm"))); [ "$_pad" -lt 1 ] && _pad=1
        if [ "$_rc" -eq 0 ]; then _ic="$C_G$S_OK$C_0"
        elif [ "$_ph" = verify ]; then _ic="$C_Y$S_WARN$C_0"
        else _ic="$C_R$S_ERR$C_0"; _failed=1; fi
        printf '  %s  %s%s%s%s%s\n' "$_ic" "$_nm" "$(rep ' ' "$_pad")" "$C_GR" "$(fmt_dur "$_dt")" "$C_0"
    done <"$_rf"
    if [ "$_failed" -eq 1 ]; then
        printf '\n'
        warn "The installation stopped at an error. Details above and in the journal $LOG_FILE"
        warn "Fix the cause and run the step again (or full again: the steps are idempotent)."
        return 1
    fi
    printf '\n'
    kv "Node domain" "$NODE_DOMAIN"
    kv "Public IP" "$NODE_IP"
    kv "Node API port" "$NODE_PORT (only for $PANEL_ALLOW_IP)"
    kv "Node image" "remnawave/node:$NODE_IMAGE_TAG"
    kv "Time" "$(fmt_dur "$_tt")"
    kv "Journal" "$LOG_FILE"
    if [ -s "${VERIFY_STAT:-}" ]; then
        read -r _vo _vw _vf <"$VERIFY_STAT"
        kv "Checks" "ok $_vo, warnings $_vw, failures $_vf"
    fi
    printf '\n%s%s What is left to do%s\n' "$C_B$C_Y" "$S_ARROW" "$C_0"
    if [ "$INSTALL_MODE" = redeploy ]; then checklist_redeploy; else checklist_new; fi
    printf '\n'
    reboot_hint
    return 0
}

step_full() {
    banner
    if [ "$INSTALL_MODE" = redeploy ]; then title "Redeploy an existing node"; else title "Full installation of a new node"; fi
    ask_domain; ask_node_ip; ask_node_port; ask_ssh_port; ask_panel_ip; ask_certsync_pubkey optional; ask_secret
    save_conf
    _phases=
    for _ph in $PHASES; do
        if [ "$_ph" = certsync ] && [ -z "${CERTSYNC_PUBKEY:-}" ]; then
            note "No CERTSYNC_PUBKEY: the certificate receiver is skipped (certificates must reach $CERT_DIR some other way)"
            continue
        fi
        _phases="$_phases $_ph"
    done
    step_preflight || warn "The preflight checks found problems (see above)"
    _n=0; for _ph in $_phases; do _n=$((_n + 1)); done
    confirm "Start the installation ($_n steps)?" y || { warn "Cancelled"; return 0; }
    _rf=$(mktemp) || die "mktemp failed"
    VERIFY_STAT=$(mktemp) || die "mktemp failed"
    _t_all=$(date +%s)
    STEP_TOTAL=$_n; STEP_N=0
    for _ph in $_phases; do
        STEP_N=$((STEP_N + 1))
        _t0=$(date +%s)
        ( "step_$_ph" ); _rc=$?
        printf '%s|%s|%s\n' "$_ph" "$_rc" "$(($(date +%s) - _t0))" >>"$_rf"
        if [ "$_rc" -ne 0 ] && [ "$_ph" != verify ]; then break; fi
    done
    STEP_TOTAL=; STEP_N=0
    final_report "$_rf" "$(($(date +%s) - _t_all))"
    _frc=$?
    rm -f "$_rf" "$VERIFY_STAT"
    return "$_frc"
}

# ---------------------------------------------------------------- help and demonstration

usage() {
    banner
    cat <<EOF

${C_B}Usage:${C_0}  sudo sh install.sh [options] [action]

${C_Y}${C_B}Install${C_0}
  ${C_C}full${C_0}            the whole installation: preflight, the steps below in order, a report (needs the parameters)
  ${C_C}redeploy${C_0}        the same for an existing node on a new or reinstalled server (another closing checklist)
  ${C_C}preflight${C_0}       read-only checks of the server (OS, resources, network, ports)
  ${C_C}base${C_0}            packages and upgrade            ${C_C}system${C_0}    BBR, journald, NTP
  ${C_C}hostname${C_0}        host name and /etc/hosts        ${C_C}firewall${C_0}  UFW
  ${C_C}fail2ban${C_0}        SSH protection                  ${C_C}docker${C_0}    Docker
  ${C_C}apiacl${C_0}          node API port: panel only       ${C_C}certsync${C_0}  certificate receiver
  ${C_C}nginx${C_0}           SelfSNI and default site        ${C_C}haproxy${C_0}   SNI routing
  ${C_C}node${C_0}            the node container
${C_Y}${C_B}Access and control${C_0}
  ${C_C}ssh${C_0}             administrator, keys, close root login (not part of full)
  ${C_C}rename${C_0}          rename the node on this server (NODE_DOMAIN = new, RENAME_FROM, RENAME_ALIAS)
  ${C_C}verify${C_0}          read-only checks of a finished node (exit code 2 on a failure)
${C_Y}${C_B}Help${C_0}
  ${C_C}menu${C_0}  ${C_C}help${C_0}  ${C_C}version${C_0}  ${C_C}demo${C_0} (shows the appearance, changes nothing)

${C_B}Options:${C_0}  --env-file FILE (NAME=value lines, mode 600, never executed)   --non-interactive
${C_B}Parameters${C_0} (environment, --env-file, or the saved $CONF_FILE):
$(printf '%s\n' "$PARAM_NAMES" | fold -s -w 68 | sed 's/ *$//; s/^/  /')
${C_B}Display:${C_0}  NO_COLOR=1  SW_ASCII=1  SW_VERBOSE=1  SW_NONINTERACTIVE=1
${C_GR}Journal: $LOG_FILE   Exit codes: 0 success, 1 stopped on an error, 2 the checks found a failure${C_0}

EOF
}

ui_demo() {
    banner
    title "Appearance demo (nothing is changed)"
    log "An information message"
    ok "An action succeeded"
    warn "A warning"
    note "A note (grey)"
    kv "Parameter" "value"
    kv "A longer parameter name" "value 2"
    sect "Checks"
    R_OK=0; R_WARN=0; R_FAIL=0
    res ok "Services" "active, enabled"
    res warn "SelfSNI certificate" "self-signed: the real certificate has not been delivered yet"
    res fail "Node API port: DOCKER-USER rules" "no rules: the port is open to everybody"
    res_summary
    printf '\n'
    run_cmd "A long operation (example)" sleep 1
    run_cmd "A failing operation (example)" sh -c 'echo "output line 1"; echo "output line 2"; exit 3' || true
    printf '\n'
    todo 1 "An item of the closing checklist"
    todoc "the continuation of an item, grey"
}

# ---------------------------------------------------------------- menu

dot_unit() {  # dot_unit unit [label]
    _du=$1; _dn=${2:-$1}
    if [ "$(systemctl is-active "$_du" 2>/dev/null)" = active ]; then
        printf '  %s%s%s %s' "$C_G" "$S_DOT" "$C_0" "$_dn"
    elif systemctl cat "$_du" >/dev/null 2>&1; then
        printf '  %s%s%s %s' "$C_R" "$S_DOT" "$C_0" "$_dn"
    else
        printf '  %s%s %s%s' "$C_GR" "$S_RING" "$_dn" "$C_0"
    fi
}

dash_status() {
    printf '  %sState%s' "$C_GR" "$C_0"
    dot_unit docker
    dot_unit nginx
    dot_unit haproxy
    dot_unit fail2ban
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$NODE_CONTAINER"; then
        printf '  %s%s%s node' "$C_G" "$S_DOT" "$C_0"
    elif command -v docker >/dev/null 2>&1; then
        printf '  %s%s%s node' "$C_R" "$S_DOT" "$C_0"
    else
        printf '  %s%s node%s' "$C_GR" "$S_RING" "$C_0"
    fi
    if iptables -S DOCKER-USER 2>/dev/null | grep -q -- '--ctorigdstport'; then
        printf '  %s%s%s acl' "$C_G" "$S_DOT" "$C_0"
    else
        printf '  %s%s acl%s' "$C_GR" "$S_RING" "$C_0"
    fi
    printf '\n  %s%s%s running   %s%s%s stopped   %s%s not installed%s\n' "$C_G" "$S_DOT" "$C_0" "$C_R" "$S_DOT" "$C_0" "$C_GR" "$S_RING" "$C_0"
}

mi() { printf '  %s%2s%s  %s%s%s\n' "$C_C$C_B" "$1" "$C_0" "$C_W" "$2" "$C_0"; }

pause_menu() { printf '\n  %sEnter: back to the menu%s ' "$C_GR" "$C_0" >&4; IFS= read -r _x <&3 || exit 0; }

# A step runs in a subshell: a die inside it returns to the menu instead of closing the installer.
run_step() {
    ( "$@" ) || warn "The step ended with an error (journal: $LOG_FILE)"
    pause_menu
}

menu() {
    while :; do
        banner
        printf '\n'
        dash_status
        sect "INSTALL"
        mi 1 "Full installation of a new node (preflight, steps, report)"
        mi 2 "Redeploy an existing node (reinstalled OS or a new server)"
        mi 3 "Preflight checks of the server"
        sect "STEPS ONE BY ONE"
        mi 4 "Base packages and upgrade"
        mi 5 "System tuning: BBR, journald, NTP"
        mi 6 "Host name and /etc/hosts"
        mi 7 "Firewall (UFW)"
        mi 8 "fail2ban for SSH"
        mi 9 "Docker"
        mi 10 "Node API port open to the panel only (DOCKER-USER and UFW)"
        mi 11 "Certificate receiver (restricted rsync key)"
        mi 12 "nginx: SelfSNI site and default site"
        mi 13 "HAProxy: SNI routing"
        mi 14 "Remnawave node container"
        sect "ACCESS"
        mi 15 "SSH: administrator, keys, close root login"
        mi 16 "Rename the node on this server"
        sect "CHECK"
        mi 17 "Verify the node"
        printf '\n  %s 0  Exit%s\n\n' "$C_GR" "$C_0"
        printf ' %sChoice%s: ' "$C_C$C_B" "$C_0" >&4
        IFS= read -r _c <&3 || exit 0
        case "$_c" in
            1) run_step step_full ;;
            2) INSTALL_MODE=redeploy; run_step step_full; INSTALL_MODE=new ;;
            3) run_step step_preflight ;;
            4) run_step step_base ;;
            5) run_step step_system ;;
            6) run_step step_hostname ;;
            7) run_step step_firewall ;;
            8) run_step step_fail2ban ;;
            9) run_step step_docker ;;
            10) run_step step_apiacl ;;
            11) run_step step_certsync ;;
            12) run_step step_nginx ;;
            13) run_step step_haproxy ;;
            14) run_step step_node ;;
            15) run_step step_ssh ;;
            16) run_step rename_menu ;;
            17) run_step step_verify ;;
            0|q) exit 0 ;;
            *) warn "There is no such item" ;;
        esac
    done
}

# ---------------------------------------------------------------- main

# Tests source this file for its functions.
[ "${SW_SOURCE_ONLY:-0}" = 1 ] && return 0

main() {
    ACTION=
    SW_ENV_FILE=${SW_ENV_FILE:-}
    NONINTERACTIVE=${SW_NONINTERACTIVE:-0}
    case $NONINTERACTIVE in 0|1) ;; *) die "SW_NONINTERACTIVE must be 0 or 1" ;; esac
    while [ $# -gt 0 ]; do
        case $1 in
            --env-file) [ $# -ge 2 ] || die "--env-file needs a file name"; SW_ENV_FILE=$2; shift 2 ;;
            --env-file=*) SW_ENV_FILE=${1#*=}; shift ;;
            --non-interactive) NONINTERACTIVE=1; shift ;;
            -h|--help) ACTION=help; shift ;;
            -V|--version) ACTION=version; shift ;;
            --) shift; break ;;
            -*) die "Unknown option: $1 (help: sh install.sh help)" ;;
            *) [ -z "$ACTION" ] || die "Only one action may be given"; ACTION=$1; shift ;;
        esac
    done
    [ $# -eq 0 ] || die "Only one action may be given"
    [ -n "$ACTION" ] || ACTION=menu
    # shellcheck source=/dev/null
    [ -r "$R/etc/os-release" ] && . "$R/etc/os-release"

    # These three need no root and change nothing.
    case $ACTION in
        help) usage; exit 0 ;;
        version) echo "Swellwright node installer $INSTALLER_VERSION"; exit 0 ;;
        demo) LOG_FILE=/dev/null; ui_demo; exit 0 ;;
    esac

    case $ACTION in
        menu|full|redeploy|preflight|base|system|hostname|firewall|fail2ban|docker|apiacl|certsync|nginx|haproxy|node|verify|ssh|rename) ;;
        *) die "Unknown action: $ACTION (help: sh install.sh help)" ;;
    esac
    [ "$(id -u)" -eq 0 ] || [ -n "${SW_TEST_ROOT:-}" ] || die "Root is needed: sudo sh install.sh $ACTION"

    # The read-only actions never ask anything, so they never need a terminal.
    case $ACTION in preflight|verify) NONINTERACTIVE=1 ;; esac
    if [ "$NONINTERACTIVE" != 1 ]; then
        _tin=${SW_TTY_IN:-/dev/tty}; _tout=${SW_TTY_OUT:-/dev/tty}
        if ! ( exec 3<"$_tin" 4>>"$_tout" ) 2>/dev/null; then
            die "There is no terminal to ask on: run with --non-interactive and the parameters in the environment or in an --env-file file"
        fi
        exec 3<"$_tin" 4>>"$_tout"
    elif [ "$ACTION" = menu ]; then
        die "The menu needs a terminal"
    fi

    mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$LOCK_FILE")" 2>/dev/null
    ( umask 077; : >>"$LOG_FILE" ) 2>/dev/null || die "Cannot write the journal $LOG_FILE"
    chmod 600 "$LOG_FILE" 2>/dev/null
    # One installer at a time: two runs would write the same files.
    if command -v flock >/dev/null 2>&1; then
        exec 9>"$LOCK_FILE" || die "Cannot open the lock file $LOCK_FILE"
        flock -n 9 || die "Another run of the installer is in progress"
    fi
    if [ -r "$R/etc/os-release" ]; then
        case "${ID:-}" in ubuntu|debian) ;; *) warn "Written for Debian and Ubuntu, found: ${PRETTY_NAME:-unknown}" ;; esac
    fi
    logf "=== swellwright-node-installer $INSTALLER_VERSION, action: $ACTION"

    # Parameters: what was given beats an env file, which beats the saved configuration, which beats a default.
    if [ -n "$SW_ENV_FILE" ]; then
        check_env_file "$SW_ENV_FILE"
        load_params_file "$SW_ENV_FILE" strict
    fi
    [ -f "$CONF_FILE" ] && load_params_file "$CONF_FILE" lenient
    apply_defaults
    validate_params

    case $ACTION in
        menu) menu ;;
        full) step_full ;;
        redeploy) INSTALL_MODE=redeploy; step_full ;;
        preflight) step_preflight ;;
        base) step_base ;;
        hostname) step_hostname ;;
        firewall) step_firewall ;;
        docker) step_docker ;;
        apiacl) step_apiacl ;;
        system) step_system ;;
        fail2ban) step_fail2ban ;;
        certsync) step_certsync ;;
        nginx) step_nginx ;;
        haproxy) step_haproxy ;;
        node) step_node ;;
        verify) step_verify ;;
        ssh) step_ssh ;;
        rename) step_rename ;;
    esac
    exit $?
}

main "$@"
