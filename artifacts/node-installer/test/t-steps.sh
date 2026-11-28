# Tests of the installing steps: base, system, hostname, firewall, fail2ban, apiacl, docker, certsync, nginx, haproxy, node.
# Each runs in a fake root; the stubs record what would have changed.

t_base_step() {
    run_inst base
    assert_rc 0
    assert_called "apt-get -o DPkg::Lock::Timeout=600 update"
    assert_called "apt-get -o DPkg::Lock::Timeout=600 -y -o Dpkg::Options::=--force-confold upgrade"
    assert_called "apt-get -o DPkg::Lock::Timeout=600 install -y -o Dpkg::Options::=--force-confold curl ca-certificates gnupg rsync openssl ufw iproute2 procps"
    : >"$STUB_LOG"
    run_inst base BASE_UPGRADE=no
    assert_rc 0
    assert_not_called_like ' upgrade$'
    assert_out "BASE_UPGRADE=no"
}

# Stock Ubuntu runs the watcher of unattended-upgrades all the time (its process name is cut to "unattended-upgr", as the
# name of a run is); it holds no lock. Waiting for it made every apt call of the installer wait 15 minutes (found on a
# fresh Ubuntu 24.04 server).
t_base_step_does_not_wait_for_the_unattended_upgrades_watcher() {
    printf 'unattended-upgr\t/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal\n' >"$STATE/processes"
    run_inst base APT_WAIT_MAX=3 APT_WAIT_STEP=1
    assert_rc 0
    assert_not_contains "$R/var/log/swellwright-node-installer.log" "waiting for another apt"
    assert_called "apt-get -o DPkg::Lock::Timeout=600 update"
}

t_base_step_waits_for_a_running_unattended_upgrade() {
    printf 'unattended-upgr\t/usr/bin/python3 /usr/bin/unattended-upgrade\n' >"$STATE/processes"
    run_inst base APT_WAIT_MAX=2 APT_WAIT_STEP=1
    assert_rc 0
    assert_contains "$R/var/log/swellwright-node-installer.log" "waiting for another apt or dpkg process"
    assert_contains "$R/var/log/swellwright-node-installer.log" "the dpkg lock was not released in 2 s, going on"
    assert_called "apt-get -o DPkg::Lock::Timeout=600 update"
}

t_base_step_waits_for_the_daily_apt_job() {
    printf 'apt.systemd.dai\t/bin/sh /usr/lib/apt/apt.systemd.daily lock_is_held install\n' >"$STATE/processes"
    run_inst base APT_WAIT_MAX=2 APT_WAIT_STEP=1
    assert_rc 0
    assert_contains "$R/var/log/swellwright-node-installer.log" "waiting for another apt or dpkg process"
}

# With fuser the lock files decide, and the names of resident daemons are no reason to wait (PackageKit's daemon stays for
# minutes after an upgrade).
t_base_step_asks_the_lock_files_when_it_can() {
    have fuser
    printf 'packagekitd	/usr/libexec/packagekitd
' >"$STATE/processes"
    run_inst base APT_WAIT_MAX=3 APT_WAIT_STEP=1
    assert_rc 0
    assert_not_contains "$R/var/log/swellwright-node-installer.log" "waiting for another apt"
    assert_called "apt-get -o DPkg::Lock::Timeout=600 update"
    : >"$STUB_LOG"
    : >"$STATE/locked"
    run_inst base APT_WAIT_MAX=2 APT_WAIT_STEP=1
    assert_rc 0
    assert_contains "$R/var/log/swellwright-node-installer.log" "waiting for another apt or dpkg process"
    assert_contains "$R/var/log/swellwright-node-installer.log" "the dpkg lock was not released in 2 s, going on"
}

t_base_step_stops_on_apt_failure() {
    fail_on "apt-get -o DPkg::Lock::Timeout=600 update"
    run_inst base
    assert_rc 1
    assert_out "apt-get update failed"
    assert_not_called_like ' install '
}

t_system_step() {
    run_inst system
    assert_rc 0
    assert_contains "$R/etc/systemd/journald.conf.d/99-sw.conf" "SystemMaxUse=200M"
    assert_contains "$R/etc/systemd/timesyncd.conf.d/99-sw.conf" "FallbackNTP=ntp.ubuntu.com"
    assert_line "$R/etc/modules-load.d/sw-bbr.conf" "tcp_bbr"
    assert_line "$R/etc/sysctl.d/99-sw-net.conf" "net.ipv4.tcp_congestion_control = bbr"
    assert_line "$R/etc/sysctl.d/99-sw-net.conf" "net.core.default_qdisc = fq"
    assert_not_contains "$R/etc/sysctl.d/99-sw-net.conf" "tcp_fastopen ="
    assert_called "modprobe tcp_bbr"
    assert_called "sysctl -q -p $R/etc/sysctl.d/99-sw-net.conf"
    assert_called "journalctl --vacuum-size=200M"
    # Nothing is written twice.
    run_inst system
    assert_rc 0
    assert_out "unchanged: /etc/sysctl.d/99-sw-net.conf"
}

t_hostname_step() {
    run_inst hostname NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 0
    assert_called "hostnamectl set-hostname node1.example.com"
    assert_line "$R/etc/hosts" "192.0.2.10 node1.example.com node1"
    assert_line "$R/etc/hosts" "127.0.0.1 localhost"
    ls "$R/etc/hosts.bak."* >/dev/null 2>&1 || fail "the old /etc/hosts was not kept"
    run_inst hostname NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 0
    [ "$(grep -c 'node1.example.com' "$R/etc/hosts")" = 1 ] || fail "the hosts line was added twice"
}

# The image of a hosting provider often writes /etc/hosts without a final line break. The new line must not be glued to
# the last one (found on a real server: the address of the node ended up inside the line of the machine itself and the
# host name of that line became "vm-name" plus an address).
t_hostname_step_with_a_hosts_file_that_does_not_end_with_a_line_break() {
    printf '127.0.0.1	localhost
198.51.100.5	vm-name' >"$R/etc/hosts"
    run_inst hostname NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 0
    assert_line "$R/etc/hosts" "198.51.100.5	vm-name"
    assert_line "$R/etc/hosts" "192.0.2.10 node1.example.com node1"
    [ "$(grep -c . "$R/etc/hosts")" = 3 ] || fail "the file has an unexpected number of lines"
    run_inst hostname NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 0
    [ "$(grep -c . "$R/etc/hosts")" = 3 ] || fail "the hosts line was added again"
}

t_firewall_step() {
    run_inst firewall PANEL_ALLOW_IP='192.0.2.20 198.51.100.7'
    assert_rc 0
    assert_called "ufw allow 22/tcp"
    assert_called "ufw allow 80/tcp"
    assert_called "ufw allow 443/tcp"
    # The node API port is for the panel only: the rule for everybody is removed, one rule per panel address is added.
    assert_called "ufw delete allow 62050/tcp"
    assert_called "ufw allow from 192.0.2.20 to any port 62050 proto tcp"
    assert_called "ufw allow from 198.51.100.7 to any port 62050 proto tcp"
    assert_not_called "ufw allow 62050/tcp"
    assert_not_called_like '^ufw allow 62050'
    # SSH is allowed before the firewall is switched on; the panel's rules come before the rule for everybody goes.
    assert_order "ufw allow 22/tcp" "ufw --force enable"
    assert_order "ufw allow from 198.51.100.7 to any port 62050 proto tcp" "ufw --force enable"
    assert_order "ufw allow from 198.51.100.7 to any port 62050 proto tcp" "ufw delete allow 62050/tcp"
}

t_firewall_follows_the_ports() {
    printf 'port 2200\npermitrootlogin yes\n' >"$STATE/sshd_T"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20 SSH_PORT=2200 NODE_PORT=3000
    assert_rc 0
    assert_called "ufw allow 2200/tcp"
    assert_not_called "ufw allow 22/tcp"
    assert_called "ufw allow from 192.0.2.20 to any port 3000 proto tcp"
}

t_firewall_detects_the_ssh_port() {
    printf 'port 2222\npermitrootlogin yes\n' >"$STATE/sshd_T"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    assert_called "ufw allow 2222/tcp"
}

t_firewall_keeps_the_port_of_the_current_session() {
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20 SSH_PORT=22 SSH_CONNECTION="192.0.2.5 54321 192.0.2.10 2222"
    assert_rc 0
    assert_called "ufw allow 22/tcp"
    assert_called "ufw allow 2222/tcp"
    assert_out "keeping 2222 open"
    assert_order "ufw allow 2222/tcp" "ufw --force enable"
}

# sudo drops SSH_CONNECTION (env_reset): the ports come from sshd and from the open sessions themselves, never only from the
# environment. Every Port line of sshd counts, and the local port of every established sshd connection.
t_firewall_keeps_every_ssh_port_without_the_environment() {
    printf 'port 22\nport 2222\npermitrootlogin yes\n' >"$STATE/sshd_T"
    printf '0 0 192.0.2.10:2200 198.51.100.5:50000 users:(("sshd",pid=10,fd=4))\nESTAB 0 0 192.0.2.10:443 198.51.100.6:50001 users:(("haproxy",pid=11,fd=5))\n' >"$STATE/ss_est"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    assert_called "ufw allow 22/tcp"
    assert_called "ufw allow 2222/tcp"
    assert_called "ufw allow 2200/tcp"
    assert_not_called "ufw allow 50000/tcp"
    assert_order "ufw allow 2200/tcp" "ufw --force enable"
    assert_order "ufw allow 2222/tcp" "ufw --force enable"
    assert_out "keeping 2200 open"
}

t_firewall_refuses_a_node_port_that_is_an_ssh_port() {
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20 NODE_PORT=22
    assert_rc 1
    assert_out "is also an SSH port"
    assert_not_called "ufw delete allow 22/tcp"
    assert_not_called "ufw --force enable"
}

t_firewall_stops_when_ssh_cannot_be_allowed() {
    fail_on "ufw allow 22/tcp"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_out "UFW could not allow SSH on port 22"
    assert_not_called "ufw --force enable"
}

t_firewall_stops_when_open_ssh_sessions_cannot_be_read() {
    fail_on "ss -Htnp state established"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_out "Could not read open SSH sessions"
    assert_not_called "ufw --force enable"
}

t_firewall_stops_when_ufw_cannot_be_enabled() {
    fail_on "ufw --force enable"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_out "UFW could not be enabled"
}

t_firewall_stops_when_a_listed_public_rule_cannot_be_deleted() {
    have ufw
    printf 'Added user rules (see ufw status for running firewall):\n  ufw allow 62050/tcp\n' >"$STATE/ufw_added"
    fail_on "ufw delete allow 62050/tcp"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_out "could not remove the unrestricted rule"
    assert_not_called "ufw --force enable"
}

t_firewall_refuses_reserved_node_ports_before_changing_ufw() {
    for _reserved in 80 443 8444; do
        run_inst firewall PANEL_ALLOW_IP=192.0.2.20 NODE_PORT="$_reserved"
        assert_rc 1
        assert_out "Invalid value for NODE_PORT"
    done
    assert_not_called_like '^(ufw|apt-get) '
}

t_fail2ban_step() {
    run_inst fail2ban PANEL_ALLOW_IP=192.0.2.20 FAIL2BAN_IGNORE_EXTRA='198.51.100.0/24 203.0.113.7' SSH_PORT=2200
    assert_rc 0
    _j="$R/etc/fail2ban/jail.d/sw-sshd.local"
    assert_line "$_j" "ignoreip = 127.0.0.1/8 ::1 192.0.2.20 198.51.100.0/24 203.0.113.7"
    assert_line "$_j" "port = 2200"
    assert_line "$_j" "backend = systemd"
    assert_line "$_j" "bantime = 1h"
    assert_line "$_j" "maxretry = 5"
    assert_line "$_j" "enabled = true"
    assert_called "systemctl enable fail2ban"
    assert_called "systemctl restart fail2ban"
    # Not installed yet: it is installed with the journal binding that backend = systemd needs.
    assert_called_like 'install -y .* fail2ban python3-systemd$'
}

t_fail2ban_without_extras_and_already_installed() {
    have fail2ban-client
    run_inst fail2ban
    assert_rc 0
    assert_line "$R/etc/fail2ban/jail.d/sw-sshd.local" "ignoreip = 127.0.0.1/8 ::1"
    assert_not_contains "$R/etc/fail2ban/jail.d/sw-sshd.local" "10.0.0.0/8"
    assert_not_called_like '^apt-get .* install '
}

t_apiacl_step() {
    have docker ufw
    printf 'Status: active\n\nTo   Action   From\n' >"$STATE/ufw_status"
    run_inst apiacl PANEL_ALLOW_IP='192.0.2.20 198.51.100.7'
    assert_rc 0
    assert_line "$R/etc/sw-node-api-allow.conf" 'ALLOW_SRC="192.0.2.20 198.51.100.7"'
    assert_line "$R/etc/sw-node-api-allow.conf" "NODE_PORT=62050"
    assert_contains "$R/etc/systemd/system/sw-node-api-acl.service" "ExecStart=/usr/local/sbin/sw-node-api-acl.sh reconcile"
    assert_contains "$R/etc/systemd/system/sw-node-api-acl.service" "After=docker.service"
    assert_contains "$R/etc/systemd/system/sw-node-api-acl.service" "PartOf=docker.service"
    assert_mode_recorded 755 "$R/usr/local/sbin/sw-node-api-acl.sh"
    # The staged file gets its mode before it is atomically renamed into place.
    assert_called_like '^chmod 644 .*/sw-node-api-allow\.conf\.[^/ ]+$'
    assert_mode_recorded 644 "$R/etc/systemd/system/sw-node-api-acl.service"
    assert_order "systemctl daemon-reload" "systemctl start sw-node-api-acl.service"
    assert_called "systemctl enable sw-node-api-acl.service"
    # UFW is active: the same restriction there, and never a rule for everybody.
    assert_called "ufw delete allow 62050/tcp"
    assert_called "ufw allow from 192.0.2.20 to any port 62050 proto tcp"
    assert_called "ufw allow from 198.51.100.7 to any port 62050 proto tcp"
    assert_not_called_like '^ufw allow 62050'
    assert_order "ufw allow from 198.51.100.7 to any port 62050 proto tcp" "ufw delete allow 62050/tcp"
    # The rules the unit applied are checked by what they do.
    assert_out "Node API port 62050: only 192.0.2.20 198.51.100.7 get through, everything else is dropped"
}

# legacy_acl: DOCKER-USER as an installer before 1.1.0 left it: the rules for the port straight in the chain, an address that
# is no longer the panel among them, and Docker's own RETURN at the end.
legacy_acl() {
    printf -- '-N DOCKER-USER\n-A DOCKER-USER -s 192.0.2.99/32 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j RETURN\n-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j DROP\n-A DOCKER-USER -j RETURN\n' >"$STATE/iptables_rules"
}

# The helper deletes the old rules for the port and inserts the new ones in one iptables-restore transaction: no rule is ever
# deleted or inserted on its own. The allowed sources RETURN straight from DOCKER-USER (a later DROP in the chain cannot catch
# them), and the rules for another port (NODE_PORT changed, the container may still publish it) stay.
t_apiacl_switches_to_the_new_rules_in_one_transaction() {
    have docker
    legacy_acl
    printf -- '-A DOCKER-USER -s 192.0.2.20/32 -p tcp -m conntrack --ctorigdstport 3000 --ctdir ORIGINAL -j RETURN\n-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 3000 --ctdir ORIGINAL -j DROP\n' >>"$STATE/iptables_rules"
    run_inst apiacl PANEL_ALLOW_IP='192.0.2.20 198.51.100.7'
    assert_rc 0
    assert_not_called_like '^iptables -[DIA] '
    [ "$(grep -c '^\*filter$' "$STATE/restore.log")" = 1 ] || fail "expected exactly one iptables-restore transaction"
    _d="$STATE/iptables_rules"
    [ "$(sed -n 2p "$_d")" = "-A DOCKER-USER -s 192.0.2.20 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j RETURN" ] || fail "the first rule is not the panel's: $(cat "$_d")"
    [ "$(sed -n 3p "$_d")" = "-A DOCKER-USER -s 198.51.100.7 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j RETURN" ] || fail "the second rule is not the panel's: $(cat "$_d")"
    [ "$(sed -n 4p "$_d")" = "-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j DROP" ] || fail "the DROP does not follow the panel's rules: $(cat "$_d")"
    assert_not_contains "$_d" "192.0.2.99"
    assert_line "$_d" "-A DOCKER-USER -j RETURN"
    assert_line "$_d" "-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 3000 --ctdir ORIGINAL -j DROP"
    [ "$(grep -c -- '--ctorigdstport 62050 --ctdir ORIGINAL -j DROP' "$_d")" = 1 ] || fail "the DROP is there twice"
    # Again with another panel: the same transaction replaces the rules.
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.21
    assert_rc 0
    assert_line "$_d" "-A DOCKER-USER -s 192.0.2.21 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j RETURN"
    assert_not_contains "$_d" "-s 192.0.2.20 -p tcp -m conntrack --ctorigdstport 62050"
    # There is no standalone removal while a node may be published.
    cp "$R/usr/local/sbin/sw-node-api-acl.sh" "$T/acl.sh"
    cp "$_d" "$T/acl-before-remove"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} TMPDIR="$T/tmp" "$SHELL_UNDER_TEST" "$T/acl.sh" remove >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 2
    cmp -s "$_d" "$T/acl-before-remove" || fail "refused removal changed the ACL"
    assert_line "$_d" "-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 3000 --ctdir ORIGINAL -j DROP"
    assert_line "$_d" "-A DOCKER-USER -j RETURN"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} "$SHELL_UNDER_TEST" "$T/acl.sh" bogus >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 2
}

# A switch that fails (iptables-restore refuses, or the run is killed before it) leaves the previous rules in force: the port
# is never without its DROP. The old helper deleted the old rules first and could stop with the port open.
t_apiacl_failed_switch_keeps_the_previous_rules() {
    have docker
    legacy_acl
    cp "$STATE/iptables_rules" "$T/before"
    fail_on "iptables-restore"
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_out "Could not apply and verify the candidate node API ACL"
    cmp -s "$T/before" "$STATE/iptables_rules" || fail "DOCKER-USER changed although the switch failed"
    assert_not_called_like '^iptables -D '
    in_inst 'api_acl_check 62050 "192.0.2.99"'
    assert_out "ok only 192.0.2.99 get through"
}

t_apiacl_interrupted_switch_keeps_the_previous_rules() {
    have docker
    legacy_acl
    cp "$STATE/iptables_rules" "$T/before"
    # The helper is killed while iptables-restore runs (before it commits): its trap ends it and removes its temporary file.
    mkstub iptables-restore <<'EOF'
kill -TERM "$PPID"
sleep 1
exit 1
EOF
    have iptables-restore
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    cmp -s "$T/before" "$STATE/iptables_rules" || fail "DOCKER-USER changed although the switch was interrupted"
    ! grep -l '^\*filter' "$T"/tmp/* >/dev/null 2>&1 || fail "the helper left its transaction file behind"
}

t_apiacl_keeps_unmanaged_rules_for_the_same_port() {
    have docker
    legacy_acl
    _rule='-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -m comment --comment custom -j DROP'
    printf '%s\n' "$_rule" >>"$STATE/iptables_rules"
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    assert_line "$STATE/iptables_rules" "$_rule"
}

t_apiacl_refuses_before_changing_an_ssh_port() {
    have docker
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20 NODE_PORT=22
    assert_rc 1
    assert_out "is also an SSH port"
    assert_no_file "$R/etc/sw-node-api-allow.conf"
    assert_not_called_like '^iptables-restore'
}

t_apiacl_replaces_old_panel_ufw_rules_without_removing_new_ones() {
    have docker ufw
    legacy_acl
    printf 'Status: active\n' >"$STATE/ufw_status"
    printf 'Added user rules (see ufw status for running firewall):\n  ufw allow from 192.0.2.99 to any port 62050 proto tcp\n  ufw allow from 198.51.100.7 to any port 62050 proto tcp\n' >"$STATE/ufw_added"
    run_inst apiacl PANEL_ALLOW_IP='192.0.2.20 198.51.100.7'
    assert_rc 0
    assert_order "ufw allow from 192.0.2.20 to any port 62050 proto tcp" \
        "ufw delete allow from 192.0.2.99 to any port 62050 proto tcp"
    assert_not_called "ufw delete allow from 198.51.100.7 to any port 62050 proto tcp"
}

t_apiacl_step_with_ufw_off_leaves_ufw_alone() {
    # UFW is installed but not active: its rules are not touched (the DOCKER-USER rules still are).
    have docker ufw
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    assert_not_called_like '^ufw (allow|delete)'
    assert_contains "$R/etc/sw-node-api-allow.conf" 'ALLOW_SRC="192.0.2.20"'
}

t_apiacl_step_without_ufw_leaves_ufw_alone() {
    have docker
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    assert_not_called_like '^ufw'
}

t_apiacl_needs_docker() {
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_out "Docker is not installed"
    assert_no_file "$R/etc/sw-node-api-allow.conf"
}

t_apiacl_is_reapplied_after_separate_docker_stop_and_start_without_node() {
    node_acl_ready
    run_unit() {
        env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} systemctl "$@" >"$T/out" 2>"$T/err"
        RC=$?
    }
    run_unit stop docker.service
    assert_rc 0
    run_unit is-active sw-node-api-acl.service
    assert_rc 3
    printf -- '-N DOCKER-USER\n' >"$STATE/iptables_rules"
    : >"$STUB_LOG"
    run_unit start docker.service
    assert_rc 0
    run_unit is-active sw-node-api-acl.service
    assert_rc 0
    assert_called_like '^iptables-restore '
    assert_not_called_like '^docker .* container start '
}

t_apiacl_rotation_keeps_confirmed_config_and_ufw_until_verified() {
    node_acl_ready
    have ufw
    printf 'Status: active\n' >"$STATE/ufw_status"
    cp "$R/etc/swellwright-node-installer.conf" "$T/before"
    cp "$R/etc/sw-node-api-allow.conf" "$T/acl-before"
    fail_on 'iptables-restore'
    : >"$STUB_LOG"
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.21
    assert_rc 1
    cmp -s "$R/etc/swellwright-node-installer.conf" "$T/before" || fail "unverified sources were saved"
    cmp -s "$R/etc/sw-node-api-allow.conf" "$T/acl-before" || fail "unverified ACL was saved"
    assert_not_called_like '^ufw (allow|delete)'
    : >"$STATE/fail"
    printf '%s\n' '-s 192.0.2.21 ' >"$STATE/fail_acl_readback"
    cp "$STATE/iptables_rules" "$T/rules-before"
    : >"$STUB_LOG"
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.21
    assert_rc 1
    cmp -s "$STATE/iptables_rules" "$T/rules-before" || fail "read-back failure did not restore the previous rules"
    cmp -s "$R/etc/sw-node-api-allow.conf" "$T/acl-before" || fail "unverified ACL was saved"
    assert_not_called_like '^ufw (allow|delete)'
    : >"$STUB_LOG"
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.21
    assert_rc 0
    assert_line "$R/etc/swellwright-node-installer.conf" "PANEL_ALLOW_IP='192.0.2.21'"
    assert_line "$R/etc/sw-node-api-allow.conf" 'ALLOW_SRC="192.0.2.21"'
    assert_order_like '^iptables-restore ' '^ufw allow from 192\.0\.2\.21 '
}

t_node_and_firewall_refuse_to_rotate_confirmed_panel_sources() {
    have docker ufw
    run_inst apiacl PANEL_ALLOW_IP='192.0.2.20 198.51.100.7'
    assert_rc 0
    : >"$STUB_LOG"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.21
    assert_rc 1
    assert_out "run apiacl to change"
    assert_not_called_like '^ufw (allow|delete)'
    run_inst node $NODE_ARGS PANEL_ALLOW_IP=192.0.2.21
    assert_rc 1
    assert_out "run apiacl to change"
    assert_not_called_like '^docker .* (create|start) '
    run_inst node $NODE_ARGS PANEL_ALLOW_IP='198.51.100.7 192.0.2.20 192.0.2.20'
    assert_rc 0
    assert_line "$R/etc/sw-node-api-allow.conf" 'ALLOW_SRC="192.0.2.20 198.51.100.7"'
    : >"$STUB_LOG"
    run_inst apiacl PANEL_ALLOW_IP='198.51.100.7 192.0.2.20 192.0.2.20'
    assert_rc 0
    assert_line "$R/etc/sw-node-api-allow.conf" 'ALLOW_SRC="192.0.2.20 198.51.100.7"'
    assert_not_called_like '^iptables-restore '
}

t_docker_refuses_to_start_when_an_acl_only_install_cannot_be_inspected() {
    node_acl_ready
    fail_on 'docker --host unix:///var/run/docker.sock ps'
    : >"$STUB_LOG"
    run_inst docker
    assert_rc 1
    assert_out "Could not verify existing node ownership or topology"
    assert_not_called_like '^systemctl (enable|start|restart).*docker'
}

t_docker_from_the_apt_repository() {
    run_inst docker
    assert_rc 0
    assert_called_like '^curl .*https://download.docker.com/linux/ubuntu/gpg$'
    assert_file "$R/etc/apt/keyrings/docker.asc"
    assert_line "$R/etc/apt/sources.list.d/docker.list" "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable"
    assert_called "apt-get -o DPkg::Lock::Timeout=600 install -y -o Dpkg::Options::=--force-confold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
    assert_order "apt-get -o DPkg::Lock::Timeout=600 -o APT::Update::Error-Mode=any update" "apt-get -o DPkg::Lock::Timeout=600 install -y -o Dpkg::Options::=--force-confold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
    assert_called "systemctl enable --now docker"
    assert_not_called_like 'get.docker.com'
}

t_docker_keyring_works_without_a_default_gnupg_home() {
    : >"$STATE/gpg_requires_isolated_home"
    run_inst docker
    assert_rc 0
    assert_line "$R/etc/apt/keyrings/docker.asc" KEY-DOCKER
    assert_called_like "^curl -q --proto =https .* https://download\\.docker\\.com/linux/ubuntu/gpg$"
    assert_no_file "$T/.gnupg"
    [ -z "$(ls -A "$T/tmp")" ] || fail "GnuPG left temporary files"

    # An existing correct keyring must be recognized without a download, even if
    # the caller points GnuPG at a path that is not a directory.
    printf 'not a directory\n' >"$T/blocked-gnupg"
    : >"$STUB_LOG"
    in_inst 'export GNUPGHOME="$HOME/blocked-gnupg"; . "$R/etc/os-release"; vendor_apt_repo docker'
    assert_rc 0
    assert_not_called_like '^curl '
    assert_line "$T/blocked-gnupg" 'not a directory'
    assert_no_file "$T/.gnupg"
    [ -z "$(ls -A "$T/tmp")" ] || fail "GnuPG left temporary files while checking the existing keyring"
}

t_docker_rejects_a_wrong_key_before_apt_with_unavailable_gnupg_home() {
    : >"$STATE/gpg_requires_isolated_home"
    printf 'not a directory\n' >"$T/blocked-gnupg"
    printf 'KEY-BAD\n' >"$STATE/key_docker"
    run_inst docker GNUPGHOME="$T/blocked-gnupg"
    assert_rc 1
    assert_contains "$R/var/log/swellwright-node-installer.log" 'holds no key with a pinned fingerprint'
    assert_no_file "$R/etc/apt/keyrings/docker.asc"
    assert_no_file "$R/etc/apt/sources.list.d/docker.list"
    assert_not_called_like '^apt-get '
    assert_not_called_like '^gpg .* --import '
    assert_line "$T/blocked-gnupg" 'not a directory'
    assert_no_file "$T/.gnupg"
    [ -z "$(ls -A "$T/tmp")" ] || fail "GnuPG left temporary files after refusing the wrong key"
}

t_base_repairs_existing_vendor_repositories_before_apt() {
    mkdir -p "$R/etc/apt/keyrings"
    printf 'KEY-DOCKER\nKEY-BAD\n' >"$R/etc/apt/keyrings/docker.asc"
    printf 'KEY-NGINX\nKEY-BAD\n' >"$R/usr/share/keyrings/nginx-archive-keyring.gpg"
    printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' >"$R/etc/apt/sources.list.d/docker.list"
    printf 'deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/ubuntu noble nginx\n' >"$R/etc/apt/sources.list.d/nginx.list"

    run_inst base BASE_UPGRADE=no
    assert_rc 0
    assert_order_like '^curl .*download.docker.com' '^apt-get .*update'
    assert_order_like '^curl .*nginx.org' '^apt-get .*update'
    assert_not_contains "$R/etc/apt/keyrings/docker.asc" KEY-BAD
    assert_not_contains "$R/usr/share/keyrings/nginx-archive-keyring.gpg" KEY-BAD
    assert_not_contains "$R/etc/apt/sources.list.d/nginx.list" http://
}

t_base_refuses_apt_when_unsafe_vendor_keyring_cannot_be_repaired() {
    printf 'INVALID\n' >"$R/usr/share/keyrings/nginx-archive-keyring.gpg"
    printf 'deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/ubuntu noble nginx\n' >"$R/etc/apt/sources.list.d/nginx.list"
    fail_on "curl"
    run_inst base BASE_UPGRADE=no
    assert_rc 1
    assert_not_called_like '^apt-get '
}

t_apt_requires_a_clean_index_refresh_even_after_a_repair_was_interrupted() {
    have nginx
    printf 'KEY-NGINX\nKEY-BAD\n' >"$R/usr/share/keyrings/nginx-archive-keyring.gpg"
    printf 'deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/ubuntu noble nginx\n' >"$R/etc/apt/sources.list.d/nginx.list"
    fail_on "apt-get -o DPkg::Lock::Timeout=600 -o APT::Update::Error-Mode=any"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_not_called_like '^apt-get .* install '
    assert_not_contains "$R/usr/share/keyrings/nginx-archive-keyring.gpg" KEY-BAD
    : >"$STATE/fail"
    : >"$STUB_LOG"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    assert_order_like '^apt-get .*APT::Update::Error-Mode=any.* update$' '^apt-get .* install '
}

t_docker_repository_on_debian() {
    set_os debian
    run_inst docker
    assert_rc 0
    assert_called_like '^curl .*https://download.docker.com/linux/debian/gpg$'
    assert_line "$R/etc/apt/sources.list.d/docker.list" "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable"
}

t_docker_refuses_a_key_with_another_fingerprint() {
    printf 'KEY-BAD\n' >"$STATE/key_docker"
    run_inst docker
    assert_rc 1
    assert_out "Docker's signing key"
    assert_no_file "$R/etc/apt/sources.list.d/docker.list"
    assert_no_file "$R/etc/apt/keyrings/docker.asc"
    assert_not_called_like 'docker-ce'
}

# A download that holds the pinned key and another one: APT would trust every key of the keyring, so only the pinned key
# (with its subkeys) goes into it.
t_docker_mixed_bundle_installs_only_the_pinned_key() {
    printf 'KEY-BAD\nKEY-DOCKER\n' >"$STATE/key_docker"
    run_inst docker
    assert_rc 0
    assert_line "$R/etc/apt/keyrings/docker.asc" "KEY-DOCKER"
    assert_not_contains "$R/etc/apt/keyrings/docker.asc" "KEY-BAD"
    assert_contains "$R/var/log/swellwright-node-installer.log" "0123456789ABCDEF0123456789ABCDEF01234567, which is not pinned: it is left out"
    assert_called_like '^gpg --batch --quiet --no-autostart --homedir .* --armor --export  ?9DC858229FC7DD38854AE2D88D81803C0EBFCD88$'
    # Written next to the keyring and renamed over it: no temporary file is left.
    [ -z "$(ls -A "$R/etc/apt/keyrings" | grep -v '^docker.asc$')" ] || fail "a temporary keyring was left: $(ls -A "$R/etc/apt/keyrings")"
    assert_mode_recorded 644 "$R/etc/apt/keyrings/.docker.asc.[A-Za-z0-9]*"
}

t_signing_keys_are_downloaded_over_https_only() {
    fail_on "curl -q --proto =https"
    run_inst docker
    assert_rc 1
    [ "$(grep -c '^curl -q --proto =https --tlsv1.2 .* https://download.docker.com/linux/ubuntu/gpg$' "$STUB_LOG")" = 2 ] || fail "expected two HTTPS attempts"
    assert_not_called_like '^curl .*http://'
    assert_no_file "$R/etc/apt/keyrings/docker.asc"
    # fetch_key refuses an address that is not https at all.
    in_inst 'fetch_key http://nginx.org/keys/nginx_signing.key "$SW_TEST_ROOT/k.gpg" "$NGINX_KEY_FPRS" binary'
    assert_rc 1
    assert_out "is not an https address"
    assert_no_file "$R/k.gpg"
}

t_docker_refuses_a_failed_download() {
    : >"$STATE/key_docker"
    run_inst docker
    assert_rc 1
    assert_no_file "$R/etc/apt/sources.list.d/docker.list"
}

t_docker_refuses_the_unpinned_convenience_script() {
    run_inst docker DOCKER_SOURCE=script
    assert_rc 1
    assert_out "Invalid value for DOCKER_SOURCE"
    assert_not_called_like '^(curl|apt-get) '
    assert_not_called "systemctl enable --now docker"
}

t_docker_already_installed() {
    have docker
    run_inst docker
    assert_rc 0
    assert_out "already installed"
    assert_not_called_like '^curl'
    assert_not_called_like '^apt-get'
}

t_docker_offline_never_uses_the_socket_or_mutates_node_state() {
    have docker
    : >"$STATE/docker_inactive"
    run_inst docker
    assert_rc 1
    assert_out "docker.service is not active"
    assert_no_file "$R/etc/apt/sources.list.d/docker.list"
    assert_not_called_like '^docker (--host [^ ]+ )?(ps|inspect|info|network|container|update|compose -f)'
    rm -f "$STATE/docker_inactive"
    node_acl_ready
    cp "$R/etc/swellwright-node-installer.conf" "$T/conf-before"
    cp "$R/etc/sw-node-api-allow.conf" "$T/acl-before"
    : >"$STATE/docker_inactive"
    printf '%s\n' docker.socket >"$STATE/active_units"
    : >"$STUB_LOG"
    for _action in docker node firewall apiacl full; do
        run_inst "$_action" $NODE_ARGS
        assert_rc 1
        assert_out "docker.service is not active"
    done
    for _action in preflight verify; do
        run_inst "$_action" $NODE_ARGS
        assert_rc 2
    done
    assert_not_called_like '^docker (--host [^ ]+ )?(ps|inspect|info|network|container|update|compose -f)'
    assert_not_called_like '^systemctl (enable|start|restart|stop) |^(ufw|apt-get|iptables-restore) '
    cmp -s "$T/conf-before" "$R/etc/swellwright-node-installer.conf" || fail "installer configuration changed"
    cmp -s "$T/acl-before" "$R/etc/sw-node-api-allow.conf" || fail "ACL configuration changed"
}

t_docker_without_the_compose_plugin_is_not_overwritten() {
    mkstub docker <<'EOF'
case "$1" in compose) exit 1 ;; esac
exit 0
EOF
    have docker
    run_inst docker
    assert_rc 1
    assert_out "without the compose plugin"
    assert_not_called_like '^apt-get'
}

t_docker_refuses_an_unknown_system() {
    set_os other
    run_inst docker
    assert_rc 1
    assert_out "Docker's apt repository is set up for Debian and Ubuntu only (this is examplelinux)"
    assert_not_out "Preparing the Docker repository"
    assert_not_called_like '^(dpkg|curl|gpg|apt-get) '
    assert_no_file "$R/etc/apt/sources.list.d/docker.list"
}

t_docker_refuses_a_missing_release_before_preparing_apt() {
    printf 'ID=ubuntu\n' >"$R/etc/os-release"
    run_inst docker
    assert_rc 1
    assert_out "Cannot tell the release name from /etc/os-release"
    assert_not_out "Preparing the Docker repository"
    assert_not_called_like '^(dpkg|curl|gpg|apt-get) '
}

t_certsync_step() {
    run_inst certsync NODE_DOMAIN=node1.example.com CERTSYNC_PUBKEY="$KEY1"
    assert_rc 0
    assert_called "useradd -r -m -s /bin/bash certsync"
    _ak="$R/home/certsync/.ssh/authorized_keys"
    # One line: the forced command rrsync limited to the certificate directory, restrict, then the key as given.
    assert_line "$_ak" "command=\"rrsync /opt/certs/\",restrict $KEY1"
    [ "$(grep -c . "$_ak")" = 1 ] || fail "authorized_keys must hold exactly the one line"
    assert_mode_recorded 600 "$_ak"
    assert_mode_recorded 700 "$R/home/certsync/.ssh"
    assert_mode_recorded 755 "$R/opt/certs"
    assert_called "chown certsync: $R/home/certsync/.ssh"
    assert_called "chown certsync: $R/home/certsync/.ssh/authorized_keys"
    # No certificate yet: a temporary self-signed one, key readable by the owner and the group only.
    assert_file "$R/opt/certs/fullchain.cer"
    assert_file "$R/opt/certs/private.key"
    assert_mode_recorded 640 "$R/opt/certs/private.key"
    # Again: no change, and a real certificate that arrived in between is left alone.
    printf 'REAL CERTIFICATE\n' >"$R/opt/certs/fullchain.cer"
    run_inst certsync NODE_DOMAIN=node1.example.com CERTSYNC_PUBKEY="$KEY1"
    assert_rc 0
    assert_out "unchanged"
    assert_line "$R/opt/certs/fullchain.cer" "REAL CERTIFICATE"
    [ "$(grep -c useradd "$STUB_LOG")" = 1 ] || fail "the user was created twice"
}

t_certsync_needs_a_key_and_rrsync() {
    run_inst certsync NODE_DOMAIN=node1.example.com
    assert_rc 1
    assert_out "CERTSYNC_PUBKEY is required"
    remove_cmd rrsync
    run_inst certsync NODE_DOMAIN=node1.example.com CERTSYNC_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "rrsync not found"
    assert_not_called_like '^useradd'
}

t_certsync_key_with_options_is_refused() {
    run_inst certsync NODE_DOMAIN=node1.example.com CERTSYNC_PUBKEY='command="id",no-restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAM'
    assert_rc 1
    assert_out "Invalid value for CERTSYNC_PUBKEY"
    assert_not_called_like '^useradd'
}

t_nginx_step() {
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 0
    # The repository, its key (checked against the pinned fingerprints) and the pin.
    assert_line "$R/usr/share/keyrings/nginx-archive-keyring.gpg" "KEY-NGINX"
    assert_line "$R/etc/apt/sources.list.d/nginx.list" "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] https://nginx.org/packages/ubuntu noble nginx"
    assert_not_called_like '^curl .*http://'
    assert_contains "$R/etc/apt/preferences.d/99nginx" "Pin: origin nginx.org"
    assert_called "apt-get -o DPkg::Lock::Timeout=600 install -y -o Dpkg::Options::=--force-confold nginx"
    # The site of the node.
    _c="$R/etc/nginx/conf.d"
    assert_contains "$_c/default.conf" "server_name node1.example.com;"
    assert_contains "$_c/default.conf" 'return 301 https://$host$request_uri;'
    assert_contains "$_c/selfsni.conf" "listen unix:/dev/shm/nginx.sock ssl proxy_protocol;"
    assert_contains "$_c/selfsni.conf" "http2 on;"
    assert_contains "$_c/selfsni.conf" "server_name node1.example.com;"
    assert_contains "$_c/selfsni.conf" "ssl_certificate     /opt/certs/fullchain.cer;"
    assert_contains "$_c/selfsni.conf" "ssl_certificate_key /opt/certs/private.key;"
    assert_contains "$_c/selfsni.conf" "real_ip_header      proxy_protocol;"
    assert_contains "$_c/selfsni.conf" 'try_files $uri $uri/ =404;'
    # The default site: HTTPS without or with a foreign SNI lands on 127.0.0.1:8444 and gets a 404; port 80 by IP too.
    assert_contains "$_c/default-decoy.conf" "listen 127.0.0.1:8444 ssl proxy_protocol default_server;"
    assert_contains "$_c/default-decoy.conf" "set_real_ip_from    127.0.0.1;"
    assert_contains "$_c/default-decoy.conf" "server_names_hash_bucket_size 64;"
    assert_contains "$_c/default-decoy.conf" "listen 80 default_server;"
    [ "$(grep -c 'return 404;' "$_c/default-decoy.conf")" = 2 ] || fail "both default servers must answer 404"
    assert_not_contains "$_c/default-decoy.conf" "server_name "
    assert_file "$R/etc/nginx/ssl-default/default.crt"
    assert_mode_recorded 600 "$R/etc/nginx/ssl-default/default.key"
    assert_file "$R/var/www/html/site/index.html"
    assert_contains "$R/var/www/html/site/index.html" "Welcome"
    # A certificate delivered later is picked up: a path unit reloads nginx when the directory changes.
    assert_contains "$R/etc/systemd/system/sw-certs-reload.path" "PathChanged=/opt/certs"
    assert_contains "$R/etc/systemd/system/sw-certs-reload.path" "Unit=sw-certs-reload.service"
    assert_contains "$R/etc/systemd/system/sw-certs-reload.service" "ExecStart=/bin/sh -c 'nginx -t && systemctl reload nginx'"
    assert_called "systemctl enable --now sw-certs-reload.path"
    assert_order "nginx -t" "systemctl restart nginx"
}

t_nginx_on_debian() {
    set_os debian
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 0
    assert_line "$R/etc/apt/sources.list.d/nginx.list" "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] https://nginx.org/packages/debian bookworm nginx"
}

t_nginx_refuses_an_unknown_system_before_preparing_apt() {
    set_os other
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 1
    assert_out "The nginx.org repository is set up for Debian and Ubuntu only (this is examplelinux)"
    assert_not_out "Preparing the nginx.org repository"
    assert_not_called_like '^(dpkg|curl|gpg|apt-get) '
    assert_no_file "$R/etc/apt/sources.list.d/nginx.list"
}

t_nginx_refuses_a_key_with_another_fingerprint() {
    printf 'KEY-BAD\n' >"$STATE/key_nginx"
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 1
    assert_out "nginx.org signing key"
    assert_no_file "$R/etc/apt/sources.list.d/nginx.list"
    assert_no_file "$R/usr/share/keyrings/nginx-archive-keyring.gpg"
    [ -z "$(ls -A "$R/usr/share/keyrings")" ] || fail "a temporary keyring was left: $(ls -A "$R/usr/share/keyrings")"
    assert_not_called_like ' install .* nginx$'
}

t_nginx_mixed_bundle_installs_only_the_pinned_keys() {
    printf 'KEY-NGINX\nKEY-BAD\n' >"$STATE/key_nginx"
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 0
    assert_line "$R/usr/share/keyrings/nginx-archive-keyring.gpg" "KEY-NGINX"
    assert_not_contains "$R/usr/share/keyrings/nginx-archive-keyring.gpg" "KEY-BAD"
    assert_contains "$R/var/log/swellwright-node-installer.log" "which is not pinned: it is left out of the keyring"
}

# What an older installer left: the whole download as the keyring (a key nobody pinned in it) and the repository over http.
# Both are made again.
t_nginx_replaces_a_keyring_with_an_unpinned_key_and_an_http_source() {
    printf 'KEY-NGINX\nKEY-BAD\n' >"$R/usr/share/keyrings/nginx-archive-keyring.gpg"
    mkdir -p "$R/etc/apt/preferences.d"
    printf 'deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/ubuntu noble nginx\n' >"$R/etc/apt/sources.list.d/nginx.list"
    printf 'Package: *\nPin: origin nginx.org\nPin-Priority: 900\n\n' >"$R/etc/apt/preferences.d/99nginx"
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 0
    assert_called_like '^curl -q --proto =https .*https://nginx.org/keys/nginx_signing.key$'
    assert_not_contains "$R/usr/share/keyrings/nginx-archive-keyring.gpg" "KEY-BAD"
    assert_line "$R/etc/apt/sources.list.d/nginx.list" "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] https://nginx.org/packages/ubuntu noble nginx"
    assert_called "apt-get -o DPkg::Lock::Timeout=600 -o APT::Update::Error-Mode=any update"
}

t_nginx_stops_on_a_configuration_error() {
    mkdir -p "$R/etc/nginx/conf.d"
    printf 'previous default\n' >"$R/etc/nginx/conf.d/default.conf"
    printf 'previous SelfSNI\n' >"$R/etc/nginx/conf.d/selfsni.conf"
    fail_on "nginx -t"
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 1
    assert_out "nginx -t: configuration error"
    assert_not_called "systemctl restart nginx"
    assert_line "$R/etc/nginx/conf.d/default.conf" "previous default"
    assert_line "$R/etc/nginx/conf.d/selfsni.conf" "previous SelfSNI"
    assert_no_file "$R/etc/nginx/conf.d/default-decoy.conf"
    assert_not_called "systemctl enable --now sw-certs-reload.path"
}

t_nginx_is_idempotent() {
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 0
    : >"$STUB_LOG"
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 0
    assert_out "unchanged: /etc/nginx/conf.d/selfsni.conf"
    assert_out "unchanged: /etc/nginx/conf.d/default-decoy.conf"
    # No key download, but installing packages must still refresh trusted indices once.
    assert_not_called_like '^curl'
    assert_order_like '^apt-get .*APT::Update::Error-Mode=any update$' '^apt-get .* install .* nginx$'
    [ "$(grep -c '^apt-get .* update$' "$STUB_LOG")" = 1 ] || fail "expected one strict index refresh"
    ls "$R/etc/nginx/conf.d/"*.bak.* >/dev/null 2>&1 && fail "a backup was made although nothing changed"
    return 0
}

t_haproxy_step_from_the_ppa() {
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 0
    assert_called "add-apt-repository -y ppa:vbernat/haproxy-3.2"
    assert_called_like 'install -y -o Dpkg::Options::=--force-confold haproxy=3\.2\.\*$'
    assert_order "add-apt-repository -y ppa:vbernat/haproxy-3.2" "apt-get -o DPkg::Lock::Timeout=600 install -y -o Dpkg::Options::=--force-confold haproxy=3.2.*"
    _h="$R/etc/haproxy/haproxy.cfg"
    assert_contains "$_h" "bind 192.0.2.10:443"
    assert_contains "$_h" "use_backend xray_vless if { req_ssl_sni -i node1.example.com }"
    assert_contains "$_h" "default_backend decoy_default"
    assert_contains "$_h" "server xray 127.0.0.1:443 check"
    assert_contains "$_h" "server nginx_default 127.0.0.1:8444 send-proxy"
    assert_contains "$_h" "tcp-request content accept if { req_ssl_hello_type 1 }"
    assert_contains "$_h" "mode tcp"
    # The default backend is the decoy, never a rejection.
    assert_not_contains "$_h" "reject"
    assert_order "haproxy -c -f $_h" "systemctl restart haproxy"
    assert_called "systemctl enable haproxy"
}

t_haproxy_on_debian_uses_the_distribution_package() {
    set_os debian
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 0
    assert_not_called_like '^add-apt-repository'
    assert_called_like 'install -y -o Dpkg::Options::=--force-confold haproxy$'
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10 HAPROXY_SOURCE=ppa
    assert_rc 1
    assert_out "The HAProxy PPA is for Ubuntu"
}

t_haproxy_source_and_version_are_parameters() {
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10 HAPROXY_SOURCE=distro
    assert_rc 0
    assert_not_called_like '^add-apt-repository'
    remove_cmd haproxy
    : >"$STUB_LOG"
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10 HAPROXY_VERSION=3.0
    assert_rc 0
    assert_called "add-apt-repository -y ppa:vbernat/haproxy-3.0"
    assert_called_like 'haproxy=3\.0\.\*$'
}

t_haproxy_right_version_installed_is_kept() {
    have haproxy
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 0
    assert_not_called_like '^add-apt-repository'
    assert_not_called_like '^apt-get'
}

t_haproxy_stops_on_a_configuration_error() {
    mkdir -p "$R/etc/haproxy"
    printf 'previous HAProxy configuration\n' >"$R/etc/haproxy/haproxy.cfg"
    have haproxy
    fail_on "haproxy -c"
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 1
    assert_out "haproxy -c: configuration error"
    assert_not_called "systemctl restart haproxy"
    assert_line "$R/etc/haproxy/haproxy.cfg" "previous HAProxy configuration"
}

t_node_refuses_latest_before_running_docker() {
    have docker
    for _tag in latest LaTeSt latest-alpine Nightly nightly-20261128 main MASTER dev EDGE; do
        run_inst node $NODE_ARGS NODE_IMAGE_TAG="$_tag"
        assert_rc 1
        assert_out "Invalid value for NODE_IMAGE_TAG"
    done
    assert_not_called_like '^docker '
}

t_node_does_not_export_secret_values_or_leave_compose_staging_files() {
    have docker
    node_acl_ready
    run_inst node $NODE_ARGS NEW_USER_PASSWORD='synthetic admin password'
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" "- SECRET_KEY=\"$SECRET\""
}

t_node_cleans_secret_staging_after_a_failed_install() {
    node_acl_ready
    fail_on "install -m 600"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "Could not write /opt/remnanode/docker-compose.yml"
    for _staging in "$R"/run/.sw-write.* "$T"/tmp/*; do
        [ ! -f "$_staging" ] || fail "a temporary file was left after the compose write failed"
    done
}

# The generated file is checked by a real HAProxy when the machine has one (CI installs it).
t_haproxy_config_is_valid_for_a_real_haproxy() {
    [ -n "$REAL_HAPROXY" ] || skip "haproxy is not installed"
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 0
    "$REAL_HAPROXY" -c -f "$R/etc/haproxy/haproxy.cfg" >"$T/out" 2>&1 || fail "haproxy -c rejects the generated configuration"
}

t_node_guard_never_publishes_until_acl_apply_succeeds() {
    have docker ufw
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    printf 'Status: active\n' >"$STATE/ufw_status"
    printf -- '-N DOCKER-USER\n-A DOCKER-USER -p tcp --dport 8080 -j RETURN\n' >"$STATE/iptables_rules"
    : >"$STUB_LOG"
    fail_on "iptables-restore"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_not_called_like '^docker .* (up|start) '
    assert_not_called_like '^systemctl (restart|stop) (docker|ssh)'
    assert_line "$STATE/iptables_rules" '-A DOCKER-USER -p tcp --dport 8080 -j RETURN'
    : >"$STATE/fail"
    : >"$STUB_LOG"
    run_inst node $NODE_ARGS
    assert_rc 0
    assert_order_like '^iptables-restore ' '^docker .* start '
    assert_line "$STATE/iptables_rules" '-A DOCKER-USER -p tcp --dport 8080 -j RETURN'
}

t_node_guard_refuses_port_change_before_writing_configuration() {
    have docker ufw
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    cp "$R/etc/swellwright-node-installer.conf" "$T/before"
    : >"$STUB_LOG"
    for _step in node apiacl firewall full; do
        run_inst "$_step" $NODE_ARGS NODE_PORT=3000
        assert_rc 1
        assert_out "Changing the node API port is not supported"
        cmp -s "$T/before" "$R/etc/swellwright-node-installer.conf" || fail "saved port was changed"
    done
    assert_no_file "$R/opt/remnanode/docker-compose.yml"
    assert_not_called_like '^(ufw|iptables-restore|apt-get) '
}

t_node_guard_refuses_an_unrecognized_existing_container() {
    have docker
    run_inst apiacl PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    printf 'remnawave/node:3.4.6\n' >"$STATE/container"
    : >"$STATE/foreign_node"
    : >"$STUB_LOG"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "ownership or topology"
    assert_no_file "$R/opt/remnanode/docker-compose.yml"
    assert_not_called_like '^docker .* (update|stop|create|up|start) '
}

t_node_guard_refuses_unexpected_bindings_state_and_backend() {
    node_acl_ready
    printf 'remnawave/node:3.4.6\n' >"$STATE/container"
    printf 'NODE_PORT=62050\n' >"$STATE/container_env"
    printf 'always\n' >"$STATE/restart_policy"
    printf '443/tcp|127.0.0.1|443\n62050/tcp|0.0.0.0|62050\n62050/tcp|::|62050\n' >"$STATE/node_bindings"
    : >"$STUB_LOG"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "bindings do not match"
    rm -f "$STATE/node_bindings"
    printf 'NODE_PORT=3000\n' >"$STATE/container_env"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "container NODE_PORT does not match"
    printf 'NODE_PORT=62050\n' >"$STATE/container_env"
    printf 'restarting\n' >"$STATE/node_state"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "not in a supported state"
    rm -f "$STATE/node_state"
    printf 'nftables\n' >"$STATE/docker_backend"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "must use the IPv4 iptables firewall backend"
    printf 'iptables\n' >"$STATE/docker_backend"
    printf 'linux true []\n' >"$STATE/docker_info"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "live-restore disabled"
    printf 'linux false []\n' >"$STATE/docker_info"
    printf 'neighbor\n' >"$STATE/node_members"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "the node bridge is shared with other containers"
    assert_not_called_like '^docker .* (update|stop|create|up|start) '
    assert_line "$STATE/restart_policy" always
    assert_no_file "$R/opt/remnanode/docker-compose.yml"
}

t_node_guard_migration_disarms_old_restart_before_stop_and_recovers() {
    node_acl_ready
    printf 'remnawave/node:3.4.6\n' >"$STATE/container"
    printf 'NODE_PORT=62050\n' >"$STATE/container_env"
    printf 'always\n' >"$STATE/restart_policy"
    printf 'running\n' >"$STATE/node_state"
    fail_on 'iptables-restore'
    : >"$STUB_LOG"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_order_like '^docker .* update --restart=no ' '^docker .* container stop '
    assert_order_like '^docker .* container stop ' '^docker .* compose .* create '
    assert_line "$STATE/restart_policy" no
    assert_line "$STATE/node_state" created
    assert_not_called_like '^docker .* (up|start) '
    assert_not_called_like '^systemctl (restart|stop) (docker|ssh)'
    : >"$STATE/fail"
    : >"$STUB_LOG"
    run_inst node $NODE_ARGS
    assert_rc 0
    assert_not_called_like '^docker .* update '
    assert_order_like '^iptables-restore ' '^docker .* container start '
    assert_line "$STATE/node_state" running
}

t_node_refuses_unsafe_host_paths_before_stopping_or_preparing() {
    node_acl_ready
    _dir="$R/opt/remnanode"
    mkdir -p "$_dir"
    printf 'unmodified\n' >"$_dir/docker-compose.yml"
    : >"$STUB_LOG"
    printf '777\n' >"$_dir.mode"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "Unsafe node path"
    rm -f "$_dir.mode"
    printf '4242\n' >"$_dir/docker-compose.yml.owner"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "Unsafe node path"
    rm -f "$_dir/docker-compose.yml.owner"
    printf '666\n' >"$R/usr/local/sbin/sw-node-api-acl.sh.mode"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "Unsafe node path"
    rm -f "$R/usr/local/sbin/sw-node-api-acl.sh.mode"
    printf '[Service]\nExecStart=/bin/true\n' >"$R/etc/systemd/system/sw-node.service"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "Unknown node unit"
    assert_line "$_dir/docker-compose.yml" unmodified
    assert_not_called_like '^systemctl (stop|start|restart) |^docker .* (stop|update|compose -f)'
}

t_node_stop_retains_the_receipt_when_docker_is_inactive() {
    node_acl_ready
    run_inst node $NODE_ARGS
    assert_rc 0
    assert_line "$R/etc/systemd/system/sw-node.service" 'RuntimeDirectoryPreserve=yes'
    : >"$STATE/docker_inactive"
    : >"$STUB_LOG"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} systemctl stop sw-node.service >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 1
    assert_file "$R/run/sw-node/container"
    assert_not_called_like '^docker .* (inspect|stop|start) '
    rm -f "$STATE/docker_inactive"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} systemctl stop sw-node.service >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 0
    assert_no_file "$R/run/sw-node/container"
    : >"$STATE/docker_inactive"
    : >"$STUB_LOG"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} systemctl stop sw-node.service >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 0
    assert_not_called_like '^docker '
}

t_node_refuses_compose_symlinks() {
    node_acl_ready
    _dir="$R/opt/remnanode"
    mkdir -p "$_dir"
    printf 'unmodified\n' >"$T/target"
    if ln -s "$T/target" "$_dir/docker-compose.yml" && [ -L "$_dir/docker-compose.yml" ]; then
        : >"$STUB_LOG"
        run_inst node $NODE_ARGS
        assert_rc 1
        assert_out "Unsafe node path"
        assert_line "$T/target" unmodified
        assert_not_called_like '^systemctl (stop|start|restart) |^docker .* (stop|update|compose -f)'
    else
        skip "symbolic links are unavailable"
    fi
}

t_node_refuses_loaded_unit_overrides() {
    node_acl_ready
    run_inst node $NODE_ARGS
    assert_rc 0
    : >"$STATE/node_unit_override"
    : >"$STUB_LOG"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "Unknown node unit"
    assert_not_called_like '^systemctl (stop|start|restart) |^docker .* (stop|update|compose -f)'
    rm -f "$STATE/node_unit_override"
    : >"$STATE/node_unit_stale"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "Unknown node unit"
    assert_not_called_like '^systemctl (stop|start|restart) |^docker .* (stop|update|compose -f)'
}

t_node_upgrade_preserves_the_old_unit_receipt_if_stop_fails() {
    node_acl_ready
    run_inst node $NODE_ARGS
    assert_rc 0
    _unit="$R/etc/systemd/system/sw-node.service"
    sed '/^RuntimeDirectoryPreserve=yes$/d' "$_unit" >"$T/old-unit"
    cp "$T/old-unit" "$_unit"
    fail_on 'docker --host unix:///var/run/docker.sock container stop'
    : >"$STUB_LOG"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_file "$R/run/sw-node/container"
    assert_line "$_unit" 'RuntimeDirectoryPreserve=yes'
    assert_order 'systemctl daemon-reload' 'systemctl stop sw-node.service'
    assert_not_called_like '^docker .* (compose -f|container start) '
}

t_node_guard_applies_and_checks_acl_on_boot_docker_restart_and_retry() {
    node_acl_ready
    run_inst node $NODE_ARGS
    assert_rc 0
    _unit="$R/etc/systemd/system/sw-node.service"
    assert_line "$_unit" 'WantedBy=docker.service'
    assert_line "$_unit" 'BindsTo=docker.service'
    assert_line "$_unit" 'PartOf=docker.service'
    assert_line "$_unit" 'After=docker.service sw-node-api-acl.service'
    assert_line "$_unit" 'Restart=always'
    assert_line "$_unit" 'Wants=sw-node-api-acl.service'
    assert_line "$_unit" 'NotifyAccess=main'
    assert_line "$_unit" 'ExecStart=/usr/local/sbin/sw-node-lifecycle.sh start'
    assert_line "$_unit" 'ExecStop=/usr/local/sbin/sw-node-lifecycle.sh stop'
    assert_line "$_unit" 'ExecStopPost=/usr/local/sbin/sw-node-lifecycle.sh stop'
    assert_called_like '^systemd-notify --ready --pid=[0-9]+$'
    fake_systemctl() {
        env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} systemctl "$@" >"$T/out" 2>"$T/err"
        RC=$?
    }
    # The stub models dependency triggers; it executes the real startup helper in each case.
    printf -- '-P FORWARD ACCEPT\n' >"$STATE/ipt.FORWARD"
    : >"$STUB_LOG"
    fake_systemctl restart docker.service
    assert_rc 1
    assert_out 'FORWARD does not begin with an unconditional jump'
    assert_called_like '^iptables-restore '
    assert_not_called_like '^docker .* container start '
    assert_line "$STATE/node_state" exited
    printf -- '-P FORWARD DROP\n-A FORWARD -j DOCKER-USER\n' >"$STATE/ipt.FORWARD"
    : >"$STUB_LOG"
    fake_systemctl start sw-node.service
    assert_rc 0
    assert_order_like '^iptables-restore ' '^docker .* container start '
    assert_order_like '^docker .* container start ' '^docker .* container wait '
    fake_systemctl stop sw-node.service
    printf 'ALLOW_SRC="192.0.2.20"\nNODE_PORT=3000\n' >"$R/etc/sw-node-api-allow.conf"
    : >"$STUB_LOG"
    fake_systemctl start docker.service
    assert_rc 1
    assert_out 'ACL port does not match'
    assert_not_called_like '^docker .* container start '
    assert_not_called_like '^iptables-restore '
    printf 'ALLOW_SRC="192.0.2.20"\nNODE_PORT=62050\n' >"$R/etc/sw-node-api-allow.conf"
    fake_systemctl start docker.service
    assert_rc 0
    assert_order_like '^iptables-restore ' '^docker .* container start '
    assert_not_called_like '^docker .* compose '
    fake_systemctl stop docker.service
    assert_rc 0
    : >"$STATE/fail_acl_service"
    : >"$STUB_LOG"
    fake_systemctl start docker.service
    assert_rc 0
    assert_order_like '^iptables-restore ' '^docker .* container start '
    fake_systemctl is-active sw-node-api-acl.service
    assert_rc 3
    rm -f "$STATE/fail_acl_service"
    : >"$STUB_LOG"
    fail_on 'docker --host unix:///var/run/docker.sock container stop'
    fake_systemctl stop sw-node.service
    assert_rc 1
    assert_out "cannot stop the guarded node"
    assert_file "$R/run/sw-node/container"
    : >"$STATE/fail"
    fake_systemctl stop sw-node.service
    assert_rc 0
    assert_line "$STATE/node_state" exited
    assert_no_file "$R/run/sw-node/container"
}

t_node_step() {
    node_acl_ready
    run_inst node $NODE_ARGS
    assert_rc 0
    _c="$R/opt/remnanode/docker-compose.yml"
    assert_contains "$_c" "image: remnawave/node:3.4.6"
    assert_not_contains "$_c" ":latest"
    assert_contains "$_c" "container_name: remnanode"
    assert_contains "$_c" "- NODE_PORT=62050"
    assert_contains "$_c" "- SNI_VERIFICATION=true"
    assert_contains "$_c" "- SECRET_KEY=\"$SECRET\""
    assert_contains "$_c" '- "127.0.0.1:443:443"'
    assert_contains "$_c" '- "0.0.0.0:62050:62050"'
    assert_contains "$_c" "- NET_ADMIN"
    assert_contains "$_c" 'max-size: "20m"'
    # The compose file holds the secret, so only its owner may read it.
    assert_mode_recorded 600 "$_c"
    assert_line "$_c" '    restart: "no"'
    assert_order_like '^docker .* compose .* pull remnanode$' '^docker .* compose .* create --no-build remnanode$'
    assert_order_like '^systemctl restart sw-node\.service$' '^docker .* container start '
    assert_not_called_like '^docker .* compose .* up '
    # The secret is nowhere else.
    assert_no_secret "$SECRET"
}

t_node_image_tag_is_a_parameter() {
    node_acl_ready NODE_PORT=3000
    run_inst node $NODE_ARGS NODE_IMAGE_TAG=3.5.0 NODE_PORT=3000
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" "image: remnawave/node:3.5.0"
    assert_contains "$R/opt/remnanode/docker-compose.yml" "- NODE_PORT=3000"
    assert_contains "$R/opt/remnanode/docker-compose.yml" '- "0.0.0.0:3000:3000"'
}

t_node_keeps_the_secret_of_an_existing_node() {
    node_acl_ready
    mkdir -p "$R/opt/remnanode"
    printf 'services:\n  remnanode:\n    environment:\n      - SECRET_KEY="OLDSECRETKEY0123456789abcdefghij"\n' >"$R/opt/remnanode/docker-compose.yml"
    run_inst node NODE_DOMAIN=node1.example.com PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" '- SECRET_KEY="OLDSECRETKEY0123456789abcdefghij"'
    assert_no_secret "OLDSECRETKEY0123456789abcdefghij"
}

# The old versions of the compose file hold no key: a new copy is made with SECRET_KEY removed and mode 600, copies an older
# installer left are cleaned the same way, and only the newest three stay.
t_node_backups_of_the_compose_file_hold_no_secret() {
    node_acl_ready
    _c="$R/opt/remnanode/docker-compose.yml"
    mkdir -p "$R/opt/remnanode"
    printf 'services:\n  remnanode:\n    environment:\n      - SECRET_KEY="OLDSECRETKEY0123456789abcdefghij"\n' >"$_c"
    for _i in 1 2 3 4; do
        printf 'services:\n  remnanode:\n    environment:\n      - SECRET_KEY="OLDBACKUPSECRET%s0123456789abcdef"\n' "$_i" >"$_c.bak.2025010100000$_i"
        chmod 644 "$_c.bak.2025010100000$_i"
    done
    run_inst node $NODE_ARGS
    assert_rc 0
    assert_contains "$_c" "- SECRET_KEY=\"$SECRET\""
    _n=$(ls -1 "$_c".bak.* | wc -l | tr -d ' ')
    [ "$_n" = 3 ] || fail "expected 3 backups of the compose file, found $_n: $(ls -1 "$_c".bak.*)"
    assert_no_file "$_c.bak.20250101000001"
    assert_no_file "$_c.bak.20250101000002"
    for _b in "$_c".bak.*; do
        assert_not_contains "$_b" "OLDSECRETKEY"
        assert_not_contains "$_b" "OLDBACKUPSECRET"
        assert_contains "$_b" '- SECRET_KEY="(removed)"'
        assert_mode_recorded 600 "$_b"
    done
    [ -z "$(ls -A "$R/opt/remnanode" | grep -v '^docker-compose.yml')" ] || fail "a temporary file was left: $(ls -A "$R/opt/remnanode")"
    assert_no_secret "OLDSECRETKEY0123456789abcdefghij"
    # Nothing changed on a second run: no new copy, the kept ones stay as they are.
    run_inst node $NODE_ARGS
    assert_rc 0
    [ "$(ls -1 "$_c".bak.* | wc -l | tr -d ' ')" = 3 ] || fail "a second run changed the backups"
}

t_node_discards_backups_with_an_unrecognized_secret_layout() {
    node_acl_ready
    _c="$R/opt/remnanode/docker-compose.yml"
    mkdir -p "$(dirname "$_c")"
    printf 'services:\n  remnanode:\n    environment:\n      SECRET_KEY: >-\n        OLDBACKUPSECRET\n' >"$_c"
    cp "$_c" "$_c.bak.20250101000000"
    run_inst node $NODE_ARGS
    assert_rc 0
    for _b in "$_c".bak.*; do
        [ ! -e "$_b" ] || fail "retained a backup with an unsupported secret format"
    done
}

t_node_needs_a_secret_and_docker() {
    run_inst node NODE_DOMAIN=node1.example.com PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_out "Docker is not installed"
    have docker
    run_inst node NODE_DOMAIN=node1.example.com PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_out "SECRET_KEY is required"
    assert_no_file "$R/opt/remnanode/docker-compose.yml"
}

t_node_stops_when_the_image_cannot_be_pulled() {
    node_acl_ready
    fail_on "docker --host unix:///var/run/docker.sock compose -f $R/opt/remnanode/docker-compose.yml --env-file /dev/null --project-name remnanode pull"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "docker compose pull failed"
    assert_not_called_like '^docker .* (up|start) '
    assert_no_secret "$SECRET"
}
