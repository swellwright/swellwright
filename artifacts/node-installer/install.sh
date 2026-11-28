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
# Preserve the interface without letting child commands inherit these two environment variables.
set +a
unset _input_node_secret _input_admin_secret
_input_node_secret=${SECRET_KEY:-}; _input_admin_secret=${NEW_USER_PASSWORD:-}
unset SECRET_KEY NEW_USER_PASSWORD
SECRET_KEY=$_input_node_secret; NEW_USER_PASSWORD=$_input_admin_secret
unset _input_node_secret _input_admin_secret
RUN_UID=$(id -u) || exit 1
unset VERIFY_STAT
if [ "$RUN_UID" = 0 ]; then
    unset SW_TEST_ROOT SW_SOURCE_ONLY SW_TTY_IN SW_TTY_OUT
    TMPDIR=/run
    export TMPDIR
fi

INSTALLER_VERSION=1.1.0

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
#@step {"id":"node","title":"Remnawave node container (guarded systemd startup; run apiacl first)","readOnly":false,"needsRoot":true,"inFull":true,"params":["NODE_PORT","SECRET_KEY","SECRET_KEY_FILE","NODE_IMAGE_TAG"],"requires":["SECRET_KEY"]}
#@step {"id":"verify","title":"Verify the node","readOnly":true,"needsRoot":true,"inFull":true,"params":["NODE_DOMAIN","NODE_IP","NODE_PORT","NODE_IMAGE_TAG","PANEL_ALLOW_IP"],"requires":[]}
#@step {"id":"ssh","title":"SSH: administrator account, keys, root and password login","readOnly":false,"needsRoot":true,"inFull":false,"params":["SSH_PHASE","NEW_USER","NEW_USER_PUBKEY","NEW_USER_PUBKEY2","NEW_USER_PASSWORD","NEW_USER_PASSWORD_FILE","SSH_DISABLE_ROOT","SSH_DISABLE_PASSWORD"],"requires":["NEW_USER","NEW_USER_PUBKEY"]}
#@step {"id":"rename","title":"Rename the node on this server","readOnly":false,"needsRoot":true,"inFull":false,"params":["NODE_DOMAIN","RENAME_FROM","RENAME_ALIAS","NODE_IP"],"requires":["NODE_DOMAIN"]}

# Parameters. pattern and default may name a constant of this file as "@NAME": the manifest takes its text from the
# assignment below, so the validators and the manifest cannot drift. group node: read from the environment, an
# env file or the saved configuration; group installer: environment or option only.
#@param {"name":"NODE_DOMAIN","group":"node","description":"Public domain name of the node: SNI, host name and SelfSNI site. Upper case is converted to lower case.","secret":false,"pattern":"@RE_DOMAIN","example":"node1.example.com"}
#@param {"name":"NODE_IP","group":"node","description":"Public IPv4 address of this server; HAProxy binds it on port 443.","secret":false,"pattern":"@RE_IPV4","example":"192.0.2.10"}
#@param {"name":"NODE_PORT","group":"node","description":"TCP port of the node API (panel to node); not 80, 443 or 8444. Changing an existing managed port is not supported.","secret":false,"pattern":"@RE_PORT","default":"@DEFAULT_NODE_PORT","example":"62050"}
#@param {"name":"SECRET_KEY","group":"node","description":"Node secret key from the panel (the SECRET_KEY of the compose file the panel shows for the node). 16 to 8192 characters of letters, digits and + / = _ . : -. Kept only in the compose file, mode 600. Or give SECRET_KEY_FILE.","secret":true,"pattern":"@RE_SECRET"}
#@param {"name":"SECRET_KEY_FILE","group":"node","description":"Path of a file that holds the node secret key instead of SECRET_KEY: a regular file (not a link) owned by root or by the user running the installer, mode 600 or 400, one line, at most 16 KiB. Giving both is refused. Also the option --secret-file SECRET_KEY=PATH.","secret":false,"pattern":"@RE_PATH","example":"/run/secrets/node-secret-key"}
#@param {"name":"PANEL_ALLOW_IP","group":"node","description":"IPv4 addresses (space separated) that may reach the node API port: the panel. Nobody else can.","secret":false,"pattern":"@RE_IPV4_LIST","example":"192.0.2.20 198.51.100.7"}
#@param {"name":"SSH_PORT","group":"node","description":"SSH port that the firewall keeps open. Default: the port sshd reports, else 22.","secret":false,"pattern":"@RE_PORT","default":"22","example":"22"}
#@param {"name":"CERTSYNC_PUBKEY","group":"node","description":"Public key of whatever delivers certificates to /opt/certs. Installed for the user certsync, limited to rrsync in that directory (command=, restrict). Empty: the receiver is not set up and full skips it.","secret":false,"pattern":"@RE_PUBKEY","example":"ssh-ed25519 AAAA... sender@example"}
#@param {"name":"NODE_IMAGE_TAG","group":"node","description":"Explicit release tag of the remnawave/node image. Floating tags such as latest and nightly are refused. Tags are not digest pins.","secret":false,"pattern":"@RE_TAG","default":"@DEFAULT_NODE_IMAGE_TAG","example":"3.4.6"}
#@param {"name":"FAIL2BAN_IGNORE_EXTRA","group":"node","description":"Extra IPv4 addresses or CIDR ranges (prefix 8 to 32, space separated) that fail2ban never bans, for example the Swellwright server.","secret":false,"pattern":"@RE_IPV4_CIDR_LIST","example":"192.0.2.0/24 198.51.100.7"}
#@param {"name":"BASE_UPGRADE","group":"node","description":"Run apt upgrade in the base step.","secret":false,"enum":["yes","no"],"default":"yes"}
#@param {"name":"DOCKER_SOURCE","group":"node","description":"Docker's apt repository with a pinned signing key. The convenience script is not supported.","secret":false,"enum":["apt"],"default":"apt"}
#@param {"name":"HAPROXY_SOURCE","group":"node","description":"auto: the PPA on Ubuntu, the distribution package on Debian. ppa: the vbernat PPA of HAPROXY_VERSION. distro: the distribution package.","secret":false,"enum":["auto","ppa","distro"],"default":"auto"}
#@param {"name":"HAPROXY_VERSION","group":"node","description":"HAProxy series for the PPA (major.minor).","secret":false,"pattern":"@RE_VERSION2","default":"@DEFAULT_HAPROXY_VERSION","example":"3.2"}
#@param {"name":"SSH_PHASE","group":"node","description":"user: create the administrator and its keys. root: close the requested login methods, only with a terminal and a confirmed fresh administrator login with root access. all: both.","secret":false,"enum":["user","root","all"],"default":"all"}
#@param {"name":"NEW_USER","group":"node","description":"Administrator account with sudo. Before root or password login is closed (SSH_PHASE=root or all) it names the administrator whose key login must work. Not root and not certsync.","secret":false,"pattern":"@RE_USER","example":"admin"}
#@param {"name":"NEW_USER_PUBKEY","group":"node","description":"Public SSH key of the administrator. Before root or password login is closed it must be a key in the key file of NEW_USER that gives a shell.","secret":false,"pattern":"@RE_PUBKEY","example":"ssh-ed25519 AAAA... admin@example"}
#@param {"name":"NEW_USER_PUBKEY2","group":"node","description":"Optional second (backup) public SSH key of the administrator.","secret":false,"pattern":"@RE_PUBKEY","example":"ssh-ed25519 AAAA... backup@example"}
#@param {"name":"NEW_USER_PASSWORD","group":"node","description":"Password of a newly created administrator (sudo needs it). Required without a terminal. Only through the environment, an env file or NEW_USER_PASSWORD_FILE, never logged.","secret":true,"pattern":"@RE_PASSWORD"}
#@param {"name":"NEW_USER_PASSWORD_FILE","group":"node","description":"Path of a file that holds the password of the new administrator instead of NEW_USER_PASSWORD: same rules as SECRET_KEY_FILE. Giving both is refused. Also the option --secret-file NEW_USER_PASSWORD=PATH.","secret":false,"pattern":"@RE_PATH","example":"/run/secrets/admin-password"}
#@param {"name":"SSH_DISABLE_ROOT","group":"node","description":"Close root login over SSH (only when an administrator can really log in: see the README, section SSH).","secret":false,"enum":["yes","no"],"default":"yes"}
#@param {"name":"SSH_DISABLE_PASSWORD","group":"node","description":"Close password login over SSH (only when an administrator can really log in with a key). Check the key login in another window first.","secret":false,"enum":["yes","no"],"default":"no"}
#@param {"name":"RENAME_FROM","group":"node","description":"The former domain in the rename step. Default: the domain from the saved configuration.","secret":false,"pattern":"@RE_DOMAIN","example":"node1.example.com"}
#@param {"name":"RENAME_ALIAS","group":"node","description":"Domains (space separated) that nginx and HAProxy keep accepting besides the new one, until clients have the new name.","secret":false,"pattern":"@RE_DOMAIN_LIST","example":"node1.example.com"}
#@param {"name":"INSTALL_MODE","group":"node","description":"new: a node that is not in the panel yet. redeploy: an existing node on a new or reinstalled server (changes the closing checklist).","secret":false,"enum":["new","redeploy"],"default":"new"}
#@param {"name":"SW_NONINTERACTIVE","group":"installer","description":"1: never ask; a missing required parameter stops the run.","secret":false,"enum":["0","1"],"default":"0"}
#@param {"name":"SW_ENV_FILE","group":"installer","description":"File with NAME=value lines for the parameters above (the option --env-file does the same). Mode 600, owned by root.","secret":false,"example":"/root/node.env"}
#@param {"name":"SW_VERBOSE","group":"installer","description":"1: show the output of apt and docker on the screen (it always goes to the journal).","secret":false,"enum":["0","1"],"default":"0"}
#@param {"name":"SW_ASCII","group":"installer","description":"1: plain ASCII symbols instead of Unicode ones.","secret":false,"enum":["0","1"],"default":"0"}
#@param {"name":"NO_COLOR","group":"installer","description":"Any non-empty value switches colours off (no-color.org).","secret":false,"example":"1"}

# Parameters read from the environment, an env file and the saved configuration (the group node above).
PARAM_NAMES="NODE_DOMAIN NODE_IP NODE_PORT SECRET_KEY SECRET_KEY_FILE PANEL_ALLOW_IP SSH_PORT CERTSYNC_PUBKEY NODE_IMAGE_TAG FAIL2BAN_IGNORE_EXTRA BASE_UPGRADE DOCKER_SOURCE HAPROXY_SOURCE HAPROXY_VERSION SSH_PHASE NEW_USER NEW_USER_PUBKEY NEW_USER_PUBKEY2 NEW_USER_PASSWORD NEW_USER_PASSWORD_FILE SSH_DISABLE_ROOT SSH_DISABLE_PASSWORD RENAME_FROM RENAME_ALIAS INSTALL_MODE"
# The parameters that are secrets (the manifest says secret: true). Each can be given as NAME_FILE=path instead of NAME.
SECRET_PARAMS="SECRET_KEY NEW_USER_PASSWORD"
# The largest file that may hold a secret (the longest secret is 8192 characters).
SECRET_FILE_MAX=16384
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
# An absolute path of plain characters (no space, quote or shell syntax); the length is checked by v_path.
RE_PATH='^/[A-Za-z0-9._/@+=,:-]+$'

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
NODE_START_BIN=/usr/local/sbin/sw-node-lifecycle.sh
NODE_START_UNIT=/etc/systemd/system/sw-node.service
# The enabled timer and its backup both survive a reboot until the change is confirmed.
SSH_RB_UNIT=sw-ssh-rollback
SSH_RB_SECONDS=300
SSH_RB_DIR=/var/lib/swellwright-ssh-rollback
# The lock of an SSH change: held by the step while it writes, restarts, undoes or keeps the change, and by the rollback
# script while it restores; never while the step waits for an answer.
SSH_RB_LOCK=/run/swellwright-ssh-rollback.lock
SSH_RB_FILES="/etc/ssh/sshd_config /etc/ssh/sshd_config.d/00-sw-hardening.conf /etc/ssh/sshd_config.d/01-sw-keys-only.conf"
# How many old copies of a file that holds a secret are kept (each with the secret removed).
SECRET_BACKUPS_KEEP=3
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
v_node_tag() {
    re_match "$1" "$RE_TAG" || return 1
    _node_tag=$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]') || return 1
    case $_node_tag in
        latest*|nightly*|main|master|dev|edge|main[._-]*|master[._-]*|dev[._-]*|edge[._-]*) return 1 ;;
    esac
}
v_secret() { re_match "$1" "$RE_SECRET" && [ "${#1}" -le 8192 ]; }
v_path() { re_match "$1" "$RE_PATH" && [ "${#1}" -le 4096 ]; }
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
        NODE_PORT) case $_pv in 80|443|8444) return 1 ;; esac; v_port "$_pv" ;;
        SSH_PORT) v_port "$_pv" ;;
        SECRET_KEY) v_secret "$_pv" ;;
        SECRET_KEY_FILE|NEW_USER_PASSWORD_FILE) v_path "$_pv" ;;
        PANEL_ALLOW_IP) v_ips "$_pv" ;;
        CERTSYNC_PUBKEY|NEW_USER_PUBKEY|NEW_USER_PUBKEY2) re_match "$_pv" "$RE_PUBKEY" ;;
        NODE_IMAGE_TAG) v_node_tag "$_pv" ;;
        HAPROXY_VERSION) re_match "$_pv" "$RE_VERSION2" ;;
        FAIL2BAN_IGNORE_EXTRA) re_match "$_pv" "$RE_IPV4_CIDR_LIST" ;;
        NEW_USER) v_user "$_pv" ;;
        NEW_USER_PASSWORD) re_match "$_pv" "$RE_PASSWORD" ;;
        BASE_UPGRADE|SSH_DISABLE_ROOT|SSH_DISABLE_PASSWORD) case $_pv in yes|no) return 0 ;; esac; return 1 ;;
        DOCKER_SOURCE) [ "$_pv" = apt ] ;;
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
        NODE_PORT) echo "a TCP port from 1 to 65535 other than 80, 443 and 8444" ;;
        SSH_PORT) echo "a TCP port from 1 to 65535" ;;
        SECRET_KEY) echo "the key from the panel (letters, digits and + / = _ . : -, 16 to 8192 characters)" ;;
        SECRET_KEY_FILE|NEW_USER_PASSWORD_FILE) echo "an absolute path of letters, digits and . _ / @ + = , : - (up to 4096 characters)" ;;
        PANEL_ALLOW_IP) echo "IPv4 addresses separated by spaces (not 0.x, 127.x or 224 and above)" ;;
        CERTSYNC_PUBKEY|NEW_USER_PUBKEY|NEW_USER_PUBKEY2) echo "a public key: ssh-ed25519, ssh-rsa or ecdsa-sha2-nistp256/384/521, the key, an optional comment" ;;
        NODE_IMAGE_TAG) echo "a Docker image tag (letters, digits, _ . -, up to 128 characters)" ;;
        HAPROXY_VERSION) echo "a version such as 3.2 (major.minor)" ;;
        FAIL2BAN_IGNORE_EXTRA) echo "IPv4 addresses or CIDR ranges (prefix 8 to 32) separated by spaces" ;;
        NEW_USER) echo "a lower-case account name of up to 32 characters, not root and not $CERT_USER" ;;
        NEW_USER_PASSWORD) echo "8 to 128 printable ASCII characters" ;;
        BASE_UPGRADE|SSH_DISABLE_ROOT|SSH_DISABLE_PASSWORD) echo "yes or no" ;;
        DOCKER_SOURCE) echo "apt (the convenience script is not supported)" ;;
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

# A secret can be given as a file: NAME_FILE=path instead of NAME (the environment, an env file or the option --secret-file
# NAME=path). The file is read here, once, before anything is validated. It must be a regular file (a link is refused: the
# caller named a file, not what it points to), owned by root or by the user running the installer, mode 600 or 400, one line
# (one final line break is removed) and not larger than SECRET_FILE_MAX. Giving NAME as well is refused as ambiguous. The
# value is never printed; the journal says only that a file was used.
resolve_secret_files() {
    for _sn in $SECRET_PARAMS; do
        eval "_sv=\${$_sn:-}; _sf=\${${_sn}_FILE:-}"
        [ -n "$_sf" ] || continue
        [ -z "$_sv" ] || die "$_sn and ${_sn}_FILE are both given: give only one of them (the file is the safer way)"
        v_path "$_sf" || die "${_sn}_FILE: expected $(param_hint "${_sn}_FILE")"
        [ ! -L "$_sf" ] || die "${_sn}_FILE: $_sf is a symbolic link: give the file itself"
        [ -e "$_sf" ] || die "${_sn}_FILE: $_sf does not exist"
        [ -f "$_sf" ] || die "${_sn}_FILE: $_sf is not a regular file"
        _sm=$(stat -c '%a' "$_sf" 2>/dev/null) || die "Cannot read the mode of $_sf"
        case $_sm in 600|400|0600|0400) ;; *) die "${_sn}_FILE: $_sf must have mode 600 or 400 (it is $_sm): it holds a secret" ;; esac
        _so=$(stat -c '%u' "$_sf" 2>/dev/null) || die "Cannot read the owner of $_sf"
        case $_so in 0|"$(id -u)") ;; *) die "${_sn}_FILE: $_sf must be owned by root or by the user running the installer" ;; esac
        _ss=$(stat -c '%s' "$_sf" 2>/dev/null) || die "Cannot read the size of $_sf"
        [ "$_ss" -gt 0 ] || die "${_sn}_FILE: $_sf is empty"
        [ "$_ss" -le "$SECRET_FILE_MAX" ] || die "${_sn}_FILE: $_sf is larger than $SECRET_FILE_MAX bytes"
        _sl=; _sx=
        { IFS= read -r _sl; IFS= read -r _sx; _sr=$?; } <"$_sf"
        { [ "$_sr" -ne 0 ] && [ -z "$_sx" ]; } || die "${_sn}_FILE: $_sf must hold one line (one final line break is allowed)"
        [ -n "$_sl" ] || die "${_sn}_FILE: $_sf is empty"
        eval "$_sn=\$_sl"
        ASKED="$ASKED $_sn"
        note "$_sn is read from ${_sn}_FILE ($_sf)"
    done
    _sl=; _sx=
}

# --secret-file NAME=PATH is the same as NAME_FILE=PATH (an option beats the environment).
secret_file_option() {
    case $1 in *=*) ;; *) die "--secret-file needs NAME=PATH, for example SECRET_KEY=/run/secrets/node-secret-key" ;; esac
    _on=${1%%=*}
    case " $SECRET_PARAMS " in *" $_on "*) ;; *) die "--secret-file: $_on is not a secret parameter (they are: $SECRET_PARAMS)" ;; esac
    eval "${_on}_FILE=\${1#*=}"
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

confirmed_panel() {
    if [ -f "$R$API_ACL_CONF" ]; then
        sed -n 's/^ALLOW_SRC="\(.*\)"$/\1/p' "$R$API_ACL_CONF"
    else
        conf_get PANEL_ALLOW_IP
    fi
}

panel_set() { printf '%s\n' "$1" | tr ' ' '\n' | LC_ALL=C sort -u; }
panel_destination_guard() {
    _confirmed_panel=$(confirmed_panel)
    if [ -e "$R$API_ACL_CONF" ] && ! v_ips "$_confirmed_panel"; then
        die "Cannot determine the confirmed panel addresses from the ACL configuration"
    fi
    if [ -n "$_confirmed_panel" ] && [ -n "${PANEL_ALLOW_IP:-}" ] &&
       [ "$(panel_set "$PANEL_ALLOW_IP")" != "$(panel_set "$_confirmed_panel")" ]; then
        die "The requested PANEL_ALLOW_IP differs from the confirmed panel addresses; run apiacl to change them"
    fi
    [ -z "$_confirmed_panel" ] || PANEL_ALLOW_IP=$_confirmed_panel
}

save_conf() {
    (
        umask 077
        # The ACL file is authoritative once deployed. The first firewall can seed a
        # default before Docker is installed; only the ACL step can rotate it.
        case ${1:-} in
            firewall) ;;
            node|full|apiacl) PANEL_ALLOW_IP=$(confirmed_panel) ;;
            *) NODE_PORT=$(conf_get NODE_PORT); PANEL_ALLOW_IP=$(confirmed_panel) ;;
        esac
        _saved_tmp=$(mktemp "$CONF_FILE.XXXXXX") || exit 1
        trap 'rm -f "$_saved_tmp"' EXIT
        trap 'exit 1' HUP INT TERM
        {
            echo "# swellwright node installer: saved parameters (the node secret is kept only in the compose file)"
            for _v in $SAVED_PARAMS; do
                eval "_x=\${$_v:-}"
                [ -n "$_x" ] && printf "%s='%s'\\n" "$_v" "$_x"
            done
            :
        } >"$_saved_tmp" && mv -fT "$_saved_tmp" "$CONF_FILE"
    ) || {
        warn "Could not write $CONF_FILE"
        [ "${1:-}" != apiacl ]
    }
}

# ---------------------------------------------------------------- input

# Interactive input comes from the terminal through two descriptors opened once: 3 for answers, 4 for prompts.
NONINTERACTIVE=0
DEFER_PANEL_UFW=0

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
        [ -n "$_cur" ] || die "SECRET_KEY is required: set it in the environment, in the --env-file file or as SECRET_KEY_FILE"
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

# A file that holds a secret (the compose file of the node, with SECRET_KEY) keeps its old versions too, but differently: a
# copy is created with mode 600 (never readable by anybody else, not even for a moment), the value of SECRET_KEY is removed
# from it (a rotated key must not live on in old copies; the key is shown by the panel), and only the newest
# SECRET_BACKUPS_KEEP copies stay. Copies that older versions of the installer left with the key in them are cleaned the same way.
redact_secret() {
    awk '
        /^[[:space:]]*-[[:space:]]*SECRET_KEY="[A-Za-z0-9+\/=_.:-]+"[[:space:]]*$/ ||
        /^[[:space:]]*-[[:space:]]*SECRET_KEY="[(]removed[)]"[[:space:]]*$/ {
            sub(/SECRET_KEY=.*/, "SECRET_KEY=\"(removed)\""); lines[++n]=$0; next
        }
        /SECRET_KEY/ { unsupported=1; next }
        { lines[++n]=$0 }
        END { if (unsupported) exit 1; for (i=1; i<=n; i++) print lines[i] }'
}
backup_secret_file() {
    [ -f "$1" ] || return 0
    _bs=$1.bak.$(date +%Y%m%d%H%M%S)
    redact_compose_backup "$1" "$_bs"
}
redact_compose_backup() {
    _sbt=$(mktemp "$(dirname "$2")/.redact.XXXXXX") || die "mktemp failed"
    if redact_secret <"$1" >"$_sbt"; then
        if [ "$1" = "$2" ] && cmp -s "$_sbt" "$2"; then
            rm -f "$_sbt"
        else
            mv -fT "$_sbt" "$2" || { rm -f "$_sbt"; die "Could not write the redacted compose backup"; }
        fi
        chmod 600 "$2" || die "Could not secure the compose backup"
    else
        rm -f "$_sbt"
        if [ "$1" = "$2" ]; then rm -f "$2" || die "Could not remove an unsafe compose backup"; fi
        warn "A compose backup with an unrecognized secret layout was not kept"
    fi
}
secure_secret_backups() {
    _sb_n=0
    for _sb in "$1".bak.*; do
        if [ -L "$_sb" ]; then rm -f "$_sb" || die "Could not remove a compose backup link"; continue; fi
        [ -f "$_sb" ] || continue
        chmod 600 "$_sb" || die "Could not secure a compose backup"
        redact_compose_backup "$_sb" "$_sb"
        if [ -f "$_sb" ]; then _sb_n=$((_sb_n + 1)); fi
    done
    for _sb in "$1".bak.*; do
        [ "$_sb_n" -gt "$SECRET_BACKUPS_KEEP" ] || break
        if [ -f "$_sb" ]; then
            rm -f "$_sb" || die "Could not remove an old compose backup"
            _sb_n=$((_sb_n - 1))
        fi
    done
    return 0
}
# Preserve the file and timestamped backup unless the generated content differs.
edit_if_changed() (
    _eic=$(mktemp) || die "mktemp failed"
    trap 'rm -f "$_eic"' EXIT
    trap 'exit 1' HUP INT TERM
    sed "$2" "$1" >"$_eic" || die "sed failed on ${1#"$R"}"
    if cmp -s "$_eic" "$1"; then exit 0; fi
    backup_file "$1"
    cat "$_eic" >"$1" || die "Could not write ${1#"$R"}"
)
# append_line FILE LINE: adds a line to the end of a file. A file that does not end with a line break (the image of a hosting
# provider often writes /etc/hosts so) gets one first, or the new line would be glued to the last one (found on a real server:
# the address of the node ended up inside the line of the machine itself, and the host name of that line was garbled).
append_line() {
    if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then printf '\n' >>"$1"; fi
    printf '%s\n' "$2" >>"$1"
}

# write_file PATH [MODE [secret]] < content: writes only when the content changes, keeps a backup of the old file (secret: a
# file that holds a secret, see backup_secret_file).
write_file() { write_file_inner "$@" || die "Could not write ${1#"$R"}"; }
write_file_inner() (
    _dst=$1; _mode=${2:-644}
    _tmp=
    trap '[ -z "$_tmp" ] || rm -f "$_tmp"' EXIT
    trap 'exit 1' HUP INT TERM
    if [ "${3:-}" = secret ]; then
        _tmp=$(umask 077; mktemp "$R/run/.sw-write.XXXXXX") || die "mktemp failed"
    else
        _tmp=$(mktemp) || die "mktemp failed"
    fi
    cat >"$_tmp" || die "Could not stage ${_dst#"$R"}"
    if [ -f "$_dst" ] && cmp -s "$_tmp" "$_dst"; then
        rm -f "$_tmp"
        note "unchanged: ${_dst#"$R"}"
        return 0
    fi
    if [ "${3:-}" = secret ]; then backup_secret_file "$_dst"; else backup_file "$_dst"; fi
    mkdir -p "$(dirname "$_dst")"
    install -m "$_mode" "$_tmp" "$_dst" || die "Could not write ${_dst#"$R"}"
    rm -f "$_tmp"
    ok "written: ${_dst#"$R"}"
)

# Restore exact pre-step files on a write or validation failure; a missing original stays missing.
with_config_backup() (
    _cb_apply=$1; shift
    _cb_dir=$(umask 077; mktemp -d "$R/run/.sw-config.XXXXXX") || die "Could not stage configuration backups"
    _cb_ready=0; _cb_keep=0; _cb_ok=1
    trap '
        if [ "$_cb_ready$_cb_keep" = 10 ]; then
            _cb_i=0; _cb_ok=1
            for _cb_file do
                _cb_i=$((_cb_i + 1))
                if [ -e "$_cb_dir/$_cb_i" ] || [ -L "$_cb_dir/$_cb_i" ]; then
                    cp -aT "$_cb_dir/$_cb_i" "$_cb_file" || _cb_ok=0
                else
                    rm -f "$_cb_file" || _cb_ok=0
                fi
            done
            if [ "$_cb_ok" = 0 ]; then warn "Configuration rollback incomplete; backups: $_cb_dir"; exit 1; fi
        fi
        rm -rf "$_cb_dir"
    ' EXIT
    trap 'exit 1' HUP INT TERM
    _cb_i=0
    for _cb_file do
        _cb_i=$((_cb_i + 1))
        if [ -e "$_cb_file" ] || [ -L "$_cb_file" ]; then
            cp -a "$_cb_file" "$_cb_dir/$_cb_i" || die "Could not save ${_cb_file#"$R"}"
        fi
    done
    _cb_ready=1
    "$_cb_apply"
    _cb_result=$?
    [ "$_cb_result" != 0 ] || _cb_keep=1
    exit "$_cb_result"
)

# make_dir MODE OWNER PATH (OWNER is user:group or empty)
make_dir() {
    mkdir -p "$3" || die "Could not create ${3#"$R"}"
    chmod "$1" "$3" || die "Could not set the mode of ${3#"$R"}"
    [ -z "$2" ] || chown "$2" "$3" || die "Could not change the owner of ${3#"$R"}"
}

# Is somebody else working with the packages? The lock files say it (fuser, from psmisc: on Ubuntu and a usual Debian). The
# names of processes do not: the watcher of unattended-upgrades (unattended-upgrade-shutdown) and PackageKit's daemon run
# for as long as the machine is up, or minutes after an upgrade, and hold no lock; waiting for them made every apt call of
# the installer wait for up to 15 minutes (found on a fresh Ubuntu 24.04 server). Without fuser the names of the programs
# that do the work are used, and a run of unattended-upgrade is told apart by its command line.
apt_busy() {
    if command -v fuser >/dev/null 2>&1; then
        fuser "$R/var/lib/dpkg/lock-frontend" "$R/var/lib/dpkg/lock" "$R/var/lib/apt/lists/lock" "$R/var/cache/apt/archives/lock" >/dev/null 2>&1
        return
    fi
    pgrep -x apt >/dev/null 2>&1 || pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1 \
        || pgrep -f '/usr/bin/unattended-upgrade( |$)' >/dev/null 2>&1 \
        || pgrep -x packagekitd >/dev/null 2>&1 || pgrep -f apt.systemd.daily >/dev/null 2>&1
}

# A fresh Ubuntu starts unattended-upgrades and holds the dpkg lock for a while: wait (up to 15 minutes), do not fail with
# "Could not get lock". apt itself also waits (DPkg::Lock::Timeout).
apt_wait() {
    _aw=0
    while apt_busy; do
        [ "$_aw" -eq 0 ] && echo "waiting for another apt or dpkg process (usually unattended-upgrades) to release the lock ..."
        if [ "$_aw" -ge "${APT_WAIT_MAX:-900}" ]; then echo "the dpkg lock was not released in $_aw s, going on"; return 0; fi
        sleep "${APT_WAIT_STEP:-5}"; _aw=$((_aw + ${APT_WAIT_STEP:-5}))
    done
    [ "$_aw" -gt 0 ] && echo "the lock was released after $_aw s"
    return 0
}
has_vendor_apt_repo() { [ -f "$R/etc/apt/sources.list.d/docker.list" ] || [ -f "$R/etc/apt/sources.list.d/nginx.list" ]; }
apt_update_checked() { apt-get -o DPkg::Lock::Timeout=600 -o APT::Update::Error-Mode=any update; }
apt_get() {
    apt_wait
    if has_vendor_apt_repo; then
        secure_apt_repos || return 1
        # APT may otherwise keep using old indices on a partial update, even after the unsafe keyring was replaced.
        # Repeat the strict refresh on retry too: a previous run may have stopped just after replacing the keyring.
        apt_update_checked || return 1
        [ "$*" != update ] || return 0
    fi
    apt-get -o DPkg::Lock::Timeout=600 "$@"
}
apt_run() {
    apt_wait
    if has_vendor_apt_repo; then secure_apt_repos && apt_update_checked || return 1; fi
    "$@"
}

apt_install() { run_cmd "Installing packages: $*" apt_get install -y -o Dpkg::Options::=--force-confold "$@" || die "Could not install: $*"; }

# After a kernel update (the base step) the server needs a reboot.
reboot_hint() {
    if [ -f "$R/var/run/reboot-required" ]; then
        warn "A reboot is needed (a kernel update is installed; running kernel: $(uname -r)). Reboot after the installation and check:"
        warn "docker ps, systemctl is-active haproxy nginx fail2ban sw-node-api-acl, and that the node is online in the panel."
    fi
}

# gpg_fprs FILE [PRIVATE_HOME]: print the primary fingerprints, one per line.
# Even --show-keys needs a writable GnuPG home on a clean host.
gpg_fprs() (
    _gpg_home=${2:-}
    if [ -z "$_gpg_home" ]; then
        _gpg_home=$(mktemp -d) || return 1
        trap 'rm -rf "$_gpg_home"' EXIT
        trap 'exit 1' HUP INT TERM
    fi
    _gpg_out=$(gpg --no-options --batch --no-autostart --homedir "$_gpg_home" --show-keys --with-colons "$1" 2>/dev/null) || return 1
    printf '%s\n' "$_gpg_out" | awk -F: '$1=="pub"{p=1;next} p&&$1=="fpr"{print $10;p=0}'
)

# gpg_only_fprs FILE "FPR1 FPR2" [PRIVATE_HOME]: success only for a nonempty keyring containing exclusively pinned keys.
# APT trusts every key of the keyring a source names, so one pinned key beside an unknown one is not enough.
gpg_only_fprs() {
    [ -f "$1" ] || return 1
    _gf=$(gpg_fprs "$1" "${3:-}") || return 1
    [ -n "$_gf" ] || return 1
    for _gk in $_gf; do
        case " $2 " in *" $_gk "*) ;; *) return 1 ;; esac
    done
    return 0
}

# fetch_key URL DEST "FPRS" armored|binary: downloads a signing key over HTTPS (never plain HTTP), and installs at DEST a
# keyring with only the primary keys that have a pinned fingerprint, and their subkeys: another key in the download is left
# out (and named in the journal). The keyring is exported from a temporary GnuPG home, checked, written next to DEST and
# renamed over it, so APT never reads a half-written or an unchecked file.
fetch_key() (
    case $1 in https://*) ;; *) echo "signing key: $1 is not an https address" >&2; return 1 ;; esac
    _kt=
    _kh=
    _ke=
    trap 'rm -f "$_kt" "$_ke"; rm -rf "$_kh"' EXIT
    trap 'exit 1' HUP INT TERM
    _kt=$(mktemp) || return 1
    _kh=$(mktemp -d) || return 1
    fetch_key_into "$@"
)

# The work of fetch_key; its temporary files ($_kt the download, $_kh the GnuPG home, $_ke the new keyring) are removed by it.
fetch_key_into() {
    _kok=0
    for _try in 1 2; do
        : >"$_kt"
        if curl -q --proto '=https' --tlsv1.2 -fsS --connect-timeout 10 -m 40 -o "$_kt" "$1"; then _kok=1; break; fi
        echo "signing key: download attempt $_try of $1 failed" >&2
        [ "$_try" = 2 ] || sleep 3
    done
    [ "$_kok" = 1 ] || return 1
    _ka=
    _kfps=$(gpg_fprs "$_kt" "$_kh") || return 1
    for _gk in $_kfps; do
        case " $3 " in
            *" $_gk "*) _ka="$_ka $_gk" ;;
            *) echo "signing key: $1 also holds the key $_gk, which is not pinned: it is left out of the keyring" >&2 ;;
        esac
    done
    [ -n "$_ka" ] || { echo "signing key: $1 holds no key with a pinned fingerprint" >&2; return 1; }
    mkdir -p "$(dirname "$2")" || return 1
    _ke=$(mktemp "$(dirname "$2")/.$(basename "$2").XXXXXX") || { _ke=; return 1; }
    gpg --batch --quiet --no-autostart --homedir "$_kh" --import "$_kt" || return 1
    _karm=; [ "$4" = armored ] && _karm=--armor
    # shellcheck disable=SC2086
    gpg --batch --quiet --no-autostart --homedir "$_kh" $_karm --export $_ka >"$_ke" || return 1
    gpg_only_fprs "$_ke" "$3" "$_kh" || { echo "signing key: the keyring made from $1 does not hold exactly the pinned keys" >&2; return 1; }
    chmod 644 "$_ke" || return 1
    mv -fT "$_ke" "$2" || return 1
    _ke=
    return 0
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
    net_check "Internet: Docker" "https://download.docker.com/linux/ubuntu/gpg"
    net_check "Internet: nginx repository" "https://nginx.org/keys/nginx_signing.key"
    if [ "$(haproxy_source)" = ppa ]; then net_check "Internet: HAProxy PPA" "https://ppa.launchpadcontent.net/vbernat/haproxy-${HAPROXY_VERSION:-$DEFAULT_HAPROXY_VERSION}/ubuntu/"; fi
    if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then res ok "Time synchronisation" "NTP works"; else res warn "Time synchronisation" "not synchronised (REALITY tolerates a skew of 60 s); the system step sets up NTP"; fi
    _busy=$(ss -tlnp 2>/dev/null | awk 'NR>1 && $4 ~ /:(80|443)$/ {print $4 " " $6}' | grep -Ev 'nginx|haproxy|docker-proxy' | head -n2 | tr '\n' ';')
    if [ -z "$_busy" ]; then res ok "Ports 80 and 443" "free, or held by the components of the node"; else res warn "Ports 80 and 443" "in use: $_busy"; fi
    if ! docker_service_active && { command -v docker >/dev/null 2>&1 || node_state_on_disk || ! docker_is_fresh; }; then
        res fail "Docker service" "docker.service is not active; the Docker socket was not used"
    fi
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
        append_line "$R/etc/hosts" "$NODE_IP $NODE_DOMAIN $_short"
        ok "added to /etc/hosts: $NODE_IP $NODE_DOMAIN $_short"
    fi
    kv "hostname" "$(hostname)"
    kv "hostname -f" "$(hostname -f 2>/dev/null)"
}

# ss_sshd_addrs local|peer: the local or the peer address:port of every established TCP connection that belongs to sshd (the
# open SSH sessions), one per line. Read from the kernel (ss), not from the environment: sudo drops SSH_CONNECTION.
ss_sshd_addrs() {
    _ssa=$(ss -Htnp state established 2>/dev/null) || return 1
    printf '%s\n' "$_ssa" | awk -v want="$1" '
        /[,(]"sshd(-session|-auth)?",pid=/ {
            k = 0
            for (i = 1; i <= NF; i++) if ($i ~ /:[0-9]+$/) { k++; if ((want == "local" && k == 1) || (want == "peer" && k == 2)) { print $i; break } }
        }'
}

# ssh_ports: the ports the firewall keeps open for SSH, one per line: SSH_PORT, every port sshd listens on (sshd -T lists each
# Port line) and the local port of every open SSH session; SSH_CONNECTION adds its port when the environment still has it.
ssh_ports() {
    _spl=$(ss_sshd_addrs local) || return 1
    {
        printf '%s\n' "${SSH_PORT:-}"
        sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }'
        printf '%s\n' "$_spl" | sed 's/.*://'
        _spc=${SSH_CONNECTION:-}; [ -z "$_spc" ] || printf '%s\n' "${_spc##* }"
    } | while IFS= read -r _spp; do v_port "$_spp" && printf '%s\n' "$_spp"; done | sort -un
}

# ssh_origins: the addresses the open SSH sessions come from (the way the operator reaches this server), one per line.
ssh_origins() {
    _spo=$(ss_sshd_addrs peer) || return 1
    printf '%s\n' "$_spo" | sed 's/:[0-9]*$//; s/^\[//; s/\]$//; s/^::ffff://' | LC_ALL=C grep -E '^[0-9A-Fa-f:.]+$' | sort -u
}

# no_ssh_port_overlap: stops when the node API port is also an SSH port (the firewall would restrict SSH to the panel).
no_ssh_port_overlap() {
    for _sp in $1; do
        [ "$_sp" != "$NODE_PORT" ] || die "The node API port $NODE_PORT is also an SSH port: the firewall would close SSH to everybody but the panel. Choose another NODE_PORT"
    done
}

# A failed deletion can be harmless when there was no rule to delete; read UFW's own list to distinguish it.
remove_public_ufw_rule() {
    q ufw delete allow "$NODE_PORT/tcp" && return 0
    _ufw_added=$(LC_ALL=C ufw show added 2>/dev/null) || return 1
    printf '%s\n' "$_ufw_added" | awk -v port="$NODE_PORT/tcp" '
        NF == 3 && $1 == "ufw" && $2 == "allow" && $3 == port { found=1 }
        END { exit found }'
}

sync_ufw_panel_rules() {
    for _ufw_ip in $PANEL_ALLOW_IP; do
        q ufw allow from "$_ufw_ip" to any port "$NODE_PORT" proto tcp ||
            die "UFW could not allow the panel on port $NODE_PORT"
    done
    remove_public_ufw_rule || die "UFW could not remove the unrestricted rule for port $NODE_PORT"
    _ufw_added=$(LC_ALL=C ufw show added 2>/dev/null) || die "Could not read the UFW rule list"
    _ufw_previous=$(printf '%s\n' "$_ufw_added" | awk -v p="$NODE_PORT" '
        NF == 10 && $1 == "ufw" && $2 == "allow" && $3 == "from" && $5 == "to" &&
            $6 == "any" && $7 == "port" && $8 == p && $9 == "proto" && $10 == "tcp" { print $4 }
        NF == 10 && $1 == "ufw" && $2 == "allow" && $3 == "proto" && $4 == "tcp" &&
            $5 == "from" && $7 == "to" && $8 == "any" && $9 == "port" && $10 == p { print $6 }')
    for _ufw_old in $_ufw_previous; do
        _ufw_old=${_ufw_old%/32}
        v_ipv4 "$_ufw_old" || continue
        case " $PANEL_ALLOW_IP " in *" $_ufw_old "*) continue ;; esac
        q ufw delete allow from "$_ufw_old" to any port "$NODE_PORT" proto tcp ||
            die "UFW could not remove an old panel rule for port $NODE_PORT"
    done
}

# UFW: SSH first, so that enabling the firewall cannot cut the session. The node API port is opened for the panel only.
step_firewall() {
    title "Firewall (UFW)"
    ask_ssh_port; ask_node_port; ask_panel_ip
    node_port_guard
    panel_destination_guard
    command -v ufw >/dev/null 2>&1 || apt_install ufw
    # Every port sshd serves and the port of every open session, whatever SSH_PORT says; a rule that cannot be added stops the
    # run before the firewall is switched on.
    _ssh_ports=$(ssh_ports) || die "Could not read open SSH sessions; UFW was not changed"
    no_ssh_port_overlap "$_ssh_ports"
    for _sp in $_ssh_ports; do
        [ "$_sp" = "$SSH_PORT" ] || warn "SSH also uses port $_sp (sshd or an open session), not only $SSH_PORT: keeping $_sp open as well"
        q ufw allow "$_sp/tcp" || die "UFW could not allow SSH on port $_sp: the firewall is not switched on (see the journal $LOG_FILE)"
    done
    q ufw allow 80/tcp && q ufw allow 443/tcp || die "UFW could not allow HTTP and HTTPS"
    # The node API port only for the panel: the panel's rules first, then an older rule that opened it to everyone is removed.
    if [ "${DEFER_PANEL_UFW:-0}" != 1 ]; then sync_ufw_panel_rules; fi
    q ufw --force enable || die "UFW could not be enabled (see the journal $LOG_FILE)"
    save_conf firewall
    if [ "${DEFER_PANEL_UFW:-0}" = 1 ]; then
        ok "UFW is on: SSH $SSH_PORT, 80, 443; node API rules left unchanged until apiacl"
    else
        ok "UFW is on: SSH $SSH_PORT, 80, 443, node API port $NODE_PORT only for $PANEL_ALLOW_IP"
    fi
    ufw status | sed -n '1,14p' | dimcat
    warn "UFW does not close a port that Docker publishes: the step for the node API port adds the DOCKER-USER chain rules"
}

# Docker publishes the node port with DNAT, around UFW. The rules at the top of DOCKER-USER: the allowed sources RETURN
# (they leave DOCKER-USER, Docker's own rules go on), everything else is dropped. Both --ctorigdstport (the port before DNAT)
# and --ctdir ORIGINAL are needed, or reply packets are dropped too. A unit applies them after docker.service. When the
# panel's address changes, run this step again with the new PANEL_ALLOW_IP.
#
# The rules are replaced without a moment in which the port is open: one iptables-restore transaction (all or nothing)
# deletes the old rules for the port and inserts the new ones. A run that fails or is interrupted leaves the previous rules in
# force. Rules for another port (NODE_PORT changed) are left alone: the container may still publish that port.
step_apiacl() {
    title "Node API port open to the panel only (DOCKER-USER and UFW)"
    command -v docker >/dev/null 2>&1 || die "Docker is not installed: run the docker step first"
    ask_node_port; ask_panel_ip
    node_port_guard
    node_lifecycle backend || die "The Docker firewall backend is not supported"
    _ssh_ports=$(ssh_ports) || die "Could not read open SSH sessions; the node API rules were not changed"
    no_ssh_port_overlap "$_ssh_ports"
    {
        printf '#!/bin/sh\nRE_PORT=%s\nRE_IPV4_LIST=%s\nCONF=%s\nSAVED=%s\nLOCK=%s\n' \
            "'$RE_PORT'" "'$RE_IPV4_LIST'" "'$R$API_ACL_CONF'" "'$CONF_FILE'" "'$R/run/sw-node-api-acl.lock'"
        cat <<'EOF'
# Applies and verifies the restriction of the node API port (published by Docker) to the panel.
# Written by the Swellwright node installer; its settings are in /etc/sw-node-api-allow.conf.
#
# The allowed sources RETURN (they leave DOCKER-USER, Docker's own rules go on), then a DROP for everybody else, at the top of
# DOCKER-USER. apply deletes the old rules for the port and inserts the new ones in one iptables-restore transaction (all or
# nothing): the port is never without its DROP, and a failed or interrupted run leaves the previous rules in force.
set -f
fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_values() {
    case $NODE_PORT$ALLOW_SRC in *'
'*) return 1 ;; esac
    printf '%s\n' "$NODE_PORT" | grep -Eq "$RE_PORT" &&
    printf '%s\n' "$ALLOW_SRC" | grep -Eq "$RE_IPV4_LIST"
}
load_config() {
    [ -r "$CONF" ] || fail "cannot read $CONF"
    NODE_PORT=$(sed -n 's/^NODE_PORT=//p' "$CONF")
    ALLOW_SRC=$(sed -n 's/^ALLOW_SRC="\(.*\)"$/\1/p' "$CONF")
    [ "$(wc -l <"$CONF" | tr -d ' ')" = 2 ] && valid_values || fail "invalid node API ACL configuration"
}
panel_set() { printf '%s\n' "$1" | tr ' ' '\n' | LC_ALL=C sort -u; }
TMP=
STAGED=
trap 'rm -f "$TMP" "$STAGED"' EXIT
trap 'exit 1' HUP INT TERM
exec 7>>"$LOCK" && flock 7 || fail "cannot lock the node API ACL"

# Only the exact shapes the installer has written, including legacy unmarked rules.
owned() {
  rules=$(iptables -w 10 -S DOCKER-USER 2>/dev/null) || return 1
  printf '%s\n' "$rules" | awk -v p="$NODE_PORT" '
    $1 == "-A" && $2 == "DOCKER-USER" {
      if ($3 == "-s" && $4 ~ /^[0-9.]+(\/32)?$/) { i=5; target="RETURN" }
      else { i=3; target="DROP" }
      if (NF != i+9 || $i != "-p" || $(i+1) != "tcp" || $(i+2) != "-m" || $(i+3) != "conntrack" ||
          $(i+8) != "-j" || $(i+9) != target) next
      orig="--ctorigdstport " p; dir="--ctdir ORIGINAL"
      a=$(i+4) " " $(i+5); b=$(i+6) " " $(i+7)
      if ((a == orig && b == dir) || (a == dir && b == orig)) { sub(/^-A /, "-D "); print }
    }'
}
commit() {
  iptables-restore --wait 10 --noflush <"$TMP" || { echo "iptables-restore refused the new rules: the previous rules are unchanged" >&2; return 1; }
}

verify_forward() {
  forward=$(iptables -w 10 -S FORWARD) || return 1
  [ "$(printf '%s\n' "$forward" | awk '$1 == "-A" {print; exit}')" = '-A FORWARD -j DOCKER-USER' ] ||
    { echo "FORWARD does not begin with an unconditional jump to DOCKER-USER" >&2; return 1; }
}
verify() {
  verify_forward || return 1
  rules=$(iptables -w 10 -S DOCKER-USER) || return 1
  # Check the exact effective prefix, including order. Either listing order of the two conntrack options is valid.
  printf '%s\n' "$rules" | awk -v p="$NODE_PORT" -v src="$ALLOW_SRC" '
    BEGIN { n=split(src, ip, " "); a=" --ctorigdstport " p " --ctdir ORIGINAL"; b=" --ctdir ORIGINAL --ctorigdstport " p }
    $1 == "-A" {
      if (++i > n+1) next
      prefix="-A DOCKER-USER"
      if (i <= n) { prefix=prefix " -s " ip[i]; sub(" -s " ip[i] "/32 ", " -s " ip[i] " "); target=" -j RETURN" }
      else target=" -j DROP"
      prefix=prefix " -p tcp -m conntrack"
      if ($0 != prefix a target && $0 != prefix b target) bad=1
    }
    END { exit (bad || i < n+1) ? 1 : 0 }
  ' || { echo "node API ACL read-back does not match the required rules" >&2; return 1; }
}

apply_rules() {
    [ -z "$TMP" ] || rm -f "$TMP"
    TMP=$(mktemp) || return 1
    {
      echo "*filter"
      owned || return 1
      pos=1
      for ip in $ALLOW_SRC; do
        echo "-I DOCKER-USER $pos -s $ip -p tcp -m conntrack --ctorigdstport $NODE_PORT --ctdir ORIGINAL -j RETURN"
        pos=$((pos + 1))
      done
      echo "-I DOCKER-USER $pos -p tcp -m conntrack --ctorigdstport $NODE_PORT --ctdir ORIGINAL -j DROP"
      echo "COMMIT"
    } >"$TMP" || return 1
    commit || return 1
    verify || return 2
}
update() {
    # A candidate exists only in this process until the rules have been applied and read back.
    old_src=${3:-}
    if [ -e "$CONF" ]; then
        load_config
        [ "$NODE_PORT" = "$1" ] || fail "node API ACL port does not match the expected port"
        old_src=$ALLOW_SRC
    fi
    NODE_PORT=$1 ALLOW_SRC=$2
    valid_values || fail "invalid candidate node API ACL configuration"
    if [ -n "$old_src" ] && [ "$(panel_set "$old_src")" = "$(panel_set "$ALLOW_SRC")" ]; then
        ALLOW_SRC=$old_src
    fi
    ALLOW_SRC=$(printf '%s\n' "$ALLOW_SRC" | awk '{for (i=1; i<=NF; i++) if (!seen[$i]++) {printf "%s%s", sep, $i; sep=" "}}')
    verify_forward || return 1
    STAGED=$(mktemp "$CONF.XXXXXX") || return 1
    printf 'ALLOW_SRC="%s"\nNODE_PORT=%s\n' "$ALLOW_SRC" "$NODE_PORT" >"$STAGED" &&
        chmod 644 "$STAGED" || return 1
    if cmp -s "$CONF" "$STAGED" && verify 2>/dev/null; then return 0; fi
    apply_rules
    result=$?
    if [ "$result" = 0 ] && mv -fT "$STAGED" "$CONF"; then return 0; fi
    if [ "$result" != 1 ] && [ -n "$old_src" ]; then
        ALLOW_SRC=$old_src
        valid_values && apply_rules || echo "could not verify restoration of the previous node API ACL" >&2
    fi
    return 1
}

if [ "${1:-}" = update ]; then
    update "${2:-}" "${3:-}" "${4:-}"
    exit $?
fi
load_config
if [ "$#" -ge 2 ] && [ "$2" != "$NODE_PORT" ]; then
    fail "node API ACL port does not match the expected port"
fi
if [ "$#" -ge 3 ] && [ "$(panel_set "$3")" != "$(panel_set "$ALLOW_SRC")" ]; then
    fail "node API ACL sources do not match the confirmed panel addresses"
fi
case "${1:-apply}" in
  apply) apply_rules || exit 1 ;;
  reconcile)
    saved_port=$(sed -n "s/^NODE_PORT='\\(.*\\)'$/\\1/p" "$SAVED") ||
        fail "cannot read the saved node API port"
    [ "$saved_port" = "$NODE_PORT" ] || fail "node API ACL port does not match the saved port"
    verify 2>/dev/null || apply_rules || exit 1
    ;;
  status) iptables -S DOCKER-USER ;;
  config) : ;;
  verify) verify ;;
  *) echo "usage: $0 apply|status|config|verify|reconcile"; exit 2 ;;
esac
EOF
    } | write_file "$R$API_ACL_BIN" 755 || die "Could not install the node API ACL helper"

    "$R$API_ACL_BIN" update "$NODE_PORT" "$PANEL_ALLOW_IP" "$(confirmed_panel)" ||
        die "Could not apply and verify the candidate node API ACL; saved panel addresses and UFW were not changed"
    PANEL_ALLOW_IP=$(confirmed_panel)
    save_conf apiacl || die "ACL verified, but its installer configuration mirror could not be written; retry apiacl"

    api_acl_service_unit | write_file "$R$API_ACL_UNIT" 644 || die "Could not install the node API ACL unit"
    q systemctl daemon-reload && q systemctl enable sw-node-api-acl.service || die "Could not register the node API firewall service"
    docker_service_active || die "docker.service is not active; the ACL service was not started"
    systemctl start sw-node-api-acl.service || die "sw-node-api-acl.service did not start"
    # What the kernel now does with a connection to the port, not merely that some rule names it.
    _acl=$(api_acl_check "$NODE_PORT" "$PANEL_ALLOW_IP")
    case $_acl in
        ok*) ok "Node API port $NODE_PORT: ${_acl#ok }" ;;
        warn*) warn "Node API port $NODE_PORT: ${_acl#warn }" ;;
        *) die "The node API port $NODE_PORT is not restricted as expected: ${_acl#fail } (journal: $LOG_FILE)" ;;
    esac

    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
        sync_ufw_panel_rules
        ufw status | grep "$NODE_PORT" | dimcat
    fi
    warn "If the external address of the panel changes it loses the node (users keep working): run this step again with the new PANEL_ALLOW_IP"
}

api_acl_service_unit() {
    cat <<'EOF'
[Unit]
Description=Restrict the Remnawave node API port to the panel (DOCKER-USER)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/sw-node-api-acl.sh reconcile

[Install]
WantedBy=docker.service
EOF
}

# api_acl_check PORT "ALLOWED": what the rules of DOCKER-USER, and of the chains it jumps to, do with an original-direction
# node API port from an address that is not allowed. One line: "ok DETAIL" when such a connection is certainly dropped and only
# allowed addresses get through before the drop; "warn DETAIL" when that holds but an allowed address has no rule that lets it
# through; "fail DETAIL" otherwise. With ALLOWED empty (not known), the addresses that get through are named, not judged.
# Rules are read conservatively: a condition the check does not understand may match (so an ACCEPT or RETURN with it may let
# the connection through) and may not match (so a DROP with it proves nothing). A connection that leaves DOCKER-USER is
# forwarded by Docker's own rules.
api_acl_check() {
    _aa_forward=$(iptables -S FORWARD 2>/dev/null) || { echo "fail cannot read the FORWARD chain"; return 0; }
    [ "$(printf '%s\n' "$_aa_forward" | awk '$1 == "-A" {print; exit}')" = '-A FORWARD -j DOCKER-USER' ] ||
        { echo "fail FORWARD does not begin with an unconditional jump to DOCKER-USER"; return 0; }
    _aa_all=$(iptables -S DOCKER-USER 2>/dev/null) || { echo "fail there is no DOCKER-USER chain (iptables -S fails)"; return 0; }
    _aa_seen=" DOCKER-USER "; _aa_new=$_aa_all; _aa_depth=0
    while [ -n "$_aa_new" ] && [ "$_aa_depth" -lt 8 ]; do
        _aa_depth=$((_aa_depth + 1)); _aa_next=
        for _aa_t in $(printf '%s\n' "$_aa_new" | awk '$1 == "-A" { for (i = 3; i < NF; i++) if ($i == "-j" || $i == "-g") print $(i + 1) }' | sort -u); do
            case $_aa_t in ACCEPT|DROP|RETURN|REJECT|LOG|NFLOG|MARK|CONNMARK) continue ;; esac
            case $_aa_seen in *" $_aa_t "*) continue ;; esac
            _aa_seen="$_aa_seen$_aa_t "
            _aa_r=$(iptables -S "$_aa_t" 2>/dev/null) || continue
            _aa_all="$_aa_all$NL$_aa_r"; _aa_next="$_aa_next$NL$_aa_r"
        done
        _aa_new=$_aa_next
    done
    printf '%s\n' "$_aa_all" | awk -v port="$1" -v allowed=" $2 " "$API_ACL_AWK"
}
API_ACL_AWK='
function portin(spec, p,   a) {
    if (index(spec, ":")) { split(spec, a, ":"); return (p + 0 >= a[1] + 0 && p + 0 <= a[2] + 0) }
    return (spec + 0 == p + 0)
}
# rmatch(i): 0 the rule cannot match a new connection to the port; 2 it matches every one; 3 only those from the address SRC;
# 1 it may or may not (a condition this check does not read). TGT is its target.
function rmatch(i,   n, t, k, tok, unk, q, neg) {
    n = split(rl[i], t, " "); SRC = ""; TGT = ""; GOTO = 0; unk = 0; q = 0; neg = 0
    # A comment (quoted text, escapes) is not parsed: the target is the last -j or -g (a target comes last), and the rule
    # may match (so an ACCEPT or RETURN with a comment is never certified, and a DROP with one proves nothing).
    if (index(rl[i], " --comment ")) {
        for (k = n - 1; k >= 3; k--) if (t[k] == "-j" || t[k] == "-g") { TGT = t[k + 1]; GOTO = (t[k] == "-g"); break }
        return 1
    }
    for (k = 3; k <= n; k++) {
        tok = t[k]
        if (q) { if (tok ~ /"$/) q = 0; continue }
        if (tok == "-j" || tok == "-g") { TGT = t[k + 1]; GOTO = (tok == "-g"); break }
        if (tok == "!") { neg = 1; continue }
        if (tok == "-m") { k++; continue }
        # A negated condition (! -p udp, ! --ctstate NEW ...) is not read: the rule may match.
        if (neg) { unk = 1; neg = 0; if (k < n && t[k + 1] !~ /^-/) k++; continue }
        if (tok == "-p") { k++; if (t[k] != "tcp" && t[k] != "6" && t[k] != "all" && t[k] != "0") return 0; continue }
        if (tok == "-s") { k++; if (t[k] != "0.0.0.0/0") SRC = t[k]; continue }
        if (tok == "--ctorigdstport") { k++; if (!portin(t[k], port)) return 0; continue }
        if (tok == "--ctdir") { k++; if (t[k] != "ORIGINAL") return 0; continue }
        # A translated destination port is not the original port, and the policy must also cover established flows.
        if (tok == "--comment") { k++; if (t[k] ~ /^"/ && t[k] !~ /^".*"$/) q = 1; continue }
        unk = 1
        if (k < n && t[k + 1] !~ /^-/ && t[k + 1] != "!") k++
    }
    if (unk) return 1
    if (SRC != "") return 3
    return 2
}
function pass(s) { sub(/\/32$/, "", s); if (index(passes " ", " " s " ") == 0) passes = passes " " s }
# walk(c, sure, d): "drop" (certainly dropped), "open" (may get through; WHY says how) or "back" (leaves the chain c to the
# one that jumped to it). sure: every connection reaches c (a DROP here then proves something).
function walk(c, sure, d,   i, x, m, tg, sr, r) {
    if (d > 8) { WHY = "the chains jump too deep to be read"; return "open" }
    for (i = 1; i <= cnt[c]; i++) {
        x = id[c, i]; m = rmatch(x); tg = TGT; sr = SRC
        if (m == 0) continue
        # A goto returns past the rules that follow it: not followed, never certified.
        if (GOTO) { WHY = "a goto (-g) is not followed by this check: " rl[x]; return "open" }
        # A target this check does not know may end the chain in a way it cannot tell: not certified.
        if (tg != "" && !(tg in has) && tg !~ /^(ACCEPT|RETURN|DROP|REJECT|LOG|NFLOG|MARK|CONNMARK|TRACE|NOTRACK|CT|CLASSIFY|TCPMSS|DSCP|TOS|AUDIT)$/) {
            WHY = "a rule with a target this check does not read: " rl[x]; return "open"
        }
        if (tg == "ACCEPT" || (tg == "RETURN" && c == "DOCKER-USER")) {
            if (m == 3) { pass(sr); continue }
            WHY = "let through by: " rl[x]; return "open"
        }
        if (tg == "RETURN") {
            # Some sources go back to the chain that jumped here; this check does not follow them there: it does not certify.
            if (m == 3) { WHY = "a rule sends some sources back to the chain that jumped to " c ", which this check does not follow: " rl[x]; return "open" }
            if (m == 2) return "back"
            WHY = "a rule that may send it back cannot be read: " rl[x]; return "open"
        }
        if (tg == "DROP" || tg == "REJECT") { if (m == 2 && sure) { DROPPED = rl[x]; return "drop" } continue }
        if (tg in has) {
            r = walk(tg, sure && m == 2, d + 1)
            if (m == 3) { if (r == "open") pass(sr); continue }
            if (r == "open") return r
            if (r == "drop" && m == 2) return r
        }
    }
    if (c == "DOCKER-USER") { WHY = "no rule of DOCKER-USER drops it (it leaves the chain and Docker forwards it)"; return "open" }
    return "back"
}
$1 == "-N" { has[$2] = 1 }
$1 == "-A" { has[$2] = 1; cnt[$2]++; id[$2, cnt[$2]] = NR; rl[NR] = $0 }
END {
    if (!("DOCKER-USER" in has)) { print "fail there is no DOCKER-USER chain"; exit }
    passes = ""
    if (walk("DOCKER-USER", 1, 0) != "drop") { print "fail open to everybody: " WHY; exit }
    known = (allowed !~ /^ *$/)
    bad = ""; n = split(passes, ps, " ")
    for (i = 1; i <= n; i++) if (known && index(allowed, " " ps[i] " ") == 0) bad = bad " " ps[i]
    if (bad != "") { print "fail also open to" bad " (not in PANEL_ALLOW_IP)"; exit }
    who = (passes == "") ? "nobody" : substr(passes, 2)
    miss = ""
    if (known) { n = split(allowed, al, " "); for (i = 1; i <= n; i++) if (index(passes " ", " " al[i] " ") == 0) miss = miss " " al[i] }
    if (miss != "") { print "warn only " who " get through, everything else is dropped; nothing lets" miss " through (the panel cannot reach the node)"; exit }
    print "ok only " who " get through, everything else is dropped"
}'

# Repair sources managed by this installer before any installer-driven APT call can use a legacy keyring or HTTP URL.
secure_apt_repos() {
    if [ -f "$R/etc/apt/sources.list.d/docker.list" ]; then vendor_apt_repo docker || return 1; fi
    if [ -f "$R/etc/apt/sources.list.d/nginx.list" ]; then vendor_apt_repo nginx || return 1; fi
}

# Print the codename, or explain why the repository cannot be configured. Run before announcing repository setup.
vendor_apt_release() {
    case "${ID:-}" in
        debian) _release=${VERSION_CODENAME:-} ;;
        ubuntu) _release=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}} ;;
        *)
            case "$1" in
                docker) echo "Docker's apt repository is set up for Debian and Ubuntu only (this is ${ID:-unknown})" >&2 ;;
                nginx) echo "The nginx.org repository is set up for Debian and Ubuntu only (this is ${ID:-unknown})" >&2 ;;
            esac
            return 1 ;;
    esac
    [ -n "$_release" ] || { echo "Cannot tell the release name from /etc/os-release" >&2; return 1; }
    printf '%s\n' "$_release"
}

vendor_apt_repo() {
    _cn=${2:-}
    [ -n "$_cn" ] || _cn=$(vendor_apt_release "$1") || return 1
    case "$1" in
        docker)
            _ak_path=/etc/apt/keyrings/docker.asc
            _ak_url="https://download.docker.com/linux/$ID/gpg"
            _ak_pins=$DOCKER_KEY_FPRS; _ak_format=armored
            _ak_arch=$(dpkg --print-architecture) || return 1
            _ak_list="deb [arch=$_ak_arch signed-by=$_ak_path] https://download.docker.com/linux/$ID $_cn stable" ;;
        nginx)
            _ak_path=/usr/share/keyrings/nginx-archive-keyring.gpg
            _ak_url=https://nginx.org/keys/nginx_signing.key
            _ak_pins=$NGINX_KEY_FPRS; _ak_format=binary
            _ak_list="deb [signed-by=$_ak_path] https://nginx.org/packages/$ID $_cn nginx" ;;
        *) return 1 ;;
    esac
    if ! gpg_only_fprs "$R$_ak_path" "$_ak_pins"; then
        if ! fetch_key "$_ak_url" "$R$_ak_path" "$_ak_pins" "$_ak_format"; then
            case "$1" in docker) echo "Could not get Docker's signing key with the expected fingerprint" >&2 ;;
                nginx) echo "Could not get the nginx.org signing key with an expected fingerprint" >&2 ;;
            esac
            return 1
        fi
    fi
    _ak_file="$R/etc/apt/sources.list.d/$1.list"
    if [ "$(cat "$_ak_file" 2>/dev/null)" != "$_ak_list" ]; then
        printf '%s\n' "$_ak_list" | write_file "$_ak_file" || return 1
    fi
}

docker_apt_repo() {
    _docker_release=$(vendor_apt_release docker 2>&1) || die "$_docker_release"
    run_cmd "Preparing the Docker repository and pinned keyring" vendor_apt_repo docker "$_docker_release" ||
        die "Could not prepare Docker's apt repository with the expected signing key (journal: $LOG_FILE)"
}

step_docker() {
    title "Docker"
    # Do not bring up a stopped daemon with an existing uninspected node on disk.
    node_port_guard
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        ok "Docker is already installed: $(docker --version)"
        systemctl enable docker.service || die "Could not enable Docker for boot"
    elif command -v docker >/dev/null 2>&1; then
        die "Docker is installed without the compose plugin: install docker-compose-plugin (or remove the old Docker package) and run the step again"
    else
        docker_apt_repo
        apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        systemctl enable --now docker || die "docker did not start"
    fi
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

    _nginx_release=$(vendor_apt_release nginx 2>&1) || die "$_nginx_release"
    run_cmd "Preparing the nginx.org repository and pinned keyring" vendor_apt_repo nginx "$_nginx_release" ||
        die "Could not prepare the nginx.org repository with an expected signing key (journal: $LOG_FILE)"
    printf 'Package: *\nPin: origin nginx.org\nPin-Priority: 900\n\n' | write_file "$R/etc/apt/preferences.d/99nginx"
    apt_install nginx
    kv "nginx" "$(nginx -v 2>&1)"

    ensure_cert

    mkdir -p "$R/etc/nginx/ssl-default"
    if [ ! -s "$R/etc/nginx/ssl-default/default.key" ]; then
        openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -subj "/CN=localhost" \
            -addext "subjectAltName=DNS:localhost" -keyout "$R/etc/nginx/ssl-default/default.key" \
            -out "$R/etc/nginx/ssl-default/default.crt" >/dev/null 2>&1 || die "Could not create the certificate of the default site"
        chmod 600 "$R/etc/nginx/ssl-default/default.key"; chmod 644 "$R/etc/nginx/ssl-default/default.crt"
    fi
    with_config_backup nginx_write_config "$R/etc/nginx/conf.d/default.conf" \
        "$R/etc/nginx/conf.d/selfsni.conf" "$R/etc/nginx/conf.d/default-decoy.conf" ||
        die "nginx configuration was not applied"
    nginx_enable_services
}

nginx_write_config() {
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

    _o=$(nginx -t 2>&1) || { printf '%s\n' "$_o" | dimcat; die "nginx -t: configuration error"; }
    ok "nginx -t: the configuration is valid"
}

nginx_enable_services() {
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

    with_config_backup haproxy_write_config "$R/etc/haproxy/haproxy.cfg" || die "HAProxy configuration was not applied"
    q systemctl enable haproxy
    systemctl restart haproxy || die "haproxy did not restart"
}

haproxy_write_config() {
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
}

docker_service_active() { systemctl is-active --quiet docker.service >/dev/null 2>&1; }
docker_is_fresh() {
    [ ! -e "$R/var/lib/docker" ] && [ ! -L "$R/var/lib/docker" ] &&
        [ "$(systemctl show -p LoadState --value docker.service 2>/dev/null)" = not-found ]
}

node_docker() (
    docker_service_active || return 1
    unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
    unset COMPOSE_REMOVE_ORPHANS
    docker --host unix:///var/run/docker.sock "$@"
)

# One implementation for installer prechecks, unit execution and read-only verification.
node_lifecycle_script() {
    cat <<'EOF'
#!/bin/sh
set -eu
PATH=${PATH:-/usr/sbin:/usr/bin:/sbin:/bin}
export PATH
mode=$1
root=${2:-}
saved=${3:-}
requested=${4:-}
compose=$root/opt/remnanode/docker-compose.yml
acl=$root/usr/local/sbin/sw-node-api-acl.sh
receipt=$root/run/sw-node/container
name=remnanode
network=${name}_default
socket=unix:///var/run/docker.sock
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
d() {
    systemctl is-active --quiet docker.service >/dev/null 2>&1 || return 1
    docker --host "$socket" "$@"
}
fail() { printf 'Node startup: %s\n' "$*" >&2; exit 1; }

saved_param() { sed -n "s/^$1='\\(.*\\)'$/\\1/p" "$root/etc/swellwright-node-installer.conf"; }
supported_backend() {
    info=$(d info --format '{{.OSType}} {{.LiveRestoreEnabled}} {{json .SecurityOptions}}' 2>/dev/null) ||
        fail "cannot inspect the local Docker daemon"
    case $info in
        *rootless*|*userns*) fail "rootless or user namespace Docker is not supported" ;;
        'linux false '*) ;;
        *) fail "only local Linux Docker with live-restore disabled is supported" ;;
    esac
    # Older daemon versions may omit the driver value, but the CLI must support inspecting
    # it. In all cases require Docker's IPv4 NAT hook as well as a DOCKER-USER prefix.
    backend=$(d info --format '{{with .FirewallBackend}}{{.Driver}}{{end}}' 2>/dev/null) ||
        fail "cannot determine Docker's firewall backend with this client"
    case $backend in ''|iptables) ;; *) fail "Docker must use the IPv4 iptables firewall backend" ;; esac
    nat=$(iptables -w 10 -t nat -S PREROUTING 2>/dev/null) ||
        fail "cannot read the Docker IPv4 iptables NAT hook"
    printf '%s\n' "$nat" | grep -qxF -- '-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER' ||
        fail "cannot find the Docker IPv4 iptables NAT hook"
    iptables -w 10 -t nat -S DOCKER >/dev/null 2>&1 || fail "cannot read the Docker IPv4 NAT chain"
}

valid_id() { [ "${#1}" -eq 64 ] && case $1 in *[!0-9a-f]*) false ;; *) true ;; esac; }
find_node() {
    cid=$(d ps -a --no-trunc --filter 'name=^/remnanode$' --format '{{.ID}}' 2>/dev/null) ||
        fail "cannot determine whether the node container exists on the local Docker daemon"
    [ -z "$cid" ] || valid_id "$cid" || fail "unexpected node container identity"
}
inspect() { d container inspect -f "$1" "$cid" 2>/dev/null || fail "cannot inspect the selected node container"; }
node_state() { inspect '{{.State.Status}}'; }
restart_policy() { inspect '{{.HostConfig.RestartPolicy.Name}}'; }
bindings() {
    # Only bound ports are printed; Docker also lists unbound EXPOSE entries from the image.
    captured=$(inspect "$1") || return 1
    printf '%s\n' "$captured" | LC_ALL=C sort
}
inspect_network() {
    net=$(d network inspect -f '{{.Driver}}|{{.Scope}}|{{.Internal}}|{{.EnableIPv6}}|{{json .Options}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}' "$network" 2>/dev/null) ||
        fail "cannot inspect the node bridge network"
    case $net in 'bridge|local|false|false|{}|remnanode|default'|'bridge|local|false|false|null|remnanode|default') ;;
        *) fail "the node requires the default IPv4-only Compose bridge network" ;;
    esac
}

inspect_node() {
    [ -n "$saved" ] || fail "existing node has no saved NODE_PORT; ownership or topology cannot be verified"
    owner=$(inspect '{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.PublishAllPorts}}')
    [ "$owner" = "/$name|$name|$name|$compose|${compose%/*}|False|$network|false" ] ||
        fail "the existing node has unrecognized ownership or topology; no container was changed"
    case $(inspect '{{.Config.Image}}') in
        remnawave/node:*) ;;
        *) fail "the existing node does not use the installer node image" ;;
    esac
    state=$(node_state)
    case $state in created|exited|running) ;; *) fail "the existing node is not in a supported state";; esac
    # Select NODE_PORT inside Docker's formatter. No other environment values leave Docker.
    port=$(inspect '{{range .Config.Env}}{{if ge (len .) 10}}{{if eq (slice . 0 10) "NODE_PORT="}}{{println (json (slice . 10))}}{{end}}{{end}}{{end}}')
    [ "$port" = "\"$saved\"" ] || fail "container NODE_PORT does not match the saved port"
    expected="443/tcp|127.0.0.1|443
$saved/tcp|0.0.0.0|$saved"
    expected=$(printf '%s\n' "$expected" | LC_ALL=C sort)
    format='{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{printf "%s|%s|%s\n" $port .HostIp .HostPort}}{{end}}{{end}}'
    [ "$(bindings "$format")" = "$expected" ] ||
        fail "configured Docker bindings do not match the saved IPv4 ports"
    attached=$(inspect '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}')
    case "$state|$attached" in "created|"|"exited|"|*"|$network") ;;
        *) fail "the node has unexpected network attachments" ;;
    esac
    if [ "$state" = running ]; then
        format='{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{printf "%s|%s|%s\n" $port .HostIp .HostPort}}{{end}}{{end}}'
        [ "$(bindings "$format")" = "$expected" ] ||
            fail "running Docker bindings do not match the saved IPv4 ports"
    fi
    inspect_network
    policy=$(restart_policy)
    case $policy in always|unless-stopped|no|'') ;; *) fail "the existing node has an unrecognized restart policy" ;; esac
}

isolated_project() {
    project_ids=$(d ps -a --no-trunc --filter 'label=com.docker.compose.project=remnanode' --format '{{.ID}}' 2>/dev/null) ||
        fail "cannot inspect the node Compose project"
    [ "$project_ids" = "$cid" ] || fail "the node Compose project contains unrecognized containers"
    networks=$(d network ls --filter 'name=^remnanode_default$' --format '{{.Name}}' 2>/dev/null) ||
        fail "cannot inspect the network of the node Compose project"
    [ -n "$networks" ] || { [ -z "$cid" ] || fail "the node Compose network is absent"; return 0; }
    [ "$networks" = "$network" ] || fail "the node Compose network is ambiguous"
    [ -n "$cid" ] || inspect_network
    members=$(d network inspect -f '{{range $id, $_ := .Containers}}{{println $id}}{{end}}' "$network" 2>/dev/null) ||
        fail "cannot inspect node bridge members"
    [ -z "$members" ] || [ "$members" = "$cid" ] || fail "the node bridge is shared with other containers"
}

case $mode in
    backend) supported_backend ;;
    probe|retire)
        find_node
        if [ -z "$cid" ]; then
            [ ! -e "$receipt" ] || fail "a stop receipt remains but the recorded node cannot be found"
            isolated_project
            exit 0
        fi
        supported_backend
        inspect_node
        isolated_project
        if [ "$mode" = probe ] && [ "$saved" != "$requested" ]; then
            fail "Changing the node API port is not supported"
        fi
        if [ "$mode" = retire ]; then
            if [ -e "$receipt" ]; then
                read -r supervised <"$receipt" && [ "$supervised" = "$cid" ] ||
                    fail "the stop receipt does not identify the selected node"
            fi
            case $policy in
                always|unless-stopped)
                    d update --restart=no "$cid" >/dev/null 2>&1 || fail "cannot disable the old node restart policy"
                    [ "$(restart_policy)" = no ] || fail "the old node restart policy is still enabled"
                    ;;
            esac
            if [ "$state" = running ]; then
                d container stop "$cid" >/dev/null 2>&1 || fail "cannot stop the old node"
            fi
            case $(node_state) in exited|created) ;; *) fail "the old node did not stop" ;; esac
            rm -f "$receipt" || fail "cannot clear the verified stop receipt"
        fi
        ;;
    start|verify)
        [ -n "$saved" ] || saved=$(saved_param NODE_PORT)
        case $saved in ''|*[!0-9]*) fail "missing or invalid saved NODE_PORT" ;; esac
        [ "$saved" = "$(saved_param NODE_PORT)" ] || fail "requested and saved NODE_PORT do not match"
        supported_backend
        find_node
        [ -n "$cid" ] || fail "no prepared node container; run the installer node step"
        inspect_node
        case $policy in no|'') ;; *) fail "Docker autonomous restart is enabled" ;; esac
        if [ "$mode" = verify ]; then
            [ "$state" = running ] || fail "the guarded node is not running"
            [ -r "$receipt" ] && read -r supervised <"$receipt" && [ "$supervised" = "$cid" ] ||
                fail "the startup service does not record this running container"
            "$acl" verify "$saved"
            exit
        fi
        [ "$state" != running ] || fail "the node is already running outside this start attempt"
        if [ -e "$receipt" ]; then
            read -r supervised <"$receipt" && [ "$supervised" = "$cid" ] ||
                fail "the stop receipt does not identify the selected node"
        fi
        "$acl" apply "$saved" || fail "the API ACL was not verified; the node was not started"
        printf 'Node startup: verified IPv4 ACL for TCP port %s before publication\n' "$saved"
        # Publish only the exact inspected container, never start anything by a reusable name.
        printf '%s\n' "$cid" >"$receipt" || fail "cannot record the selected container"
        d container start "$cid" >/dev/null 2>&1 || fail "Docker could not start the prepared node"
        # ExecStop stops the container first. If systemd then terminates the still-waiting
        # shell, exit cleanly without treating a killed Docker client as a container error.
        trap 'exit 0' TERM
        systemd-notify --ready --pid="$$" || fail "cannot notify systemd that the node started"
        d container wait "$cid" >/dev/null 2>&1 &
        wait "$!"
        ;;
    stop)
        # No receipt means no authority to stop anything, not proof of container state.
        [ -e "$receipt" ] || exit 0
        read -r cid <"$receipt" && valid_id "$cid" || fail "invalid node runtime identity"
        systemctl is-active --quiet docker.service >/dev/null 2>&1 ||
            fail "docker.service is not active; retained the node stop receipt"
        case $(node_state) in
            running) d container stop "$cid" >/dev/null 2>&1 || fail "cannot stop the guarded node" ;;
            created|exited) ;;
            *) fail "guarded node is not in a supported state" ;;
        esac
        case $(node_state) in created|exited) ;; *) fail "the guarded node did not stop" ;; esac
        rm -f "$receipt"
        ;;
    *) fail "unrecognized lifecycle action" ;;
esac
EOF
}

node_lifecycle() { node_lifecycle_script | sh -s -- "$1" "$R" "${2:-}" "${3:-}"; }

node_safe_path() (
    _path=$R$1
    [ ! -L "$_path" ] || return 1
    [ -e "$_path" ] || return 0
    if [ "$2" = dir ]; then
        [ -d "$_path" ] || return 1
    else
        [ -f "$_path" ] && [ "$(stat -c %h "$_path")" = 1 ] || return 1
    fi
    # RUN_UID is necessarily root outside the unprivileged fake-root harness.
    [ "$(stat -c %u "$_path")" = "$RUN_UID" ] || return 1
    _mode=$(stat -c %a "$_path") || return 1
    case $_mode in
        *[!0-7]*|*[2367]?|*[2367]) return 1 ;;
        [0-7][0-7]|[0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) return 0 ;;
        *) return 1 ;;
    esac
)

node_known_unit() (
    _unit=$1
    _loaded=$(systemctl show -p LoadState -p FragmentPath -p DropInPaths -p NeedDaemonReload "${_unit##*/}" 2>/dev/null)
    _load=$(printf '%s\n' "$_loaded" | sed -n 's/^LoadState=//p')
    _fragment=$(printf '%s\n' "$_loaded" | sed -n 's/^FragmentPath=//p')
    _dropins=$(printf '%s\n' "$_loaded" | sed -n 's/^DropInPaths=//p')
    [ -z "$_dropins" ] || return 1
    if [ ! -e "$R$_unit" ]; then
        [ "$_load" = not-found ] && [ -z "$_fragment" ]
        return
    fi
    [ "$_load" = loaded ] && [ "$_fragment" = "$_unit" ] &&
        printf '%s\n' "$_loaded" | grep -qxF 'NeedDaemonReload=no' || return 1
    case $_unit in
        "$NODE_START_UNIT")
            node_service_unit | cmp -s "$R$_unit" - ||
                node_service_unit | sed '/^RuntimeDirectoryPreserve=yes$/d' | cmp -s "$R$_unit" - ;;
        "$API_ACL_UNIT")
            api_acl_service_unit | cmp -s "$R$_unit" - ||
                api_acl_service_unit | sed 's/ reconcile$/ apply/; s/^WantedBy=docker.service$/WantedBy=multi-user.target/' |
                    cmp -s "$R$_unit" - ;;
        *) return 1 ;;
    esac
)

node_host_paths() (
    for _dir in /opt "$NODE_DIR" /etc /etc/systemd /etc/systemd/system /usr /usr/local /usr/local/sbin /run /run/sw-node; do
        node_safe_path "$_dir" dir || { echo "Unsafe node path: $_dir" >&2; return 1; }
    done
    for _file in "$NODE_DIR/docker-compose.yml" "$API_ACL_CONF" "$API_ACL_BIN" \
        "$API_ACL_UNIT" "$NODE_START_BIN" "$NODE_START_UNIT" /run/sw-node/container /run/sw-node-api-acl.lock; do
        node_safe_path "$_file" file || { echo "Unsafe node path: $_file" >&2; return 1; }
    done
    for _backup in "$R$NODE_DIR"/docker-compose.yml.bak.*; do
        _file=${_backup#"$R"}
        node_safe_path "$_file" file || { echo "Unsafe node path: $_file" >&2; return 1; }
    done
    for _unit_file in "$API_ACL_UNIT" "$NODE_START_UNIT"; do
        node_known_unit "$_unit_file" || { echo "Unknown node unit: ${_unit_file##*/}" >&2; return 1; }
    done
    if { [ -f "$R$API_ACL_UNIT" ] && [ ! -x "$R$API_ACL_BIN" ]; } ||
       { [ -f "$R$NODE_START_UNIT" ] && [ ! -x "$R$NODE_START_BIN" ]; }; then
        echo "Cannot verify node units: an installed helper is missing or not executable" >&2
        return 1
    fi
)

node_state_on_disk() (
    for _node_path in "$NODE_DIR/docker-compose.yml" "$API_ACL_CONF" "$API_ACL_UNIT" "$NODE_START_UNIT" /run/sw-node/container; do
        if [ -e "$R$_node_path" ] || [ -L "$R$_node_path" ]; then return 0; fi
    done
    return 1
)

node_port_guard() {
    node_host_paths || die "Could not verify node path and unit ownership; nothing was changed"
    _saved_node_port=$(conf_get NODE_PORT)
    if node_state_on_disk; then
        [ -n "$_saved_node_port" ] || die "The existing node has no saved NODE_PORT; do not change the node configuration"
        [ "$NODE_PORT" = "$_saved_node_port" ] || die "Changing the node API port is not supported; nothing was changed"
        [ ! -e "$R$API_ACL_CONF" ] || [ "$(sed -n 's/^NODE_PORT=//p' "$R$API_ACL_CONF")" = "$_saved_node_port" ] ||
            die "The node API ACL port does not match the saved port; nothing was changed"
    fi
    if command -v docker >/dev/null 2>&1; then
        docker_service_active || die "docker.service is not active; the Docker socket was not used"
        node_lifecycle probe "$_saved_node_port" "$NODE_PORT" || die "Could not verify existing node ownership or topology; nothing was changed"
    elif node_state_on_disk; then
        die "Docker is unavailable; cannot verify the existing node configuration"
    elif ! docker_is_fresh; then
        die "Cannot verify a fresh Docker bootstrap: a service is present or its state is unknown"
    fi
}

quiesce_node() {
    node_host_paths || die "Could not verify node path and unit ownership; nothing was changed"
    if [ -e "$R$NODE_START_UNIT" ]; then
        docker_service_active || die "docker.service is not active; the node service was not stopped"
        # An earlier guarded unit would let systemd discard the receipt even if
        # its stop hook failed. Install the verified stop contract before using it.
        if ! grep -qxF 'RuntimeDirectoryPreserve=yes' "$R$NODE_START_UNIT"; then
            write_node_service
            q systemctl daemon-reload || die "Could not load the guarded stop contract"
        fi
        docker_service_active || die "docker.service is not active; the node service was not stopped"
        q systemctl stop sw-node.service || die "Could not stop the guarded node service"
    fi
    if command -v docker >/dev/null 2>&1; then
        node_lifecycle retire "$(conf_get NODE_PORT)" || die "Could not disarm the existing node; not starting a replacement"
    fi
}

node_compose() {
    # Compose only pulls and prepares. Do not echo a parser error that could contain the node key.
    node_docker compose -f "$R$NODE_DIR/docker-compose.yml" --env-file /dev/null \
        --project-name "$NODE_CONTAINER" "$@" >/dev/null 2>&1
}

node_service_unit() {
    cat <<'EOF'
[Unit]
Description=Start the Remnawave node only after its API ACL is verified
BindsTo=docker.service
PartOf=docker.service
Wants=sw-node-api-acl.service
After=docker.service sw-node-api-acl.service
StartLimitIntervalSec=0

[Service]
Type=notify
NotifyAccess=main
RuntimeDirectory=sw-node
RuntimeDirectoryPreserve=yes
ExecStart=/usr/local/sbin/sw-node-lifecycle.sh start
ExecStop=/usr/local/sbin/sw-node-lifecycle.sh stop
ExecStopPost=/usr/local/sbin/sw-node-lifecycle.sh stop
Restart=always
RestartSec=5s

[Install]
WantedBy=docker.service
EOF
}

write_node_service() {
    node_lifecycle_script | write_file "$R$NODE_START_BIN" 755 || die "Could not install the guarded startup helper"
    node_service_unit | write_file "$R$NODE_START_UNIT" 644 || die "Could not install the guarded startup unit"
}

install_node_service() {
    write_node_service
    q systemctl daemon-reload && q systemctl enable sw-node.service || die "Could not register guarded node startup"
}

step_node() {
    title "Remnawave node (docker compose)"
    command -v docker >/dev/null 2>&1 || die "Docker is not installed: run the docker step first"
    if ! is_asked SECRET_KEY && [ "$NONINTERACTIVE" != 1 ]; then
        note "A node that already exists in the panel (redeploy, new server): do not create a new one in the panel; use the SECRET_KEY of the existing node."
    fi
    ask_node_port
    node_port_guard
    panel_destination_guard
    ask_secret
    [ -x "$R$API_ACL_BIN" ] && [ -n "$_confirmed_panel" ] ||
        die "Run the apiacl step for this port before starting the node"
    "$R$API_ACL_BIN" config "$NODE_PORT" "$_confirmed_panel" ||
        die "The saved node ACL does not match; run the apiacl step"
    node_lifecycle backend || die "The Docker firewall backend is not supported"
    quiesce_node
    save_conf node

    (umask 077; mkdir -p "$R$NODE_DIR") || die "Could not create the private node directory"
    secure_secret_backups "$R$NODE_DIR/docker-compose.yml"
    write_file "$R$NODE_DIR/docker-compose.yml" 600 secret <<EOF
services:
  $NODE_CONTAINER:
    container_name: $NODE_CONTAINER
    hostname: $NODE_CONTAINER
    image: remnawave/node:$NODE_IMAGE_TAG
    restart: "no"
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
    # Also when nothing changed: copies that an older installer left still hold a key.
    secure_secret_backups "$R$NODE_DIR/docker-compose.yml"

    run_cmd "Pulling the image remnawave/node:$NODE_IMAGE_TAG" node_compose pull "$NODE_CONTAINER" || die "docker compose pull failed"
    run_cmd "Preparing the stopped node container" node_compose create --no-build "$NODE_CONTAINER" ||
        die "docker compose create failed (no container was started)"
    install_node_service
    docker_service_active || die "docker.service is not active; the node service was not started"
    systemctl restart sw-node.service ||
        die "Guarded node startup failed; see journalctl -u sw-node.service, then retry node at the same port"
    kv "Container" "$(node_docker ps --filter "name=$NODE_CONTAINER" --format '{{.Names}}  {{.Image}}  {{.Status}}')"
}

# ---------------------------------------------------------------- verify

# The checks of a finished node. Exit code 2 when something failed (warnings do not count as a failure).
step_verify() {
    title "Verify the node"
    for _p in NODE_DOMAIN NODE_IP NODE_PORT PANEL_ALLOW_IP; do
        eval "_vc=\${$_p:-}"
        [ -n "$_vc" ] || { _vc=$(conf_get "$_p"); [ -z "$_vc" ] || { param_valid "$_p" "$_vc" && eval "$_p=\$_vc"; }; }
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
    for _u in "docker|Docker" "nginx|nginx" "haproxy|HAProxy" "fail2ban|fail2ban" "sw-certs-reload.path|nginx reload on a new certificate" "sw-node-api-acl.service|Node API port ACL (DOCKER-USER)" "sw-node.service|Guarded node startup"; do
        _un=${_u%%|*}; _ul=${_u#*|}
        _a=$(systemctl is-active "$_un" 2>/dev/null); _e=$(systemctl is-enabled "$_un" 2>/dev/null)
        if [ "$_a" = active ] && { [ "$_un" != sw-node.service ] || [ "$_e" = enabled ]; }; then
            res ok "$_ul" "active, ${_e:-?}"
        else res fail "$_ul" "${_a:-no unit} (${_e:-?})"; fi
    done

    sect "Node container"
    _st=$(node_docker inspect -f '{{.State.Status}}' "$NODE_CONTAINER" 2>/dev/null)
    if [ "$_st" = running ]; then
        _img=$(node_docker inspect -f '{{.Config.Image}}' "$NODE_CONTAINER" 2>/dev/null)
        res ok "Container $NODE_CONTAINER" "running, $_img"
        case "$_img" in *":$NODE_IMAGE_TAG") res ok "Image tag" "$NODE_IMAGE_TAG (as pinned by the installer)" ;; *) res warn "Image tag" "$_img, the installer pins $NODE_IMAGE_TAG" ;; esac
    else
        res fail "Container $NODE_CONTAINER" "${_st:-no container}"
    fi
    if [ "$(node_docker inspect -f '{{range .Config.Env}}{{if eq . "SNI_VERIFICATION=true"}}true{{end}}{{end}}' "$NODE_CONTAINER" 2>/dev/null)" = true ]; then
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
    if _gate=$(node_host_paths 2>&1 && node_lifecycle verify "$_np" 2>&1); then
        res ok "Guarded node lifecycle" "IPv4 binding, Docker restart policy and ACL match"
    else
        res fail "Guarded node lifecycle" "${_gate:-guard verification failed}"
    fi
    # The effective policy: a connection from elsewhere is certainly dropped, and only the panel gets through before that.
    _acl=$(api_acl_check "$_np" "${PANEL_ALLOW_IP:-}")
    case $_acl in
        ok*)
            if [ -n "${PANEL_ALLOW_IP:-}" ]; then
                res ok "Node API port: DOCKER-USER rules" "port $_np: ${_acl#ok }"
            else
                res warn "Node API port: DOCKER-USER rules" "port $_np: ${_acl#ok }; PANEL_ALLOW_IP is not known"
            fi ;;
        warn*) res warn "Node API port: DOCKER-USER rules" "port $_np: ${_acl#warn }" ;;
        *) res fail "Node API port: DOCKER-USER rules" "port $_np: ${_acl#fail }" ;;
    esac
    _ufw_status=$(LC_ALL=C ufw status 2>/dev/null)
    if printf '%s\n' "$_ufw_status" | grep -q '^Status: active'; then
        _ufw_check=$(printf '%s\n' "$_ufw_status" | awk -v p="$_np" -v allowed=" ${PANEL_ALLOW_IP:-} " '
            $1 == p || $1 == p "/tcp" {
                i=2; if ($i == "(v6)") i++
                if ($i != "ALLOW") next
                i++; if ($i == "IN") i++
                if ($i == "OUT" || $i == "FWD") next
                if ($i == "Anywhere" || (allowed != "  " && index(allowed, " " $i " ") == 0)) bad=1
                else if (allowed != "  ") found[$i]=1
            }
            END {
                if (bad) { print "unexpected"; exit }
                n=split(allowed, ips); if (!n) exit
                for (i=1; i<=n; i++) if (!(ips[i] in found)) exit
                print "matched"
            }')
        case $_ufw_check in
            unexpected) res fail "UFW" "active, an unexpected source is allowed on port $_np" ;;
            matched) res ok "UFW" "active, explicit panel rules found for port $_np (Docker is checked separately)" ;;
            *)
                if [ -n "${PANEL_ALLOW_IP:-}" ]; then
                    res warn "UFW" "active, no matching panel TCP rule for port $_np"
                else
                    res warn "UFW" "active, PANEL_ALLOW_IP is not known; panel rules for port $_np were not verified"
                fi ;;
        esac
    else
        res warn "UFW" "not active"
    fi
    if fail2ban-client status sshd >/dev/null 2>&1; then res ok "fail2ban: jail sshd" "active"; else res fail "fail2ban: jail sshd" "not active"; fi
    _prl=$(sshd -T 2>/dev/null | awk '$1=="permitrootlogin"{print $2}')
    if [ "$_prl" = no ]; then res ok "SSH: root login" "closed"; else res warn "SSH: root login" "${_prl:-?} (no expected, ssh step)"; fi
    _pwa=$(sshd -T 2>/dev/null | awk '$1=="passwordauthentication"{print $2}')
    if [ "$_pwa" = no ]; then res ok "SSH: password login" "closed"; else res warn "SSH: password login" "${_pwa:-?} (open; the ssh step with SSH_DISABLE_PASSWORD=yes closes it)"; fi
    # The accounts the ssh step would count as administrators (the same rules it applies before it closes anything).
    ssh_admins_scan
    if [ -n "$ADMINS_OK" ]; then
        if [ -n "$ADMINS_NOT" ]; then res ok "SSH: administrators with key login" "$ADMINS_OK (not counted: $(ssh_admins_why))"; else res ok "SSH: administrators with key login" "$ADMINS_OK"; fi
    elif [ "$_prl" = no ] && [ "$_pwa" = no ]; then
        res fail "SSH: administrators with key login" "none, and root and password login are closed: $(ssh_admins_why)"
    else
        res warn "SSH: administrators with key login" "none, the ssh step would not close root or password login: $(ssh_admins_why)"
    fi

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

# Does the account have a usable password? (adduser --disabled-password leaves it locked: status L.)
has_password() { [ "$(passwd -S "$1" 2>/dev/null | awk '{print $2}')" = P ]; }

# ---- who counts as an administrator
#
# Root login, and password login, may be closed only when somebody else can really log in and administer the server. Being a
# member of the sudo group is not enough (found on a real server: an account of the hosting provider sat in the group, had no
# key, and root login was closed with nobody able to log in). An account counts only when every rule below holds; the first
# rule that fails is its reason, in words, so that the operator knows what to fix.
#   1. It is a real account: it exists, is neither root nor the certificate receiver, has an ordinary user id (UID_MIN to
#      UID_MAX of login.defs, 1000 to 60000 without it) and is a member of the sudo group (as a member or by its primary group).
#   2. sshd lets it in with a key. Asked of `sshd -T -C user=...`, which applies the Match blocks: PubkeyAuthentication is on,
#      AuthenticationMethods does not ask for more than a key, and AllowUsers, DenyUsers, AllowGroups and DenyGroups do not
#      keep it out.
#   3. The account is not disabled: its login shell is a real executable shell (not nologin, not false), its expiry date has not
#      passed, and a locked password is fine only when sshd uses PAM (without PAM sshd refuses a locked account even for a key).
#   4. A key can be read where sshd looks (AuthorizedKeysFile): the file, ~/.ssh and the home directory belong to the account or
#      to root and cannot be written by group or others (StrictModes; skipped when sshd runs without it), the account can read the
#      file, and at least one line is a valid key (ssh-keygen -l) that gives a shell: no command=, and neither restrict nor
#      no-pty unless a later pty switches the terminal on again.
#   5. It can become root: sudo is installed, sudoers does not refuse it, and it has a password or a NOPASSWD rule.

# The path for the screen: the fake root of the tests is not part of what the operator sees.
rp() { printf '%s' "${1#"$R"}"; }

# The words of every line of an `sshd -T` dump that starts with the key $1 (the dump is $2), one per line; and the first word.
sshd_words() { printf '%s\n' "$2" | awk -v k="$1" '$1 == k { for (i = 2; i <= NF; i++) print $i }'; }
sshd_word() { printf '%s\n' "$2" | awk -v k="$1" '$1 == k { print $2; exit }'; }

# ssh_acl_reason NAME DUMP [ADDR]: why AllowUsers, DenyUsers, AllowGroups or DenyGroups keep the account out (nothing when
# they do not). sshd matches the patterns with * and ?, as the patterns of case do. A user@host entry, asked for the loopback
# address (no other is known), is taken by its user part when it allows and ignored when it denies. Asked for the address
# of a real session (ADDR), the host part must match ADDR (a CIDR host part is not read: such an entry does not allow).
ssh_acl_reason() {
    _ar_groups=" $(id -Gn "$1" 2>/dev/null) "
    _ar_addr=${3:-127.0.0.1}
    _ar_list=$(sshd_words denyusers "$2")
    while IFS= read -r _ar_p; do
        [ -n "$_ar_p" ] || continue
        case $_ar_p in
            *@*)
                [ "$_ar_addr" != 127.0.0.1 ] || continue
                _ar_u=${_ar_p%%@*}; _ar_h=${_ar_p#*@}
                # shellcheck disable=SC2254
                case $1 in $_ar_u) ;; *) continue ;; esac
                # A CIDR host part is not read here: it is taken as keeping the account out (refusing is the safe side).
                case $_ar_h in */*) echo "DenyUsers has an entry $_ar_p that this check cannot read (CIDR), taken as keeping it out"; return 0 ;; esac
                # shellcheck disable=SC2254
                case $_ar_addr in $_ar_h) echo "DenyUsers keeps it out from $_ar_addr"; return 0 ;; esac
                continue ;;
        esac
        # shellcheck disable=SC2254
        case $1 in $_ar_p) echo "DenyUsers keeps it out"; return 0 ;; esac
    done <<EOF
$_ar_list
EOF
    _ar_list=$(sshd_words denygroups "$2")
    while IFS= read -r _ar_p; do
        [ -n "$_ar_p" ] || continue
        for _ar_g in $_ar_groups; do
            # shellcheck disable=SC2254
            case $_ar_g in $_ar_p) echo "DenyGroups keeps it out (group $_ar_g)"; return 0 ;; esac
        done
    done <<EOF
$_ar_list
EOF
    _ar_list=$(sshd_words allowusers "$2")
    if [ -n "$_ar_list" ]; then
        _ar_hit=0
        while IFS= read -r _ar_p; do
            _ar_u=${_ar_p%%@*}
            # shellcheck disable=SC2254
            case $1 in $_ar_u) ;; *) continue ;; esac
            case $_ar_p in
                *@*)
                    if [ "$_ar_addr" = 127.0.0.1 ]; then _ar_hit=1; continue; fi
                    _ar_h=${_ar_p#*@}
                    # shellcheck disable=SC2254
                    case $_ar_h in */*) ;; *) case $_ar_addr in $_ar_h) _ar_hit=1 ;; esac ;; esac ;;
                *) _ar_hit=1 ;;
            esac
        done <<EOF
$_ar_list
EOF
        if [ "$_ar_hit" != 1 ]; then
            if [ "$_ar_addr" = 127.0.0.1 ]; then echo "AllowUsers does not list it"; else echo "AllowUsers does not let it in from $_ar_addr"; fi
            return 0
        fi
    fi
    _ar_list=$(sshd_words allowgroups "$2")
    if [ -n "$_ar_list" ]; then
        _ar_hit=0
        while IFS= read -r _ar_p; do
            for _ar_g in $_ar_groups; do
                # shellcheck disable=SC2254
                case $_ar_g in $_ar_p) _ar_hit=1 ;; esac
            done
        done <<EOF
$_ar_list
EOF
        [ "$_ar_hit" = 1 ] || { echo "AllowGroups does not list any of its groups"; return 0; }
    fi
    return 0
}

# ssh_path_reason PATH UID: why StrictModes would refuse the path (it must belong to the account or to root and must not be
# writable by group or others); nothing when it is fine.
ssh_path_reason() {
    _pr_m=$(stat -L -c '%a' "$1" 2>/dev/null) || { echo "cannot read the mode of $(rp "$1")"; return 0; }
    _pr_o=$(stat -L -c '%u' "$1" 2>/dev/null) || { echo "cannot read the owner of $(rp "$1")"; return 0; }
    case $_pr_o in 0|"$2") ;; *) echo "$(rp "$1") is owned by user id $_pr_o, not by the account or root (StrictModes)"; return 0 ;; esac
    if [ $((0$_pr_m & 022)) -ne 0 ]; then
        echo "$(rp "$1") can be written by group or others, mode $_pr_m (StrictModes)"
    fi
    return 0
}

# ssh_key_survey FILE: prints "GOOD FORCED RESTRICTED INVALID", the number of lines of an authorized_keys file that give a
# shell by key, that force a command (command=), that have no terminal (restrict or no-pty, with no pty after it), and that are
# not a key at all (ssh-keygen -l refuses a copy of the line). Other options (from=, no-agent-forwarding ...) do not matter.
# SSH_KEY_AWK reads lines of an authorized_keys file and prints, for each line that is not empty or a comment, its class
# (plain: gives a shell; forced: command=; restricted: no terminal) and a tab, then the key with its comment.
SSH_KEY_AWK='
            { line = $0; n = length(line); i = 1
              while (i <= n && (substr(line, i, 1) == " " || substr(line, i, 1) == "\t")) i++
              if (i > n || substr(line, i, 1) == "#") next
              start = i; q = 0
              for (; i <= n; i++) {
                  c = substr(line, i, 1)
                  if (c == "\\" && q) { i++; continue }
                  if (c == "\"") { q = !q; continue }
                  if (!q && (c == " " || c == "\t")) break
              }
              first = substr(line, start, i - start); rest = substr(line, i); sub(/^[ \t]+/, "", rest)
              if (first ~ /^(ssh-|ecdsa-|sk-)/) { opts = ""; key = first " " rest } else { opts = first; key = rest }
              pty = 1; cmd = 0; lim = 0; m = length(opts); q = 0; cur = ""
              for (j = 1; j <= m + 1; j++) {
                  c = (j <= m) ? substr(opts, j, 1) : ","
                  if (c == "\\" && q) { cur = cur c substr(opts, j + 1, 1); j++; continue }
                  if (c == "\"") { q = !q; cur = cur c; continue }
                  if (c == "," && !q) {
                      name = tolower(cur); sub(/=.*/, "", name)
                      if (name == "command") cmd = 1
                      else if (name == "restrict" || name == "no-pty") pty = 0
                      else if (name == "pty") pty = 1
                      else if (name == "from" || name == "expiry-time" || name == "cert-authority" || name == "principals") lim = 1
                      cur = ""; continue
                  }
                  cur = cur c
              }
              class = cmd ? "forced" : (pty ? "plain" : "restricted")
              print class "\t" key "\t" lim
            }'
ssh_key_survey() {
    _ks_g=0; _ks_f=0; _ks_r=0; _ks_i=0
    _ks_t=$(mktemp) || return 1
    _ks_tab=$(printf '\t')
    while IFS= read -r _ks_l || [ -n "$_ks_l" ]; do
        _ks_c=$(printf '%s\n' "$_ks_l" | awk "$SSH_KEY_AWK")
        [ -n "$_ks_c" ] || continue
        _ks_k=${_ks_c#*"$_ks_tab"}
        printf '%s\n' "${_ks_k%"$_ks_tab"*}" >"$_ks_t"
        if ! ssh-keygen -l -f "$_ks_t" >/dev/null 2>&1 </dev/null; then _ks_i=$((_ks_i + 1)); continue; fi
        case ${_ks_c%%"$_ks_tab"*} in
            plain) _ks_g=$((_ks_g + 1)) ;;
            forced) _ks_f=$((_ks_f + 1)) ;;
            *) _ks_r=$((_ks_r + 1)) ;;
        esac
    done <"$1"
    rm -f "$_ks_t"
    printf '%s %s %s %s\n' "$_ks_g" "$_ks_f" "$_ks_r" "$_ks_i"
}

# ssh_keys_reason FILE HOME UID STRICT: why the key file gives no administrator access (nothing when a line does).
ssh_keys_reason() {
    _kr_f=$1
    [ -e "$_kr_f" ] || { echo "$(rp "$_kr_f") does not exist: no key"; return 0; }
    [ -f "$_kr_f" ] || { echo "$(rp "$_kr_f") is not a regular file"; return 0; }
    if [ "$4" = yes ]; then
        _kr_w=$(ssh_path_reason "$_kr_f" "$3")
        if [ -z "$_kr_w" ]; then
            # The account must be able to read it (sshd opens the file as the account).
            _kr_m=$(stat -L -c '%a' "$_kr_f" 2>/dev/null)
            _kr_o=$(stat -L -c '%u' "$_kr_f" 2>/dev/null)
            if [ "$_kr_o" = "$3" ]; then _kr_need=256; else _kr_need=4; fi
            [ $((0$_kr_m & _kr_need)) -ne 0 ] || _kr_w="$(rp "$_kr_f") cannot be read by the account (mode $_kr_m)"
        fi
        if [ -z "$_kr_w" ]; then
            case $_kr_f in
                "$2"/*)
                    _kr_d=$(dirname "$_kr_f")
                    while :; do
                        _kr_w=$(ssh_path_reason "$_kr_d" "$3")
                        [ -z "$_kr_w" ] || break
                        [ "$_kr_d" != "$2" ] || break
                        _kr_d=$(dirname "$_kr_d")
                        [ "$_kr_d" != / ] && [ "$_kr_d" != . ] || break
                    done ;;
            esac
        fi
        [ -z "$_kr_w" ] || { echo "$_kr_w"; return 0; }
    fi
    read -r _kr_g _kr_c _kr_r _kr_i <<EOF
$(ssh_key_survey "$_kr_f")
EOF
    [ "${_kr_g:-0}" -eq 0 ] || return 0
    _kr_p=
    [ "${_kr_c:-0}" -eq 0 ] || _kr_p="$_kr_p, ${_kr_c} with a forced command (command=)"
    [ "${_kr_r:-0}" -eq 0 ] || _kr_p="$_kr_p, ${_kr_r} without a terminal (restrict or no-pty)"
    [ "${_kr_i:-0}" -eq 0 ] || _kr_p="$_kr_p, ${_kr_i} that are not a valid key"
    if [ -z "$_kr_p" ]; then echo "$(rp "$_kr_f") holds no key"; else echo "$(rp "$_kr_f") holds no key that gives a shell (${_kr_p#, })"; fi
    return 0
}

# ssh_keyfile_path TOKEN NAME UID HOME: an AuthorizedKeysFile entry with %h %u %U %% replaced; relative ones are in the home.
ssh_keyfile_path() {
    _kp_x=$1; _kp_o=
    while [ -n "$_kp_x" ]; do
        case $_kp_x in
            '%%'*) _kp_o="$_kp_o%"; _kp_x=${_kp_x#'%%'} ;;
            '%h'*) _kp_o="$_kp_o$4"; _kp_x=${_kp_x#'%h'} ;;
            '%u'*) _kp_o="$_kp_o$2"; _kp_x=${_kp_x#'%u'} ;;
            '%U'*) _kp_o="$_kp_o$3"; _kp_x=${_kp_x#'%U'} ;;
            *) _kp_c=${_kp_x%"${_kp_x#?}"}; _kp_o="$_kp_o$_kp_c"; _kp_x=${_kp_x#?} ;;
        esac
    done
    case $_kp_o in /*) ;; *) _kp_o="$4/$_kp_o" ;; esac
    printf '%s' "$_kp_o"
}

# ssh_admin_check NAME [ADDR]: 0 when the account counts as an administrator (the rules above) for a login from ADDR (default:
# the loopback address); otherwise 1 and ADMIN_WHY says why. On success ADMIN_KEYFILES lists the key files sshd reads for it
# (one per line), and ADMIN_HOME, ADMIN_UID and ADMIN_STRICT describe it.
ordinary_uid_reason() {
    _uid_min=$(sed -n 's/^UID_MIN[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' "$R/etc/login.defs" 2>/dev/null | head -n 1)
    _uid_max=$(sed -n 's/^UID_MAX[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' "$R/etc/login.defs" 2>/dev/null | head -n 1)
    : "${_uid_min:=1000}" "${_uid_max:=60000}"
    case $1 in ''|*[!0-9]*) echo "its user id is not a number"; return ;; esac
    if ! { [ "$1" -ge "$_uid_min" ] && [ "$1" -le "$_uid_max" ]; }; then
        echo "user id $1 is not an ordinary account ($_uid_min to $_uid_max)"
    fi
}

ssh_admin_check() {
    ADMIN_WHY=; ADMIN_KEYFILES=
    _ac_n=$1
    _ac_addr=${2:-127.0.0.1}
    _ac_host=$_ac_addr; [ "$_ac_addr" != 127.0.0.1 ] || _ac_host=localhost
    case $_ac_n in
        root) ADMIN_WHY="root is not counted: the point is a second way in"; return 1 ;;
        "$CERT_USER") ADMIN_WHY="$CERT_USER only receives certificates (a restricted key)"; return 1 ;;
    esac
    _ac_pw=$(getent passwd "$_ac_n" 2>/dev/null)
    [ -n "$_ac_pw" ] || { ADMIN_WHY="the account does not exist (the group lists a name that passwd does not know)"; return 1; }
    _ac_uid=$(printf '%s\n' "$_ac_pw" | cut -d: -f3)
    _ac_home=$(printf '%s\n' "$_ac_pw" | cut -d: -f6)
    _ac_shell=$(printf '%s\n' "$_ac_pw" | cut -d: -f7)
    ADMIN_WHY=$(ordinary_uid_reason "$_ac_uid")
    [ -z "$ADMIN_WHY" ] || return 1
    case $_ac_shell in
        */nologin|*/false) ADMIN_WHY="its login shell is $(rp "$_ac_shell"): no session can be opened"; return 1 ;;
    esac
    [ -n "$_ac_shell" ] || _ac_shell=/bin/sh
    [ -x "$_ac_shell" ] || { ADMIN_WHY="its login shell $(rp "$_ac_shell") is missing or not executable"; return 1; }

    # sshd's own view of this account (the Match blocks are applied).
    _ac_cfg=$(sshd -T -C "user=$_ac_n,host=$_ac_host,addr=$_ac_addr" 2>/dev/null) || { ADMIN_WHY="sshd -T does not accept the configuration"; return 1; }
    [ "$(sshd_word pubkeyauthentication "$_ac_cfg")" != no ] || { ADMIN_WHY="sshd has PubkeyAuthentication off for it"; return 1; }
    _ac_am=$(sshd_words authenticationmethods "$_ac_cfg")
    if [ -n "$_ac_am" ]; then
        _ac_ok=0
        for _ac_m in $_ac_am; do case $_ac_m in any|publickey) _ac_ok=1 ;; esac; done
        [ "$_ac_ok" = 1 ] || { ADMIN_WHY="AuthenticationMethods asks for more than a key ($_ac_am)"; return 1; }
    fi
    _ac_r=$(ssh_acl_reason "$_ac_n" "$_ac_cfg" "$_ac_addr")
    [ -z "$_ac_r" ] || { ADMIN_WHY=$_ac_r; return 1; }

    # Locked, expired, inactive.
    case $(passwd -S "$_ac_n" 2>/dev/null | awk '{print $2}') in
        L|LK) [ "$(sshd_word usepam "$_ac_cfg")" != no ] || { ADMIN_WHY="its password is locked and sshd runs without PAM, which refuses a locked account even for a key"; return 1; } ;;
    esac
    _ac_sh=$(getent shadow "$_ac_n" 2>/dev/null)
    if [ -n "$_ac_sh" ]; then
        _ac_r=$(printf '%s\n' "$_ac_sh" | awk -F: -v t="$(($(date +%s) / 86400))" '
            $8 != "" && $8 + 0 >= 0 && t >= $8 + 0 { print "the account has expired"; exit }
            $5 != "" && $5 + 0 < 99999 && $7 != "" && $7 + 0 >= 0 && t > $3 + $5 + $7 { print "its password expired and the inactivity period has passed, so the account is locked out"; exit }')
        [ -z "$_ac_r" ] || { ADMIN_WHY=$_ac_r; return 1; }
    fi

    # A key that sshd reads and accepts.
    _ac_strict=$(sshd_word strictmodes "$_ac_cfg"); [ "$_ac_strict" = no ] || _ac_strict=yes
    command -v ssh-keygen >/dev/null 2>&1 || { ADMIN_WHY="ssh-keygen is not installed, so the keys cannot be checked"; return 1; }
    _ac_files=$(sshd_words authorizedkeysfile "$_ac_cfg")
    [ -n "$_ac_files" ] || _ac_files=".ssh/authorized_keys .ssh/authorized_keys2"
    _ac_first=; _ac_found=0; _ac_any=0; _ac_paths=
    for _ac_t in $_ac_files; do
        [ "$_ac_t" != none ] || continue
        _ac_paths="$_ac_paths$(ssh_keyfile_path "$_ac_t" "$_ac_n" "$_ac_uid" "$_ac_home")$NL"
    done
    for _ac_t in $_ac_files; do
        [ "$_ac_t" != none ] || continue
        _ac_any=1
        _ac_f=$(ssh_keyfile_path "$_ac_t" "$_ac_n" "$_ac_uid" "$_ac_home")
        _ac_r=$(ssh_keys_reason "$_ac_f" "$_ac_home" "$_ac_uid" "$_ac_strict")
        if [ -z "$_ac_r" ]; then _ac_found=1; break; fi
        # A file that is not there is only the reason when no other file is: the first existing one tells more.
        case $_ac_r in *"does not exist"*) [ -n "$_ac_first" ] || _ac_first=$_ac_r ;; *) _ac_first=$_ac_r; break ;; esac
    done
    if [ "$_ac_found" != 1 ]; then
        if [ "$_ac_any" = 0 ]; then ADMIN_WHY="sshd reads no key file (AuthorizedKeysFile none)"; else ADMIN_WHY=$_ac_first; fi
        return 1
    fi

    # Becoming root.
    command -v sudo >/dev/null 2>&1 || { ADMIN_WHY="sudo is not installed, so it cannot become root"; return 1; }
    _ac_sl=$(sudo -n -l -U "$_ac_n" 2>&1)
    case $_ac_sl in *"is not allowed to run sudo"*) ADMIN_WHY="sudoers does not let it run sudo"; return 1 ;; esac
    if ! has_password "$_ac_n"; then
        case $_ac_sl in *NOPASSWD*) ;; *) ADMIN_WHY="sudo would ask for a password and the account has none (locked or empty), and no NOPASSWD rule applies"; return 1 ;; esac
    fi
    ADMIN_KEYFILES=$_ac_paths; ADMIN_HOME=$_ac_home; ADMIN_UID=$_ac_uid; ADMIN_STRICT=$_ac_strict
    return 0
}

# ssh_has_key KEY: 0 when KEY (type and key, the comment does not matter) is a line that gives a shell in a key file that sshd
# reads for the account of the last successful ssh_admin_check, and that file passes the checks of rule 4.
ssh_has_key() {
    _hk_want=$(printf '%s\n' "$1" | awk '{ print $1 " " $2 }')
    _hk_tab=$(printf '\t')
    while IFS= read -r _hk_f; do
        [ -n "$_hk_f" ] && [ -f "$_hk_f" ] || continue
        [ -z "$(ssh_keys_reason "$_hk_f" "$ADMIN_HOME" "$ADMIN_UID" "$ADMIN_STRICT")" ] || continue
        # A line with from= or expiry-time= does not count: the installer does not evaluate those limits.
        if awk "$SSH_KEY_AWK" "$_hk_f" | awk -F "$_hk_tab" -v w="$_hk_want" '$1 == "plain" && $NF == "0" { split($2, k, " "); if (k[1] " " k[2] == w) f = 1 } END { exit !f }'; then
            return 0
        fi
    done <<EOF
$ADMIN_KEYFILES
EOF
    return 1
}

# ssh_named_admin NAME KEY: 0 when the administrator the operator named counts and KEY gives it a shell; otherwise 1 and
# ADMIN_WHY says why. sshd is asked for a login from the address of every open SSH session, or from loopback if there are none.
ssh_named_admin() {
    ssh_admin_candidates | grep -qxF "$1" || { ADMIN_WHY="$1 is not an administrator: it is not in the sudo group (run the user phase)"; return 1; }
    # The named key itself must be a key (a valid key beside it in the file proves nothing about it).
    _na_t=$(mktemp) || { ADMIN_WHY="mktemp failed"; return 1; }
    printf '%s\n' "$2" >"$_na_t"
    if ! ssh-keygen -l -f "$_na_t" >/dev/null 2>&1 </dev/null; then
        rm -f "$_na_t"; ADMIN_WHY="NEW_USER_PUBKEY is not a valid public key (ssh-keygen refuses it)"; return 1
    fi
    rm -f "$_na_t"
    # Every address an SSH session comes from must work: the session of this run cannot be told from the others, and the
    # one that works could be somebody else's (refusing is the safe side).
    _na_o=$(ssh_origins) || { ADMIN_WHY="could not read open SSH sessions"; return 1; }
    [ -n "$_na_o" ] || _na_o=127.0.0.1
    for _na_a in $_na_o; do
        _na_from=; [ "$_na_a" = 127.0.0.1 ] || _na_from=" (for a login from $_na_a)"
        if ! ssh_admin_check "$1" "$_na_a"; then
            ADMIN_WHY="$1 cannot be shown to log in: $ADMIN_WHY$_na_from"; return 1
        fi
        if ! ssh_has_key "$2" "$_na_a"; then
            ADMIN_WHY="$1 cannot be shown to log in: the key given as NEW_USER_PUBKEY is not in a key file of $1 that sshd reads, as a line that gives a shell (from= and expiry-time= are not read, so such a line does not count)$_na_from"
            return 1
        fi
    done
    return 0
}

# The accounts the sudo group gives sudo to, one per line: its members, and the accounts whose primary group it is.
ssh_admin_candidates() {
    _sc_g=$(getent group sudo 2>/dev/null)
    _sc_id=$(printf '%s\n' "$_sc_g" | cut -d: -f3)
    {
        printf '%s\n' "$_sc_g" | cut -d: -f4 | tr ',' '\n'
        [ -z "$_sc_id" ] || getent passwd 2>/dev/null | awk -F: -v g="$_sc_id" '$4 == g { print $1 }'
    } | sed '/^$/d' | sort -u
}

# ssh_admins_scan: ADMINS_OK is the list of the accounts that count, ADMINS_NOT one "name: reason" line for each one that does
# not, ADMINS_N the number of accounts examined.
ssh_admins_scan() {
    ADMINS_OK=; ADMINS_NOT=; ADMINS_N=0
    for _as_c in $(ssh_admin_candidates); do
        ADMINS_N=$((ADMINS_N + 1))
        if ssh_admin_check "$_as_c"; then ADMINS_OK="$ADMINS_OK $_as_c"; else ADMINS_NOT="$ADMINS_NOT$_as_c: $ADMIN_WHY$NL"; fi
    done
    ADMINS_OK=${ADMINS_OK# }
}

# The reasons of the last scan on one line.
ssh_admins_why() {
    if [ "$ADMINS_N" -eq 0 ]; then printf 'the sudo group has no members'; return 0; fi
    printf '%s' "$ADMINS_NOT" | sed '/^$/d' | tr '\n' ';' | sed 's/;/; /g; s/; $//'
}

# Shows who counts; nothing is changed. Printed before anything is closed, so the operator sees it first.
ssh_admins_show() {
    ssh_admins_scan
    if [ -n "$ADMINS_OK" ]; then
        ok "Administrators who can log in with a key: $ADMINS_OK"
        _ss_f=note
    else
        _ss_f=warn
        if [ "$ADMINS_N" -eq 0 ]; then warn "The sudo group has no members: nobody but root can administer this server"; fi
    fi
    while IFS= read -r _ss_l; do
        [ -z "$_ss_l" ] || "$_ss_f" "not counted: $_ss_l"
    done <<EOF
$ADMINS_NOT
EOF
    [ -n "$ADMINS_OK" ] || warn "No administrator can log in with a key: root login and password login will not be closed"
    return 0
}

# ssh_refuse WHAT: stops the run because no administrator can log in (the scan has been made and shown); the message itself
# names every account that was examined and the reason it does not count.
ssh_refuse() {
    if [ "$ADMINS_N" -eq 0 ]; then
        die "Refusing to close $1. The sudo group has no members: run the user phase first (closing it now would lose access)"
    fi
    die "Refusing to close $1: no member of the sudo group can log in with a key. Examined: $(ssh_admins_why). Fix that and run the step again, or leave it open (SSH_DISABLE_ROOT=no, SSH_DISABLE_PASSWORD=no)"
}

# An administrator with sudo and keys, then closing root login and, only if asked, password login. SSH_PHASE: user (the account and
# its keys), root (the closing), all. A caller that logs in as the new account between the two phases cannot lose access.
# Safety: root login and password login are closed only when an administrator can really log in (the rules above: not just a
# member of the sudo group), the accounts that count and those that do not, with the reason, are shown before anything is
# closed, the administrator the operator names (NEW_USER) must hold the key the operator names (NEW_USER_PUBKEY), and the
# change undoes itself unless it is shown to work (ssh_close). The current session is never touched (restart keeps it).
step_ssh() {
    title "SSH: administrator account, keys, root and password login"
    _phase=$SSH_PHASE
    if [ "$_phase" != root ]; then
        warn "Do not close this session until you have checked the login of the new account"
        ask NEW_USER "Administrator account name"
        ask NEW_USER_PUBKEY "Public SSH key of the administrator"
        ask NEW_USER_PUBKEY2 "Backup public SSH key" "" optional

        if id "$NEW_USER" >/dev/null 2>&1; then
            _user_record=$(getent passwd "$NEW_USER") || die "Cannot inspect the existing account $NEW_USER"
            _user_reason=$(ordinary_uid_reason "$(printf '%s\n' "$_user_record" | cut -d: -f3)")
            [ -z "$_user_reason" ] || die "Refusing to modify $NEW_USER: $_user_reason"
        else
            # sudo asks for a password: an account without one would be an administrator who cannot administer.
            if [ -z "${NEW_USER_PASSWORD:-}" ] && [ "$NONINTERACTIVE" = 1 ]; then
                die "NEW_USER_PASSWORD is required without a terminal when the account is created (sudo needs a password): give it, or NEW_USER_PASSWORD_FILE"
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
        grep -qxF "$NEW_USER_PUBKEY" "$_home/.ssh/authorized_keys" || append_line "$_home/.ssh/authorized_keys" "$NEW_USER_PUBKEY"
        if [ -n "${NEW_USER_PUBKEY2:-}" ]; then
            grep -qxF "$NEW_USER_PUBKEY2" "$_home/.ssh/authorized_keys" || append_line "$_home/.ssh/authorized_keys" "$NEW_USER_PUBKEY2"
        fi
        chown "$NEW_USER:" "$_home/.ssh/authorized_keys"
        chmod 600 "$_home/.ssh/authorized_keys"
        ok "keys of $NEW_USER written ($(grep -c . "$_home/.ssh/authorized_keys") in authorized_keys)"
    fi
    # Who can administer this server? Shown before anything is closed (and, after the user phase, what is still missing).
    ssh_admins_show
    [ "$_phase" = user ] && return 0

    # Never close root login while nobody else can really log in. The question is not asked when the answer cannot be yes.
    _d=n; [ "$SSH_DISABLE_ROOT" = yes ] && _d=y
    if [ -z "$ADMINS_OK" ] && [ "$_d" = y ]; then ssh_refuse "root login"; fi
    _close_root=0
    if confirm "Close root login over SSH (PermitRootLogin no)?" "$_d"; then
        [ -n "$ADMINS_OK" ] || ssh_refuse "root login"
        _close_root=1
    fi
    # Close password login only when a key login works: otherwise access can be lost.
    _d=n; [ "$SSH_DISABLE_PASSWORD" = yes ] && _d=y
    if [ -z "$ADMINS_OK" ] && [ "$_d" = y ]; then ssh_refuse "password login"; fi
    _close_pw=0
    if confirm "Close password login (keys only)? Check a key login in another window first" "$_d"; then
        [ -n "$ADMINS_OK" ] || ssh_refuse "password login"
        _close_pw=1
    fi
    [ "$_close_root$_close_pw" = 00 ] || ssh_close "$_close_root" "$_close_pw"
}

# ssh_close ROOT PASSWORD (1 or 0 each): closes root login and/or password login as one change that undoes itself unless it is
# shown to work. First the evidence, before anything is written: the administrator named by NEW_USER counts (the rules above),
# for a login from where the open SSH sessions come from, and the key NEW_USER_PUBKEY, which the operator holds, gives it a
# shell. Then a rollback is armed (a systemd timer that puts the saved files back and restarts sshd after SSH_RB_SECONDS),
# the files are written, `sshd -t` must accept them and `sshd -T` must show the new values in effect and still let that
# administrator in with that key, and sshd is restarted and must be running. A fresh login and root access must be confirmed
# from a second window before the rollback is disarmed. An interrupted run leaves the timer armed.
ssh_close() {
    _cl_what="root login"; [ "$1" = 1 ] || _cl_what="password login"
    [ "$1$2" != 11 ] || _cl_what="root login and password login"
    ask NEW_USER "Administrator who must be able to log in (its key login is checked before anything is closed)"
    ask NEW_USER_PUBKEY "Public SSH key you log in with as $NEW_USER"
    ssh_named_admin "$NEW_USER" "$NEW_USER_PUBKEY" || die "Refusing to close $_cl_what: $ADMIN_WHY. Nothing was changed"
    [ "$NONINTERACTIVE" != 1 ] || die "Closing $_cl_what requires a terminal to confirm a fresh SSH login and root access. Nothing was changed in sshd"
    warn "Before proceeding, make a fresh SSH connection in another window as $NEW_USER with that key, verify that sudo id -u prints 0, and leave that session open."
    confirm "Did that login work and sudo id -u print 0 before the change?" n ||
        die "No existing login was confirmed. Nothing was changed in sshd"

    command -v systemctl >/dev/null 2>&1 || die "Refusing to close $_cl_what: systemctl is missing, so no automatic rollback can be armed. Nothing was changed"
    command -v flock >/dev/null 2>&1 || die "Refusing to close $_cl_what: flock is missing, so the change and its rollback cannot be kept apart. Nothing was changed"
    exec 8>>"$R$SSH_RB_LOCK" || die "Cannot open $SSH_RB_LOCK. Nothing was changed"
    flock -n 8 || die "Another SSH change or its rollback is in progress. Nothing was changed"
    # A receipt is written only after the restored service is checked and the units are removed.
    if [ -f "$R$SSH_RB_DIR.completed" ]; then
        [ "$(cat "$R$SSH_RB_DIR.completed")" = restored ] && sshd -t && ssh_service_active ||
            die "Cannot verify completed SSH rollback cleanup; the remaining state was retained"
        rm -rf "$R$SSH_RB_DIR" && rm -f "$R$SSH_RB_DIR.completed" ||
            die "Could not finish removing the completed SSH rollback snapshot"
    fi
    _cl_state=$(ssh_rb_state)
    if [ -e "$R$SSH_RB_DIR/done" ] &&
       { [ "$_cl_state" != rollback ] || [ ! -f "$R$SSH_RB_DIR/done" ]; }; then
        die "Contradictory SSH rollback completion state; the snapshot was retained for console recovery"
    fi
    if [ "$_cl_state" = keep ]; then
        ssh_rollback_cleanup || die "Could not clean up the confirmed SSH change; use the console"
    fi
    if [ "$(systemctl is-active "$SSH_RB_UNIT.timer" 2>/dev/null)" = active ] || [ "$(systemctl is-active "$SSH_RB_UNIT.service" 2>/dev/null)" = active ]; then
        die "The automatic SSH rollback of an earlier run is still pending ($SSH_RB_UNIT.timer): let it run, then start again. Nothing was changed"
    fi
    if [ "$_cl_state" = rollback ] && [ -f "$R$SSH_RB_DIR/done" ]; then
        # Never execute a legacy script to decide whether its own completion marker is valid.
        ssh_rollback_cleanup_restored || die "Could not verify or clean up the completed SSH rollback; see $LOG_FILE"
    fi
    if [ -d "$R$SSH_RB_DIR" ] && [ ! -f "$R$SSH_RB_DIR/done" ]; then
        if [ ! -e "$R$SSH_RB_DIR/claim" ] && [ ! -e "$R/etc/systemd/system/$SSH_RB_UNIT.timer" ] &&
            [ ! -e "$R/etc/systemd/system/$SSH_RB_UNIT.service" ]; then
            rm -rf "$R$SSH_RB_DIR" || die "Could not remove an unarmed SSH rollback snapshot"
            note "removed an unarmed SSH rollback snapshot"
        else
            die "An incomplete SSH rollback needs recovery from the console ($SSH_RB_DIR). Nothing was changed"
        fi
    fi
    q systemctl reset-failed "$SSH_RB_UNIT.service" "$SSH_RB_UNIT.timer"
    ssh_rollback_prepare || die "Could not save the SSH configuration for the rollback. Nothing was changed"
    if ! ssh_rollback_arm || ! ssh_rb_record pending; then
        ssh_rollback_cleanup || warn "Could not remove the unused rollback plan; inspect $SSH_RB_DIR from the console"
        die "Could not arm the automatic rollback. Nothing was changed in sshd"
    fi
    _cl_t0=$(date +%s)
    note "automatic rollback armed: unless this run confirms the change, the old SSH configuration comes back in $SSH_RB_SECONDS s"

    if [ "$1" = 1 ]; then
        if [ -f "$R/etc/ssh/sshd_config" ]; then
            backup_file "$R/etc/ssh/sshd_config"
            sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' "$R/etc/ssh/sshd_config"
        fi
        # A drop-in of sshd_config.d is read first and wins over the main file.
        echo "PermitRootLogin no" | write_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    fi
    if [ "$2" = 1 ]; then
        printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | write_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
    fi
    sshd -t || ssh_rollback_now norestart "sshd -t: configuration error, the change was reverted"
    _cl_why=$(ssh_effective_reason "$1" "$2")
    [ -z "$_cl_why" ] || ssh_rollback_now norestart "sshd -T: $_cl_why; the change was reverted"
    systemctl restart ssh 2>/dev/null || systemctl restart sshd || ssh_rollback_now restart "Could not restart SSH; the old configuration is back"
    ssh_service_active || ssh_rollback_now restart "sshd is not running after the restart; the old configuration is back"
    [ "$1" = 1 ] && ok "root login over SSH is closed (sessions stay open)"
    [ "$2" = 1 ] && ok "password login is closed"

    # Do not block the timer while waiting for the operator's answer.
    flock -u 8 || ssh_rollback_now restart "Could not release the SSH rollback lock"
    warn "Keep this session open. In a second window make a fresh SSH connection as $NEW_USER with that key and check that sudo id -u prints 0."
    confirm "Did the fresh login as $NEW_USER work and sudo id -u print 0? (No, or no answer in $SSH_RB_SECONDS s, undoes the change)" n \
        || ssh_rollback_now restart "Not confirmed: the old SSH configuration is back"
    ssh_rollback_disarm
}

# ssh_rollback_prepare: saves the SSH files the step may change, and writes the script that puts them back (a file that did not
# exist is removed again) and restarts sshd (not with the argument norestart). The paths are written out in full.
#
# The step and the script never act at the same time: both hold the lock SSH_RB_LOCK while they change anything (the step
# releases it before it waits for an answer). A stale job cannot act on a different generation. On confirmation the
# timer can clean up its own units but cannot restore the previous files.
ssh_rollback_prepare() {
    _rb=$R$SSH_RB_DIR
    rm -rf "$_rb" || return 1
    ( umask 077; mkdir -p "$_rb" ) || return 1
    _rb_generation=$(mktemp "$_rb/.generation.XXXXXX") || return 1
    _rb_i=0
    {
        printf '#!/bin/sh\n# Written by the Swellwright node installer (ssh step): puts the SSH configuration back as it was and restarts sshd.\n'
        printf "D='%s'\n" "$_rb"
        printf "G='%s'\nU='%s'\n" "$_rb_generation" "$R/etc/systemd/system/$SSH_RB_UNIT"
        printf "J='%s'\nS='%s'\n" "$LOG_FILE" "$R/etc/ssh"
        # From the timer (the step runs it with "claimed" while it holds the lock itself).
        printf "if [ \"\${2:-}\" != claimed ]; then\n    exec 8>>'%s' || exit 1\n    flock 8 || exit 1\n" "$R$SSH_RB_LOCK"
        cat <<'EOF'
fi
[ -f "$G" ] || exit 0
automatic=0
[ "${1:-}" != automatic ] || automatic=1
report() {
    line="$(date -u +%Y-%m-%dT%H:%M:%SZ) Automatic SSH rollback: $*"
    printf '%s\n' "$line" >&2
    (umask 077; printf '%s\n' "$line" >>"$J")
}
restore_failed() {
    if [ "$automatic" = 1 ]; then
        report "incomplete ($1); snapshot retained at $D"
    else
        printf 'SSH rollback: incomplete (%s); snapshot retained at %s\n' "$1" "$D" >&2
    fi
    exit 1
}
restored_service_active() {
    [ "$(systemctl is-active ssh 2>/dev/null)" = active ] ||
        [ "$(systemctl is-active sshd 2>/dev/null)" = active ]
}
cleanup_completed() {
    if [ -f "$U.timer" ]; then
        systemctl stop sw-ssh-rollback.timer && systemctl disable sw-ssh-rollback.timer || return 1
    fi
    rm -f "$U.timer" "$U.service" && systemctl daemon-reload && sync -f "$(dirname "$U")" || return 1
    # Keep proof of completion outside the snapshot until recursive deletion is finished.
    # If interrupted, absence of files inside the snapshot is not mistaken for an incomplete restore.
    receipt=$(mktemp "$D.completed.XXXXXX") || return 1
    if ! { printf 'restored\n' >"$receipt" && mv -fT "$receipt" "$D.completed" && sync -f "$(dirname "$D")"; }; then
        rm -f "$receipt"
        return 1
    fi
    rm -rf "$D" && rm -f "$D.completed"
}
finish_automatic() {
    # A previous run may have restored SSH but stopped during unit cleanup.
    sshd -t && restored_service_active || restore_failed "the restored service is not healthy"
    sync -f "$D" || restore_failed "could not sync completion"
    report "restored original configuration; SSH service is active" && sync -f "$J" || exit 1
    if ! cleanup_completed; then
        report "cleanup incomplete; inspect $D and $D.completed"
        exit 1
    fi
    report "cleanup complete"
}
if [ -f "$D.completed" ]; then
    if [ "$automatic" = 1 ]; then
        [ "$(cat "$D.completed")" = restored ] && sshd -t && restored_service_active ||
            restore_failed "cannot verify completed cleanup"
        if ! { rm -rf "$D" && rm -f "$D.completed"; }; then
            report "cleanup incomplete; inspect $D and $D.completed"
            exit 1
        fi
        report "cleanup complete"
    fi
    exit $?
fi
state=
if [ -e "$D/claim" ]; then state=$(cat "$D/claim") || exit 1; fi
if [ -e "$D/done" ]; then
    [ "$state" = rollback ] && [ -f "$D/done" ] ||
        restore_failed "contradictory rollback completion state"
    [ "$automatic" != 1 ] || finish_automatic
    exit $?
fi
case "$state" in
    keep|'')
        # No SSH change was armed, or it was confirmed. Never restore files in either case.
        systemctl stop sw-ssh-rollback.timer &&
            systemctl disable sw-ssh-rollback.timer &&
            rm -f "$U.timer" "$U.service" &&
            systemctl daemon-reload && rm -rf "$D"
        exit $? ;;
    pending|rollback) ;;
    *) exit 1 ;;
esac
claim=$(mktemp "$D/.claim.XXXXXX") || restore_failed "cannot stage recovery state"
trap 'rm -f "$claim"' EXIT
printf 'rollback\n' >"$claim" && mv -fT "$claim" "$D/claim" && sync -f "$D" || restore_failed "cannot persist recovery state"
ok=1
EOF
        for _rb_f in $SSH_RB_FILES; do
            _rb_i=$((_rb_i + 1))
            if [ -f "$R$_rb_f" ]; then
                cp -p "$R$_rb_f" "$_rb/$_rb_i" || return 1
                printf "cp -p '%s' '%s' || ok=0\n" "$_rb/$_rb_i" "$R$_rb_f"
            else
                printf "rm -f '%s' || ok=0\n" "$R$_rb_f"
            fi
        done
        cat <<'EOF'
[ "$ok" = 1 ] || restore_failed "could not restore configuration files"
sshd -t || restore_failed "sshd rejected the restored configuration"
if [ "${1:-}" != norestart ]; then
    attempt=1
    while :; do
        if { systemctl restart ssh 2>/dev/null || systemctl restart sshd; } &&
            restored_service_active; then break; fi
        [ "$attempt" -lt 3 ] || restore_failed "could not restart the restored SSH service"
        attempt=$((attempt + 1))
        sleep 2
    done
fi
restored_service_active || restore_failed "the restored SSH service is not active"
sync -f "$S" || restore_failed "could not sync the restored configuration"
: >"$D/done" || restore_failed "could not record completion"
if [ "$automatic" = 1 ]; then
    finish_automatic
fi
EOF
    } >"$_rb/rollback.sh" || return 1
    return 0
}

ssh_rollback_arm() (
    # OnActiveSec starts counting when the enabled timer starts, both now and at boot.
    # OnBootSec would expire immediately when first enabled on a host already up for 300 seconds.
    write_file "$R/etc/systemd/system/$SSH_RB_UNIT.timer" <<EOF
[Unit]
Description=Deadline for Swellwright SSH hardening confirmation
[Timer]
OnActiveSec=${SSH_RB_SECONDS}s
AccuracySec=1s
RemainAfterElapse=no
[Install]
WantedBy=timers.target
EOF
    write_file "$R/etc/systemd/system/$SSH_RB_UNIT.service" <<EOF
[Unit]
Description=Restore the previous Swellwright SSH configuration
[Service]
Type=oneshot
ExecStart=/bin/sh $SSH_RB_DIR/rollback.sh automatic
EOF
    q systemctl daemon-reload &&
        q systemctl enable --now "$SSH_RB_UNIT.timer" &&
        [ "$(systemctl is-active "$SSH_RB_UNIT.timer" 2>/dev/null)" = active ] &&
        sync -f "$R/etc/systemd/system"
)

ssh_rollback_cleanup() {
    # Do not remove the script or backup if systemd did not stop or disable the timer.
    _cleanup_unit=$R/etc/systemd/system/$SSH_RB_UNIT
    if [ -f "$_cleanup_unit.timer" ]; then
        q systemctl stop "$SSH_RB_UNIT.timer" && q systemctl disable "$SSH_RB_UNIT.timer" || return 1
    elif [ "$(systemctl is-active "$SSH_RB_UNIT.timer" 2>/dev/null)" = active ]; then
        q systemctl stop "$SSH_RB_UNIT.timer" || return 1
    fi
    rm -f "$_cleanup_unit.timer" "$_cleanup_unit.service" && q systemctl daemon-reload || return 1
    if [ "${1:-}" = restored ]; then
        (
            _done_tmp=$(mktemp "$R$SSH_RB_DIR.completed.XXXXXX") || exit 1
            trap 'rm -f "$_done_tmp"' EXIT
            printf 'restored\n' >"$_done_tmp" && mv -fT "$_done_tmp" "$R$SSH_RB_DIR.completed" &&
                sync -f "$(dirname "$R$SSH_RB_DIR")"
        ) || return 1
    fi
    rm -rf "$R$SSH_RB_DIR" || return 1
    [ "${1:-}" != restored ] || rm -f "$R$SSH_RB_DIR.completed"
}

# The lock of the SSH change, taken again after the question (the timer's rollback, if it runs, finishes first).
ssh_rb_lock() { flock 8; }
ssh_rb_state() { cat "$R$SSH_RB_DIR/claim" 2>/dev/null; }
ssh_rollback_cleanup_restored() {
    [ "$(ssh_rb_state)" = rollback ] && [ -f "$R$SSH_RB_DIR/done" ] &&
        sshd -t && ssh_service_active || return 1
    note "Cleaning up a verified SSH rollback; the restored service is active"
    ssh_rollback_cleanup restored
}
ssh_rb_record() (
    _claim=$(mktemp "$R$SSH_RB_DIR/.claim.XXXXXX") || exit 1
    trap 'rm -f "$_claim"' EXIT
    printf '%s\n' "$1" >"$_claim" &&
        mv -fT "$_claim" "$R$SSH_RB_DIR/claim" &&
        sync -f "$R$SSH_RB_DIR"
)

# ssh_rollback_now MODE MESSAGE: puts the old configuration back at once (MODE restart or norestart) and stops. The timer is
# stopped only when that worked: a rollback that did not complete, or a run killed in between, leaves it as a second chance.
ssh_rollback_now() {
    ssh_rb_lock || die "Cannot lock the SSH rollback; use the console"
    { [ -d "$R$SSH_RB_DIR" ] && [ ! -f "$R$SSH_RB_DIR.completed" ]; } ||
        die "The automatic rollback plan is gone; check SSH and the journal ($LOG_FILE). The change was not confirmed"
    if [ -f "$R$SSH_RB_DIR/done" ]; then
        ssh_rollback_cleanup_restored ||
            die "$2; rollback completion could not be verified; the remaining snapshot was retained"
        die "$2 (the automatic rollback had already put the old configuration back)"
    fi
    if sh "$R$SSH_RB_DIR/rollback.sh" "$1" claimed >>"$LOG_FILE" 2>&1; then
        ssh_rollback_cleanup_restored ||
            die "$2; rollback completion or cleanup could not be verified; check the remaining state from the console"
        die "$2"
    fi
    die "$2; but the rollback did not complete: the saved files stay in $SSH_RB_DIR; check SSH from the console (journal: $LOG_FILE)"
}

# ssh_rollback_disarm: the change is kept, unless the timer's rollback came first (then that is reported).
ssh_rollback_disarm() {
    ssh_rb_lock || die "Cannot lock the SSH rollback; use the console"
    { [ -d "$R$SSH_RB_DIR" ] && [ ! -f "$R$SSH_RB_DIR.completed" ]; } ||
        die "The automatic rollback plan is gone; check SSH and the journal ($LOG_FILE). The change was not confirmed"
    # Check under the lock, even if the timer has not run yet.
    [ $(($(date +%s) - _cl_t0)) -lt "$SSH_RB_SECONDS" ] \
        || ssh_rollback_now restart "Confirmed after the $SSH_RB_SECONDS s of the rollback: the old SSH configuration is back"
    if [ -e "$R$SSH_RB_DIR/done" ]; then
        ssh_rollback_cleanup_restored ||
            die "SSH rollback completion could not be verified; the remaining snapshot was retained"
        die "The automatic rollback has already run: the old SSH configuration is back. Run the step again"
    fi
    if [ "$(ssh_rb_state)" = rollback ]; then
        die "The automatic rollback started and did not complete: the saved files stay in $SSH_RB_DIR (journal: $LOG_FILE)"
    fi
    # Commit the decision before stopping an enabled timer. A crash or reboot during cleanup cannot undo it.
    [ "$(ssh_rb_state)" = pending ] || die "Cannot confirm SSH without a pending rollback plan"
    ssh_rb_record keep || die "Could not persist the SSH confirmation; use the console"
    if ssh_rollback_cleanup; then
        ok "the change is kept (the automatic rollback is disarmed)"
    else
        warn "The SSH change is kept, but rollback cleanup is incomplete; a later timer run can clean up without restoring SSH"
    fi
    return 0
}

# ssh_effective_reason ROOT PASSWORD: why the configuration sshd would now load does not do what was asked or no longer lets the
# named administrator in (nothing when it is fine).
ssh_effective_reason() {
    _ef=$(sshd -T 2>/dev/null) || { echo "sshd -T does not accept the configuration"; return 0; }
    if [ "$1" = 1 ] && [ "$(sshd_word permitrootlogin "$_ef")" != no ]; then
        echo "PermitRootLogin is $(sshd_word permitrootlogin "$_ef") in effect, not no (another file wins)"; return 0
    fi
    if [ "$2" = 1 ]; then
        [ "$(sshd_word passwordauthentication "$_ef")" = no ] || { echo "PasswordAuthentication is still on in effect (another file wins)"; return 0; }
        _ef_kb=$(sshd_word kbdinteractiveauthentication "$_ef")
        [ -z "$_ef_kb" ] || [ "$_ef_kb" = no ] || { echo "KbdInteractiveAuthentication is still on in effect (another file wins)"; return 0; }
    fi
    # A Match block may set these again for some connections; the installer does not try to read every case: it refuses.
    _ef_k=; [ "$1" = 1 ] && _ef_k=permitrootlogin
    # ChallengeResponseAuthentication is the older name of KbdInteractiveAuthentication; sshd still reads it.
    [ "$2" = 1 ] && _ef_k="$_ef_k passwordauthentication kbdinteractiveauthentication challengeresponseauthentication"
    # An Include other than the stock sshd_config.d/*.conf, or one inside a Match block, is a file this scan does not read.
    _ef_m=$(for _ef_f in "$R/etc/ssh/sshd_config" "$R"/etc/ssh/sshd_config.d/*.conf; do [ -f "$_ef_f" ] && awk -v f="$(rp "$_ef_f")" -v keys=" $_ef_k " '
        tolower($1) == "match" { m = 1 }
        tolower($1) == "include" && (m || NF != 2 || $2 != "/etc/ssh/sshd_config.d/*.conf") { print f ": " $0 " (an Include this check does not read)"; exit }
        m && index(keys, " " tolower($1) " ") && tolower($2) != "no" { print f ": " $1 " " $2; exit }' "$_ef_f"; done | head -n 1)
    [ -z "$_ef_m" ] || { echo "a Match block or an Include could set the login methods again (${_ef_m}); resolve it by hand"; return 0; }
    # The values in effect for a root login and a login of the administrator from where the sessions come from.
    _ef_o=$(ssh_origins) || { echo "could not read open SSH sessions"; return 0; }
    [ -n "$_ef_o" ] || _ef_o=127.0.0.1
    for _ef_a in $_ef_o; do
        _ef_h=$_ef_a; [ "$_ef_a" != 127.0.0.1 ] || _ef_h=localhost
        for _ef_u in root "$NEW_USER"; do
            _ef_c=$(sshd -T -C "user=$_ef_u,host=$_ef_h,addr=$_ef_a" 2>/dev/null) || { echo "sshd -T -C does not accept the configuration"; return 0; }
            if [ "$1" = 1 ] && [ "$_ef_u" = root ] && [ "$(sshd_word permitrootlogin "$_ef_c")" != no ]; then
                echo "PermitRootLogin is $(sshd_word permitrootlogin "$_ef_c") for root from $_ef_a"; return 0
            fi
            if [ "$2" = 1 ] && [ "$(sshd_word passwordauthentication "$_ef_c")" != no ]; then
                echo "PasswordAuthentication is still on for $_ef_u from $_ef_a"; return 0
            fi
            _ef_kb=$(sshd_word kbdinteractiveauthentication "$_ef_c")
            if [ "$2" = 1 ] && [ -n "$_ef_kb" ] && [ "$_ef_kb" != no ]; then
                echo "KbdInteractiveAuthentication is still on for $_ef_u from $_ef_a"; return 0
            fi
        done
    done
    ssh_named_admin "$NEW_USER" "$NEW_USER_PUBKEY" || echo "with the new configuration, $ADMIN_WHY"
    return 0
}

ssh_service_active() {
    [ "$(systemctl is-active ssh 2>/dev/null)" = active ] || [ "$(systemctl is-active sshd 2>/dev/null)" = active ]
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

    with_config_backup rename_write_config "$R/etc/nginx/conf.d/default.conf" \
        "$R/etc/nginx/conf.d/selfsni.conf" "$R/etc/haproxy/haproxy.cfg" ||
        die "The rename configuration was not applied"

    hostnamectl set-hostname "$_new" || die "hostnamectl failed"
    _short=${_new%%.*}; _fshort=${_from%%.*}
    if awk -v of="$_from" '{ for (i = 2; i <= NF; i++) if ($i == of) f = 1 } END { exit !f }' "$R/etc/hosts" 2>/dev/null; then
        _tmp=$(mktemp) || die "mktemp failed"
        awk -v of="$_from" -v nf="$_new" -v os="$_fshort" -v ns="$_short" '
            { hit = 0; for (i = 2; i <= NF; i++) if ($i == of) hit = 1
              if (hit) for (i = 2; i <= NF; i++) { if ($i == of) $i = nf; else if ($i == os) $i = ns }
              print }' "$R/etc/hosts" >"$_tmp" || die "awk failed"
        if cmp -s "$_tmp" "$R/etc/hosts"; then
            note "/etc/hosts already has $_new"
        else
            backup_file "$R/etc/hosts"
            cat "$_tmp" >"$R/etc/hosts"
            ok "/etc/hosts: $_from -> $_new"
        fi
        rm -f "$_tmp"
    elif [ -n "${NODE_IP:-}" ]; then
        backup_file "$R/etc/hosts"
        append_line "$R/etc/hosts" "$NODE_IP $_new $_short"
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

rename_write_config() {
    for _rename_file in "$R/etc/nginx/conf.d/default.conf" "$R/etc/nginx/conf.d/selfsni.conf"; do
        edit_if_changed "$_rename_file" "s/^\\([[:space:]]*server_name\\)[[:space:]].*;/\\1 $_names;/" ||
            die "Could not update ${_rename_file#"$R"}"
    done
    edit_if_changed "$R/etc/haproxy/haproxy.cfg" "s/^\\([[:space:]]*use_backend xray_vless if { req_ssl_sni -i \\)[^}]*}/\\1$_names }/" ||
        die "Could not update HAProxy"
    _o=$(nginx -t 2>&1) || { printf '%s\n' "$_o" | dimcat; die "nginx -t: configuration error"; }
    _o=$(haproxy -c -f "$R/etc/haproxy/haproxy.cfg" 2>&1) || { printf '%s\n' "$_o" | dimcat; die "haproxy -c: configuration error"; }
    ok "nginx -t and haproxy -c: the configurations are valid"
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
    todo 8 "The image tag is pinned ($NODE_IMAGE_TAG). To update: set NODE_IMAGE_TAG and rerun the node step at the same port; do not start the node with Compose."
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
    ask_domain; ask_node_ip; ask_node_port; ask_ssh_port; ask_panel_ip; ask_certsync_pubkey optional
    node_port_guard
    ask_secret
    _full_panel=$(confirmed_panel)
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
    # Package upgrades can restart Docker. Disarm an old node before the first package step.
    quiesce_node
    save_conf full
    _rf=$(mktemp) || die "mktemp failed"
    VERIFY_STAT=$(mktemp) || die "mktemp failed"
    _t_all=$(date +%s)
    STEP_TOTAL=$_n; STEP_N=0
    for _ph in $_phases; do
        STEP_N=$((STEP_N + 1))
        _t0=$(date +%s)
        (
            if [ "$_ph" = firewall ] && [ -n "$_full_panel" ] &&
               [ "$(panel_set "$PANEL_ALLOW_IP")" != "$(panel_set "$_full_panel")" ]; then
                PANEL_ALLOW_IP=$_full_panel
                DEFER_PANEL_UFW=1
            fi
            "step_$_ph"
        ); _rc=$?
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
  ${C_C}ssh${C_0}             administrator, keys, close root and password login once an administrator can log in (not in full)
  ${C_C}rename${C_0}          rename the node on this server (NODE_DOMAIN = new, RENAME_FROM, RENAME_ALIAS)
  ${C_C}verify${C_0}          read-only checks of a finished node (exit code 2 on a failure)
${C_Y}${C_B}Help${C_0}
  ${C_C}menu${C_0}  ${C_C}help${C_0}  ${C_C}version${C_0}  ${C_C}demo${C_0} (shows the appearance, changes nothing)

${C_B}Options:${C_0}  --env-file FILE (NAME=value lines, mode 600, never executed)   --non-interactive
             --secret-file NAME=PATH (a secret from a file, mode 600: SECRET_KEY, NEW_USER_PASSWORD; same as NAME_FILE=PATH)
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
    if node_docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$NODE_CONTAINER"; then
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
            --secret-file) [ $# -ge 2 ] || die "--secret-file needs NAME=PATH"; secret_file_option "$2"; shift 2 ;;
            --secret-file=*) secret_file_option "${1#*=}"; shift ;;
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
    [ "$RUN_UID" = 0 ] || [ -n "$R" ] || die "Root is needed: sudo sh install.sh $ACTION"

    # The read-only actions never ask anything, so they never need a terminal.
    case $ACTION in preflight|verify) NONINTERACTIVE=1 ;; esac
    if [ "$NONINTERACTIVE" != 1 ]; then
        _tin=/dev/tty; _tout=/dev/tty
        if [ -n "$R" ]; then _tin=${SW_TTY_IN:-$_tin}; _tout=${SW_TTY_OUT:-$_tout}; fi
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
    _supplied_panel=${PANEL_ALLOW_IP:-}
    [ -f "$CONF_FILE" ] && load_params_file "$CONF_FILE" lenient
    if [ -z "$_supplied_panel" ] && [ -f "$R$API_ACL_CONF" ]; then
        PANEL_ALLOW_IP=$(confirmed_panel)
    fi
    case $ACTION in preflight|verify) ;; *) resolve_secret_files ;; esac
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
