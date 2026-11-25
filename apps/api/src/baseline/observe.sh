#!/bin/sh
# swellwright-baseline: schema 1
#
# The script Swellwright runs on a managed server to make the observations of a baseline check (ADR 0045). One script,
# one run, one SSH session. Its SHA-256 is stored with every run, so the history shows which script made which result.
#
# What it promises:
#   - read-only: it writes no file, changes no setting, starts and stops nothing, installs nothing, and never prints a
#     secret: it reads the NAMES of environment variables of a container, never the values (except four that are not
#     secret and are named in the catalogue), the fingerprints of authorized keys, never the keys, and the hash of a file,
#     never its content;
#   - no network access beyond the machine: a request goes to loopback or to the own address of the machine, and the
#     name of the machine is resolved once; package counts come from the lists already on the disk;
#   - bounded: every external program gets a deadline when timeout(1) exists, every list is cut to a fixed length and
#     every line to 400 bytes;
#   - plain POSIX sh (dash is enough), LC_ALL=C so that the output is the same in every language.
#
# What it reads: the plan on its standard input, one observation per line, fields separated by TAB:
#   INDEX TAB KIND [TAB NAME=VALUE]...
# Every parameter was checked by the caller against the pattern of the catalogue before it was sent, and reaches a
# command only as a quoted word, never as shell code.
#
# What it prints (the caller parses it strictly; whatever it does not know is ignored):
#   @@swb v1
#   @@swb epoch SECONDS            the clock of the server when the script began
#   @@swb uid UID
#   @@swb begin INDEX KIND
#   | field=value                  every line of an observation begins with "| ": a value that looks like a marker
#   | field=value                  is still only a value
#   @@swb end INDEX STATUS         0 ok, 11 needs root, 99 unknown kind, anything else: the observation failed
#   @@swb done
# A value is one line, with control characters removed and at most 400 bytes. A list is the same field repeated.

LC_ALL=C
export LC_ALL
PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH
# Whatever the tools complain about is not data.
exec 2>/dev/null
# The real standard output, so that the filter of an observation can write to it while the status is captured.
exec 3>&1
# Nothing in this script wants a glob: a value that holds a star stays a value.
set -f

# R is empty on a server. The tests of Swellwright point it at a directory with a captured file tree.
R=${SWB_ROOT:-}
TAB=$(printf '\t')
IS_ROOT=0
[ "$(id -u)" = 0 ] && IS_ROOT=1
MAX_LINES=200

have() { command -v "$1" >/dev/null 2>&1; }

# Runs a program with a deadline when timeout(1) is there: bounded SECONDS PROGRAM ARGS...
bounded() {
  _limit=$1
  shift
  if have timeout; then timeout "$_limit" "$@"; else "$@"; fi
}

# One line of an observation: kv FIELD VALUE. The only way anything is printed, so a value can never be two lines.
kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr -d '\000-\037\177' | cut -b1-400)"; }
yn() { if [ "$1" = 1 ]; then printf 'yes'; else printf 'no'; fi; }
need_root() { [ "$IS_ROOT" = 1 ]; }
now() { date -u +%s; }

# A number from tool output, or 0.
num() { case $1 in '' | *[!0-9]*) printf '0' ;; *) printf '%s' "$1" ;; esac; }

# ---- the observations ---------------------------------------------------------------------------------------------
# Each is the function obs_<kind with dots as underscores>. It prints fields with kv and returns 0, 11 when it needs
# root and has none, or another status when it failed.

os_value() { sed -n "s/^$1=//p" "$2" | head -n 1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
obs_os_release() {
  _f=$R/etc/os-release
  [ -r "$_f" ] || _f=$R/usr/lib/os-release
  [ -r "$_f" ] || return 1
  kv id "$(os_value ID "$_f")"
  kv versionId "$(os_value VERSION_ID "$_f")"
  kv name "$(os_value NAME "$_f")"
  kv codename "$(os_value VERSION_CODENAME "$_f")"
  kv prettyName "$(os_value PRETTY_NAME "$_f")"
}

obs_kernel() {
  _run=$(uname -r)
  kv running "$_run"
  _latest=$(ls "$R/boot" 2>/dev/null | sed -n 's/^vmlinuz-//p' | sort -V | tail -n 1)
  kv latestInstalled "$_latest"
  _behind=0
  if [ -n "$_latest" ] && [ "$_latest" != "$_run" ]; then
    [ "$(printf '%s\n%s\n' "$_run" "$_latest" | sort -V | tail -n 1)" = "$_latest" ] && _behind=1
  fi
  kv behind "$(yn "$_behind")"
  _req=0
  if [ -e "$R/var/run/reboot-required" ] || [ -e "$R/run/reboot-required" ]; then _req=1; fi
  kv rebootRequired "$(yn "$_req")"
  for _p in "$R/var/run/reboot-required.pkgs" "$R/run/reboot-required.pkgs"; do
    if [ -r "$_p" ]; then
      head -n 20 "$_p" | sort -u | while IFS= read -r _line; do kv rebootPackages "$_line"; done
      break
    fi
  done
}

obs_uptime() {
  [ -r "$R/proc/uptime" ] || return 1
  kv seconds "$(num "$(awk '{ print int($1) }' "$R/proc/uptime")")"
}

obs_time_sync() {
  _sync=no
  _tz=
  if have timedatectl; then
    [ "$(bounded 5 timedatectl show -p NTPSynchronized --value)" = yes ] && _sync=yes
    _tz=$(bounded 5 timedatectl show -p Timezone --value)
  fi
  [ -n "$_tz" ] || _tz=$(head -n 1 "$R/etc/timezone" 2>/dev/null)
  kv synchronized "$_sync"
  kv timezone "$_tz"
  _svc=none
  if have systemctl; then
    for _u in chrony systemd-timesyncd ntp ntpd; do
      if [ "$(bounded 5 systemctl is-active "$_u")" = active ]; then
        _svc=$_u
        [ "$_u" = ntp ] && _svc=ntpd
        break
      fi
    done
  fi
  kv service "$_svc"
  if have chronyc; then
    _off=$(bounded 5 chronyc tracking | awk '/^System time/ { v = $4; if (v + 0 == v) print v }')
    [ -z "$_off" ] || kv offsetSeconds "$_off"
  fi
}

obs_disk_usage() {
  _p=${P_path:-/}
  _line=$(bounded 10 df -P -k "$_p" | tail -n 1)
  [ -n "$_line" ] || return 1
  kv mountpoint "$(printf '%s\n' "$_line" | awk '{ $1 = $2 = $3 = $4 = $5 = ""; sub(/^ +/, ""); print }')"
  kv usedPercent "$(num "$(printf '%s\n' "$_line" | awk '{ v = $5; sub(/%/, "", v); print v }')")"
  kv availableMiB "$(num "$(printf '%s\n' "$_line" | awk '{ print int($4 / 1024) }')")"
  _inode=$(bounded 10 df -P -i "$_p" | tail -n 1 | awk '{ v = $5; sub(/%/, "", v); print v }')
  kv inodeUsedPercent "$(num "$_inode")"
}

obs_memory() {
  [ -r "$R/proc/meminfo" ] || return 1
  awk '
    /^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } /^MemFree:/ { f = $2 }
    /^SwapTotal:/ { st = $2 } /^SwapFree:/ { sf = $2 }
    END {
      if (a == "") a = f
      printf "totalMiB=%d\navailableMiB=%d\n", t / 1024, a / 1024
      printf "availablePercent=%d\n", (t > 0 ? a * 100 / t : 0)
      printf "swapTotalMiB=%d\n", st / 1024
      printf "swapUsedPercent=%d\n", (st > 0 ? (st - sf) * 100 / st : 0)
    }' "$R/proc/meminfo"
}

obs_updates_pending() {
  if ! have apt-get; then
    kv manager none
    return 0
  fi
  kv manager apt
  _sim=$(bounded 20 apt-get -s -o Debug::NoLocking=1 -o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache= upgrade) || return 1
  kv upgradable "$(num "$(printf '%s\n' "$_sim" | grep -c '^Inst ')")"
  kv security "$(num "$(printf '%s\n' "$_sim" | grep '^Inst ' | grep -c -e '-security')")"
  _stamp=$R/var/lib/apt/periodic/update-success-stamp
  _m=
  if [ -e "$_stamp" ]; then
    _m=$(stat -c %Y "$_stamp")
  else
    _newest=$(ls -t "$R/var/lib/apt/lists" 2>/dev/null | grep -v -e '^lock$' -e '^partial$' | head -n 1)
    [ -z "$_newest" ] || _m=$(stat -c %Y "$R/var/lib/apt/lists/$_newest")
  fi
  case $_m in '' | *[!0-9]*) ;; *) kv listAgeSeconds "$(($(now) - _m))" ;; esac
}

obs_updates_auto() {
  _inst=0
  if have dpkg && dpkg -s unattended-upgrades 2>/dev/null | grep -q '^Status: install ok installed'; then _inst=1; fi
  kv installed "$(yn "$_inst")"
  _en=0
  if have apt-config; then
    _v=$(apt-config dump 2>/dev/null | sed -n 's/^APT::Periodic::Unattended-Upgrade "\(.*\)";$/\1/p' | head -n 1)
    case $_v in '' | 0) ;; *) _en=1 ;; esac
  fi
  kv enabled "$(yn "$_en")"
  _t=0
  if have systemctl && [ "$(bounded 5 systemctl is-active apt-daily-upgrade.timer)" = active ]; then _t=1; fi
  kv timerActive "$(yn "$_t")"
}

obs_systemd_failed() {
  have systemctl || return 1
  _state=$(bounded 5 systemctl is-system-running)
  kv state "${_state:-unknown}"
  # The status of systemctl itself is kept: a list that could not be read is a failed observation, not "none failed".
  _raw=$(bounded 5 systemctl --failed --no-legend --plain --no-pager) || return 1
  _list=$(printf '%s\n' "$_raw" | awk 'NF { print $1 }' | head -n "$MAX_LINES")
  if [ -z "$_list" ]; then
    kv failedCount 0
  else
    kv failedCount "$(printf '%s\n' "$_list" | wc -l | tr -d ' ')"
    printf '%s\n' "$_list" | head -n 20 | while IFS= read -r _u; do kv units "$_u"; done
  fi
}

obs_service_state() {
  have systemctl || return 1
  _u=${P_unit:-}
  [ -n "$_u" ] || return 1
  _show=$(bounded 5 systemctl show -p LoadState -p ActiveState -p UnitFileState "$_u")
  _load=$(printf '%s\n' "$_show" | sed -n 's/^LoadState=//p')
  _act=$(printf '%s\n' "$_show" | sed -n 's/^ActiveState=//p')
  _enb=$(printf '%s\n' "$_show" | sed -n 's/^UnitFileState=//p')
  if [ "$_load" = loaded ]; then kv exists yes; else kv exists no; fi
  kv active "${_act:-unknown}"
  kv enabled "${_enb:-unknown}"
}

# The listening sockets of a protocol (tcp or udp), as ss prints them: State Recv-Q Send-Q Local Peer [Process]. Fails
# when ss fails (an old ss without -H is asked again without it), so that a caller never takes "could not list" for
# "nothing listens".
listening() {
  if [ "$1" = udp ]; then _flag=-lunp; else _flag=-ltnp; fi
  if _ss=$(bounded 10 ss -H "$_flag"); then
    [ -z "$_ss" ] || printf '%s\n' "$_ss"
    return 0
  fi
  _ss=$(bounded 10 ss "$_flag") || return 1
  printf '%s\n' "$_ss" | tail -n +2
}
# The address of a local-address column without its port: [::]:22 -> ::, 0.0.0.0:22 -> 0.0.0.0, *:22 -> *
addr_of() { printf '%s' "${1%:*}" | sed -e 's/^\[//' -e 's/\]$//'; }
is_loopback() { case $1 in 127.* | ::1) return 0 ;; *) return 1 ;; esac; }

obs_port_listener() {
  have ss || return 1
  _port=${P_port:-}
  [ -n "$_port" ] || return 1
  _proto=${P_proto:-tcp}
  _sockets=$(listening "$_proto") || return 1
  _rows=$(printf '%s\n' "$_sockets" | awk -v want="$_port" 'NF { n = split($4, a, ":"); if (a[n] == want) print }')
  if [ -z "$_rows" ]; then
    kv listening no
    kv publicly no
    return 0
  fi
  kv listening yes
  _addrs=$(printf '%s\n' "$_rows" | awk '{ a = $4; sub(/:[0-9]+$/, "", a); gsub(/^\[|\]$/, "", a); print a }' | sort -u | head -n 20)
  printf '%s\n' "$_addrs" | while IFS= read -r _a; do kv addresses "$_a"; done
  _pub=0
  for _a in $_addrs; do
    is_loopback "$_a" || _pub=1
  done
  kv publicly "$(yn "$_pub")"
  printf '%s\n' "$_rows" | grep -o '("[^"]*"' | sed -e 's/^("//' -e 's/"$//' | sort -u | head -n 10 | while IFS= read -r _p; do kv processes "$_p"; done
}

obs_ports_public() {
  have ss || return 1
  _tcp=$(listening tcp) || return 1
  _udp=$(listening udp) || return 1
  _all=$({
    printf '%s\n' "$_tcp" | awk 'NF { print "tcp " $4 }'
    printf '%s\n' "$_udp" | awk 'NF { print "udp " $4 }'
  } | while read -r _proto _local; do
    _a=$(addr_of "$_local")
    is_loopback "$_a" && continue
    printf '%s/%s\n' "$_proto" "${_local##*:}"
  done | sort -u | head -n "$MAX_LINES")
  [ -z "$_all" ] || printf '%s\n' "$_all" | while IFS= read -r _p; do kv ports "$_p"; done
  if [ -z "$_all" ]; then kv count 0; else kv count "$(printf '%s\n' "$_all" | wc -l | tr -d ' ')"; fi
}

obs_ufw_status() {
  need_root || return 11
  if ! have ufw; then
    kv installed no
    kv active no
    return 0
  fi
  kv installed yes
  _out=$(bounded 10 ufw status verbose) || return 1
  if printf '%s\n' "$_out" | grep -q '^Status: active'; then kv active yes; else kv active no; fi
  kv defaultIncoming "$(printf '%s\n' "$_out" | sed -n 's/^Default: *\([a-z]*\) (incoming).*/\1/p' | head -n 1)"
  _rules=$(printf '%s\n' "$_out" | awk '/^--/ { on = 1; next } on && NF { gsub(/[ \t]+/, " "); sub(/^ /, ""); sub(/ $/, ""); print }' | head -n "$MAX_LINES")
  if [ -z "$_rules" ]; then
    kv ruleCount 0
  else
    kv ruleCount "$(printf '%s\n' "$_rules" | wc -l | tr -d ' ')"
    printf '%s\n' "$_rules" | while IFS= read -r _r; do kv rules "$_r"; done
  fi
}

obs_iptables_chain() {
  need_root || return 11
  _chain=${P_chain:-DOCKER-USER}
  if ! have iptables; then
    kv exists no
    return 0
  fi
  _out=$(bounded 10 iptables -w 5 -S "$_chain")
  if [ -z "$_out" ]; then
    kv exists no
    return 0
  fi
  kv exists yes
  _rules=$(printf '%s\n' "$_out" | grep '^-A ' | head -n 100)
  if [ -z "$_rules" ]; then
    kv ruleCount 0
    kv text ""
  else
    kv ruleCount "$(printf '%s\n' "$_rules" | wc -l | tr -d ' ')"
    printf '%s\n' "$_rules" | while IFS= read -r _r; do kv rules "$_r"; done
    kv text "$(printf '%s\n' "$_rules" | tr '\n' ';' | cut -b1-2000)"
  fi
}

obs_fail2ban_status() {
  need_root || return 11
  if ! have fail2ban-client; then
    kv installed no
    kv active no
    return 0
  fi
  kv installed yes
  _out=$(bounded 10 fail2ban-client status)
  if [ -z "$_out" ]; then
    kv active no
    return 0
  fi
  kv active yes
  _jails=$(printf '%s\n' "$_out" | sed -n 's/.*Jail list:[ \t]*//p' | tr ',' '\n' | tr -d ' \t' | grep -E '^[A-Za-z0-9_.-]+$' | head -n 20)
  _banned=0
  for _j in $_jails; do
    kv jails "$_j"
    _n=$(bounded 10 fail2ban-client status "$_j" | sed -n 's/.*Currently banned:[ \t]*//p' | head -n 1)
    _banned=$((_banned + $(num "$_n")))
  done
  kv bannedCount "$_banned"
}

obs_sshd_effective() {
  need_root || return 11
  have sshd || return 1
  _dump=$(bounded 10 sshd -T) || return 1
  [ -n "$_dump" ] || return 1
  for _k in port permitrootlogin passwordauthentication pubkeyauthentication kbdinteractiveauthentication \
    permitemptypasswords maxauthtries logingracetime x11forwarding usepam allowusers allowgroups \
    authenticationmethods clientaliveinterval; do
    kv "$_k" "$(printf '%s\n' "$_dump" | awk -v k="$_k" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }')"
  done
}

obs_ssh_keys() {
  need_root || return 11
  have ssh-keygen || return 1
  _total=0
  _invalid=0
  # root and every account with a login shell; the home directory is the one the account database says.
  for _acct in $(getent passwd | awk -F: '$1 == "root" || ($3 >= 1000 && $3 < 60000 && $7 !~ /(nologin|false)$/) { print $1 ":" $6 }'); do
    _name=${_acct%%:*}
    _home=${_acct#*:}
    _file=$_home/.ssh/authorized_keys
    [ -r "$_file" ] || continue
    _count=0
    while IFS= read -r _line; do
      _pair=$(printf '%s\n' "$_line" | awk '
        /^[ \t]*#/ || !NF { next }
        {
          for (i = 1; i < NF; i++)
            if ($i ~ /^(ssh-rsa|ssh-dss|ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/ && length($(i + 1)) > 40 && $(i + 1) ~ /^[A-Za-z0-9+\/]+=*$/) {
              print $i " " $(i + 1)
              exit
            }
          print "invalid"
        }')
      [ -n "$_pair" ] || continue
      if [ "$_pair" = invalid ]; then
        _invalid=$((_invalid + 1))
        continue
      fi
      _fp=$(printf '%s\n' "$_pair" | bounded 5 ssh-keygen -l -f - -E sha256 | awk '{ t = $NF; gsub(/[()]/, "", t); print $2 " " t }')
      if [ -z "$_fp" ]; then
        _invalid=$((_invalid + 1))
        continue
      fi
      _count=$((_count + 1))
      _total=$((_total + 1))
      [ "$_total" -gt 200 ] || kv keys "$_name $_fp"
    done <"$_file"
    [ "$_count" -eq 0 ] || kv accounts "$_name"
  done
  kv total "$_total"
  kv invalid "$_invalid"
}

obs_sudoers() {
  need_root || return 11
  if [ -f "$R/etc/sudoers" ]; then kv present yes; else kv present no; fi
  _drop=$(ls "$R/etc/sudoers.d" 2>/dev/null | grep -E '^[A-Za-z0-9._-]+$' | grep -v '^README$' | head -n 50)
  [ -z "$_drop" ] || printf '%s\n' "$_drop" | while IFS= read -r _f; do kv dropIns "$_f"; done
  {
    cat "$R/etc/sudoers" 2>/dev/null
    for _f in $_drop; do
      # sudo itself skips names with a dot or a tilde.
      case $_f in *.* | *~) continue ;; esac
      cat "$R/etc/sudoers.d/$_f" 2>/dev/null
    done
  } | awk '!/^[ \t]*#/ && /NOPASSWD/ && $1 !~ /^Defaults/ { print $1 }' | sort -u | head -n 50 | while IFS= read -r _s; do kv nopasswd "$_s"; done
}

obs_users_login() {
  _rows=$(getent passwd | awk -F: '$7 != "" && $7 !~ /(nologin|false|sync|shutdown|halt)$/ { print $1 ":" $3 }' | head -n 100)
  [ -z "$_rows" ] || printf '%s\n' "$_rows" | while IFS= read -r _r; do kv accounts "$_r"; done
  if [ -z "$_rows" ]; then kv count 0; else kv count "$(printf '%s\n' "$_rows" | wc -l | tr -d ' ')"; fi
  getent passwd | awk -F: '$3 == 0 { print $1 }' | head -n 10 | while IFS= read -r _r; do kv uidZero "$_r"; done
  if need_root && [ -r "$R/etc/shadow" ]; then
    # An empty value says "looked, found none"; then only the names of accounts whose password field is empty. The
    # hashes are never printed.
    kv emptyPassword ""
    awk -F: '$2 == "" { print $1 }' "$R/etc/shadow" | head -n 20 | while IFS= read -r _r; do kv emptyPassword "$_r"; done
  fi
}

obs_sysctl_value() {
  _k=${P_key:-}
  [ -n "$_k" ] || return 1
  _path=$R/proc/sys/$(printf '%s' "$_k" | tr . /)
  if [ -f "$_path" ] && [ -r "$_path" ]; then
    kv exists yes
    kv value "$(head -c 200 "$_path" | tr -s ' \t\n' ' ' | sed -e 's/^ //' -e 's/ $//')"
  else
    kv exists no
  fi
}

obs_docker_engine() {
  need_root || return 11
  if ! have docker; then
    kv installed no
    kv running no
    return 0
  fi
  kv installed yes
  _ver=$(bounded 10 docker version --format '{{.Server.Version}}')
  if [ -z "$_ver" ]; then
    kv running no
    return 0
  fi
  kv running yes
  kv version "$_ver"
  kv composeVersion "$(bounded 10 docker compose version --short)"
  kv containers "$(num "$(bounded 10 docker ps -aq | wc -l | tr -d ' ')")"
  kv runningContainers "$(num "$(bounded 10 docker ps -q | wc -l | tr -d ' ')")"
}

obs_docker_container() {
  need_root || return 11
  _name=${P_name:-}
  [ -n "$_name" ] || return 1
  if ! have docker; then
    kv exists no
    return 0
  fi
  _row=$(bounded 10 docker container inspect --format '{{.State.Status}}|{{.Config.Image}}|{{.Image}}|{{.HostConfig.RestartPolicy.Name}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}' "$_name")
  if [ -z "$_row" ]; then
    kv exists no
    return 0
  fi
  kv exists yes
  _state=$(printf '%s' "$_row" | cut -d'|' -f1)
  _image=$(printf '%s' "$_row" | cut -d'|' -f2)
  kv state "$_state"
  kv image "$_image"
  _t=
  case $_image in
    *@*) ;;
    *)
      _last=${_image##*/}
      case $_last in *:*) _t=${_last##*:} ;; esac ;;
  esac
  kv tag "$_t"
  kv imageId "$(printf '%s' "$_row" | cut -d'|' -f3)"
  _rp=$(printf '%s' "$_row" | cut -d'|' -f4)
  kv restartPolicy "${_rp:-no}"
  kv health "$(printf '%s' "$_row" | cut -d'|' -f5)"
  if [ "$_state" = running ]; then
    _since=$(date -d "$(printf '%s' "$_row" | cut -d'|' -f6)" +%s)
    case $_since in '' | *[!0-9]*) ;; *) kv uptimeSeconds "$(($(now) - _since))" ;; esac
  else
    kv uptimeSeconds 0
  fi
  # The names of the variables are printed. A value is never printed, except the four that are named here, and only
  # when they are plain words. Docker writes every entry as one JSON string, so a value with a line break in it (a PEM
  # key, a YAML document) stays inside its own line and can never pass for a name: a line that is not a quoted entry is
  # dropped, and a name must be a variable name. The status of the inspection is kept: a list that could not be read
  # (a timeout, a container removed meanwhile) fails the observation instead of reading as "no variables".
  _env=$(bounded 10 docker container inspect --format '{{range .Config.Env}}{{println (json .)}}{{end}}' "$_name") || return 1
  [ -n "$_env" ] || return 0
  printf '%s\n' "$_env" |
    awk '
      !/^".*"$/ { next }
      {
        e = substr($0, 2, length($0) - 2)
        i = index(e, "=")
        name = (i > 0) ? substr(e, 1, i - 1) : e
        if (name !~ /^[A-Za-z_][A-Za-z0-9_]*$/) next
        print "n " name
        if (i > 0 && (name == "SNI_VERIFICATION" || name == "NODE_PORT" || name == "NODE_ENV" || name == "TZ")) {
          v = substr(e, i + 1)
          if (v ~ /^[A-Za-z0-9._:\/+-]*$/) print "f " name "=" v
        }
      }' |
    head -n 300 | while IFS= read -r _l; do
      case $_l in
        "n "*) kv envNames "${_l#n }" ;;
        "f "*) kv envFlags "${_l#f }" ;;
      esac
    done
}

obs_nginx_config() {
  need_root || return 11
  if ! have nginx; then
    kv installed no
    kv active no
    kv valid no
    return 0
  fi
  kv installed yes
  kv version "$(bounded 5 nginx -v 2>&1 | sed -n 's/.*nginx\/\([^ ]*\).*/\1/p' | head -n 1)"
  if have systemctl && [ "$(bounded 5 systemctl is-active nginx)" = active ]; then kv active yes; else kv active no; fi
  if bounded 15 nginx -t >/dev/null 2>&1; then kv valid yes; else kv valid no; fi
  ls "$R/etc/nginx/sites-enabled" 2>/dev/null | head -n 50 | while IFS= read -r _s; do kv enabledSites "$_s"; done
}

obs_haproxy_config() {
  need_root || return 11
  if ! have haproxy; then
    kv installed no
    kv active no
    kv valid no
    return 0
  fi
  kv installed yes
  kv version "$(bounded 5 haproxy -v | sed -n -e 's/^HAProxy version \([^ ]*\).*/\1/p' -e 's/^HA-Proxy version \([^ ]*\).*/\1/p' | head -n 1)"
  if have systemctl && [ "$(bounded 5 systemctl is-active haproxy)" = active ]; then kv active yes; else kv active no; fi
  _cfg=$R/etc/haproxy/haproxy.cfg
  if bounded 15 haproxy -c -f "$_cfg" >/dev/null 2>&1; then kv valid yes; else kv valid no; fi
  awk '$1 == "frontend" { print $2 }' "$_cfg" 2>/dev/null | head -n 50 | while IFS= read -r _f; do kv frontends "$_f"; done
  awk '$1 == "default_backend" { print $2 }' "$_cfg" 2>/dev/null | head -n 50 | while IFS= read -r _b; do kv defaultBackends "$_b"; done
}

obs_cert_file() {
  need_root || return 11
  _p=${P_path:-}
  [ -n "$_p" ] || return 1
  if [ ! -f "$_p" ]; then
    kv exists no
    return 0
  fi
  have openssl || return 1
  kv exists yes
  _subj=$(bounded 10 openssl x509 -in "$_p" -noout -subject)
  # A file that is not a certificate (a key, an empty file) exists and nothing more is said about it.
  [ -n "$_subj" ] || return 0
  _iss=$(bounded 10 openssl x509 -in "$_p" -noout -issuer)
  _end=$(bounded 10 openssl x509 -in "$_p" -noout -enddate | sed -n 's/^notAfter=//p')
  kv subjectCn "$(printf '%s\n' "$_subj" | sed -n 's/.*CN *= *\([^,\/]*\).*/\1/p' | head -n 1)"
  kv issuerCn "$(printf '%s\n' "$_iss" | sed -n 's/.*CN *= *\([^,\/]*\).*/\1/p' | head -n 1)"
  if [ "${_subj#subject=}" = "${_iss#issuer=}" ]; then kv selfSigned yes; else kv selfSigned no; fi
  _e=$(date -d "$_end" +%s)
  case $_e in '' | *[!0-9]*) ;; *) kv daysLeft "$(((_e - $(now)) / 86400))" ;; esac
  kv mode "$(stat -c %a "$_p")"
  kv owner "$(stat -c %U "$_p")"
  kv group "$(stat -c %G "$_p")"
}

obs_file_stat() {
  _p=${P_path:-}
  [ -n "$_p" ] || return 1
  _st=$(stat -c '%F|%a|%U|%G|%s|%Y' "$_p")
  if [ -z "$_st" ]; then
    kv exists no
    return 0
  fi
  kv exists yes
  case $(printf '%s' "$_st" | cut -d'|' -f1) in
    *directory*) kv type dir ;;
    *symbolic*) kv type link ;;
    *regular*) kv type file ;;
    *) kv type other ;;
  esac
  kv mode "$(printf '%s' "$_st" | cut -d'|' -f2)"
  kv owner "$(printf '%s' "$_st" | cut -d'|' -f3)"
  kv group "$(printf '%s' "$_st" | cut -d'|' -f4)"
  kv size "$(num "$(printf '%s' "$_st" | cut -d'|' -f5)")"
  kv ageSeconds "$(($(now) - $(num "$(printf '%s' "$_st" | cut -d'|' -f6)")))"
}

obs_file_hash() {
  need_root || return 11
  _p=${P_path:-}
  [ -n "$_p" ] || return 1
  if [ ! -f "$_p" ]; then
    kv exists no
    return 0
  fi
  kv exists yes
  _size=$(num "$(stat -c %s "$_p")")
  kv size "$_size"
  if [ "$_size" -le 8388608 ]; then
    kv sha256 "$(bounded 20 sha256sum "$_p" | cut -d' ' -f1)"
  else
    kv sha256 ""
  fi
}

obs_certsync_account() {
  need_root || return 11
  _u=${P_user:-certsync}
  _pw=$(getent passwd "$_u")
  if [ -z "$_pw" ]; then
    kv exists no
    return 0
  fi
  kv exists yes
  kv shell "$(printf '%s' "$_pw" | cut -d: -f7)"
  _home=$(printf '%s' "$_pw" | cut -d: -f6)
  _file=$_home/.ssh/authorized_keys
  if [ ! -r "$_file" ]; then
    kv keyCount 0
    kv restricted no
    return 0
  fi
  # Only the options before the key are looked at, and of the forced command only the program.
  awk '
    /^[ \t]*#/ || !NF { next }
    {
      n++
      opts = ""
      for (i = 1; i < NF; i++)
        if ($i ~ /^(ssh-rsa|ssh-dss|ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/ && length($(i + 1)) > 40) {
          for (j = 1; j < i; j++) opts = opts (j > 1 ? " " : "") $j
          break
        }
      isr = (opts ~ /(^|,)restrict(,| |$)/) && (opts ~ /command="/)
      if (!isr) bad++
      if (n == 1 && match(opts, /command="[^" ]*/)) cmd = substr(opts, RSTART + 9, RLENGTH - 9)
    }
    END {
      print "keyCount=" n + 0
      print "restricted=" ((n > 0 && !bad) ? "yes" : "no")
      if (cmd != "") print "command=" cmd
    }' "$_file" | while IFS= read -r _l; do kv "${_l%%=*}" "${_l#*=}"; done
}

obs_installer_journal() {
  need_root || return 11
  _j=$R/var/log/swellwright-node-installer.log
  if [ ! -r "$_j" ]; then
    kv exists no
    return 0
  fi
  kv exists yes
  # The last 4 MiB are enough: the journal grows by the run, and a run's own lines are short.
  tail -c 4194304 "$_j" | awk '
    /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9:]+ === swellwright-node-installer / {
      run++; ts[run] = $1 " " $2; v = $5; sub(/,$/, "", v); ver[run] = v; act[run] = $7; next
    }
    /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9:]+ CHECK (ok|warn|fail) \|/ {
      if (run > 0) {
        s = $4; has[run] = 1
        if (s == "ok") ok[run]++; else if (s == "warn") warn[run]++
        else { fail[run]++; l = $0; sub(/^[^|]*\| */, "", l); sub(/ *\|.*$/, "", l); failed[run] = failed[run] l "\n" }
      }
    }
    END {
      if (run > 0) { print "version=" ver[run]; print "lastAction=" act[run]; print "lastRunTime=" ts[run] }
      for (i = run; i > 0; i--) if (has[i]) {
        print "verifyTime=" ts[i]; print "verifyOk=" ok[i] + 0; print "verifyWarn=" warn[i] + 0; print "verifyFail=" fail[i] + 0
        n = split(failed[i], f, "\n"); for (k = 1; k <= n && k <= 20; k++) if (f[k] != "") print "failedChecks=" f[k]
        break
      }
    }' | while IFS= read -r _l; do
    _key=${_l%%=*}
    _val=${_l#*=}
    case $_key in
      lastRunTime)
        _e=$(date -d "$_val" +%s)
        case $_e in '' | *[!0-9]*) ;; *) kv lastRunAgeSeconds "$(($(now) - _e))" ;; esac ;;
      verifyTime)
        _e=$(date -d "$_val" +%s)
        case $_e in '' | *[!0-9]*) ;; *) kv verifyAgeSeconds "$(($(now) - _e))" ;; esac ;;
      *) kv "$_key" "$_val" ;;
    esac
  done
}

obs_http_local() {
  have curl || return 1
  _port=${P_port:-}
  [ -n "$_port" ] || return 1
  _scheme=${P_scheme:-http}
  _addr=127.0.0.1
  if [ "${P_target:-loopback}" = self ]; then
    _addr=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
    [ -n "$_addr" ] || _addr=$(hostname -I 2>/dev/null | cut -d' ' -f1)
    [ -n "$_addr" ] || return 1
  fi
  if [ -n "${P_sni:-}" ]; then
    _code=$(bounded 10 curl -s -k -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 6 --noproxy '*' \
      --resolve "$P_sni:$_port:$_addr" "$_scheme://$P_sni:$_port/")
  else
    _code=$(bounded 10 curl -s -k -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 6 --noproxy '*' \
      "$_scheme://$_addr:$_port/")
  fi
  kv status "$(num "$_code")"
}

obs_dns_self() {
  _name=$(hostname -f 2>/dev/null)
  [ -n "$_name" ] || _name=$(hostname)
  kv name "$_name"
  _addrs=$(bounded 8 getent ahostsv4 "$_name" | awk '{ print $1 }' | sort -u | head -n 10)
  if [ -z "$_addrs" ]; then
    kv resolves no
    kv local no
    return 0
  fi
  kv resolves yes
  _local=0
  _mine=$(ip -4 -o addr show 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }')
  [ -n "$_mine" ] || _mine=$(hostname -I 2>/dev/null | tr ' ' '\n')
  for _a in $_addrs; do
    kv addresses "$_a"
    case $_a in 127.*) _local=1 ;; esac
    if printf '%s\n' "$_mine" | grep -qx -e "$_a"; then _local=1; fi
  done
  kv local "$(yn "$_local")"
}

# ---- the driver ---------------------------------------------------------------------------------------------------

PLAN=$(cat)
printf '@@swb v1\n'
printf '@@swb epoch %s\n' "$(now)"
printf '@@swb uid %s\n' "$(id -u)"

printf '%s\n' "$PLAN" | while IFS= read -r _line; do
  [ -n "$_line" ] || continue
  _idx=${_line%%"$TAB"*}
  _rest=${_line#*"$TAB"}
  _kind=${_rest%%"$TAB"*}
  case $_idx in '' | *[!0-9]*) continue ;; esac
  case $_kind in '' | *[!a-z0-9.]*) continue ;; esac
  _params=
  case $_rest in *"$TAB"*) _params=${_rest#*"$TAB"} ;; esac
  unset P_path P_port P_proto P_chain P_key P_name P_unit P_user P_scheme P_target P_sni
  _oldifs=$IFS
  IFS=$TAB
  # shellcheck disable=SC2086
  set -- $_params
  IFS=$_oldifs
  for _pair in "$@"; do
    _n=${_pair%%=*}
    _v=${_pair#*=}
    case $_n in '' | *[!a-z]*) continue ;; esac
    eval "P_$_n=\$_v"
  done
  _fn=obs_$(printf '%s' "$_kind" | tr . _)
  printf '@@swb begin %s %s\n' "$_idx" "$_kind"
  if ! command -v "$_fn" >/dev/null 2>&1; then
    printf '\n@@swb end %s 99\n' "$_idx"
    continue
  fi
  _rc=$({ { "$_fn" </dev/null; echo "$?" >&4; } 2>/dev/null | tr -d '\000' | head -c 65536 | sed 's/^/| /' >&3; } 4>&1)
  printf '\n@@swb end %s %s\n' "$_idx" "${_rc:-1}"
done
printf '@@swb done\n'
