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
    # SSH is allowed before the firewall is switched on.
    assert_order "ufw allow 22/tcp" "ufw --force enable"
    assert_order "ufw allow from 198.51.100.7 to any port 62050 proto tcp" "ufw --force enable"
}

t_firewall_follows_the_ports() {
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

t_firewall_stops_when_ufw_cannot_be_enabled() {
    fail_on "ufw --force enable"
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20
    assert_rc 1
    assert_out "UFW could not be enabled"
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
    assert_contains "$R/etc/systemd/system/sw-node-api-acl.service" "ExecStart=/usr/local/sbin/sw-node-api-acl.sh apply"
    assert_contains "$R/etc/systemd/system/sw-node-api-acl.service" "After=docker.service"
    assert_contains "$R/etc/systemd/system/sw-node-api-acl.service" "PartOf=docker.service"
    assert_mode_recorded 755 "$R/usr/local/sbin/sw-node-api-acl.sh"
    assert_mode_recorded 644 "$R/etc/sw-node-api-allow.conf"
    assert_mode_recorded 644 "$R/etc/systemd/system/sw-node-api-acl.service"
    assert_order "systemctl daemon-reload" "systemctl restart sw-node-api-acl.service"
    assert_called "systemctl enable sw-node-api-acl.service"
    # UFW is active: the same restriction there, and never a rule for everybody.
    assert_called "ufw delete allow 62050/tcp"
    assert_called "ufw allow from 192.0.2.20 to any port 62050 proto tcp"
    assert_called "ufw allow from 198.51.100.7 to any port 62050 proto tcp"
    assert_not_called_like '^ufw allow 62050'
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

t_apiacl_script_orders_the_rules() {
    have docker
    run_inst apiacl PANEL_ALLOW_IP='192.0.2.20 198.51.100.7'
    assert_rc 0
    # Run the helper itself against a stub iptables that already holds an old rule of ours and Docker's own rule.
    sed "s#/etc/sw-node-api-allow.conf#$R/etc/sw-node-api-allow.conf#" "$R/usr/local/sbin/sw-node-api-acl.sh" >"$T/acl.sh"
    printf -- '-A DOCKER-USER -s 192.0.2.99/32 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j RETURN\n-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j DROP\n-A DOCKER-USER -j RETURN\n' >"$STATE/iptables_rules"
    : >"$STUB_LOG"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} "$SHELL_UNDER_TEST" "$T/acl.sh" apply >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 0
    assert_called "iptables -N DOCKER-USER"
    # The old rules for this port are deleted, Docker's own rule is not.
    assert_called "iptables -D DOCKER-USER -s 192.0.2.99/32 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j RETURN"
    assert_called "iptables -D DOCKER-USER -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j DROP"
    assert_not_called "iptables -D DOCKER-USER -j RETURN"
    # The allowed sources first, the DROP for everybody else last; the DROP has no source.
    assert_called "iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -s 192.0.2.20 -j RETURN"
    assert_called "iptables -I DOCKER-USER 2 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -s 198.51.100.7 -j RETURN"
    assert_called "iptables -I DOCKER-USER 3 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j DROP"
    assert_order "iptables -I DOCKER-USER 2 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -s 198.51.100.7 -j RETURN" "iptables -I DOCKER-USER 3 -p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL -j DROP"
    # remove and status, and a usage error for anything else.
    : >"$STUB_LOG"
    env -i PATH="$SUT_PATH" "$SHELL_UNDER_TEST" "$T/acl.sh" status >/dev/null 2>&1
    assert_called "iptables -S DOCKER-USER"
    env -i PATH="$SUT_PATH" "$SHELL_UNDER_TEST" "$T/acl.sh" bogus >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 2
}

t_docker_from_the_apt_repository() {
    run_inst docker
    assert_rc 0
    assert_called_like '^curl .*https://download.docker.com/linux/ubuntu/gpg$'
    assert_file "$R/etc/apt/keyrings/docker.asc"
    assert_line "$R/etc/apt/sources.list.d/docker.list" "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable"
    assert_called "apt-get -o DPkg::Lock::Timeout=600 install -y -o Dpkg::Options::=--force-confold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
    assert_order "apt-get -o DPkg::Lock::Timeout=600 update" "apt-get -o DPkg::Lock::Timeout=600 install -y -o Dpkg::Options::=--force-confold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
    assert_called "systemctl enable --now docker"
    assert_not_called_like 'get.docker.com'
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

t_docker_refuses_a_failed_download() {
    : >"$STATE/key_docker"
    run_inst docker
    assert_rc 1
    assert_no_file "$R/etc/apt/sources.list.d/docker.list"
}

t_docker_with_the_convenience_script() {
    run_inst docker DOCKER_SOURCE=script
    assert_rc 0
    assert_called_like '^curl -fsSL -o .* https://get.docker.com$'
    assert_not_called_like 'docker-ce'
    assert_no_file "$R/etc/apt/sources.list.d/docker.list"
    assert_called "systemctl enable --now docker"
}

t_docker_already_installed() {
    have docker
    run_inst docker
    assert_rc 0
    assert_out "already installed"
    assert_not_called_like '^curl'
    assert_not_called_like '^apt-get'
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
    assert_out "Debian and Ubuntu only"
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
    assert_file "$R/usr/share/keyrings/nginx-archive-keyring.gpg"
    assert_line "$R/etc/apt/sources.list.d/nginx.list" "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/ubuntu noble nginx"
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
    assert_line "$R/etc/apt/sources.list.d/nginx.list" "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/debian bookworm nginx"
}

t_nginx_refuses_a_key_with_another_fingerprint() {
    printf 'KEY-BAD\n' >"$STATE/key_nginx"
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 1
    assert_out "nginx.org signing key"
    assert_no_file "$R/etc/apt/sources.list.d/nginx.list"
    assert_not_called_like ' install .* nginx$'
}

t_nginx_stops_on_a_configuration_error() {
    fail_on "nginx -t"
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 1
    assert_out "nginx -t: configuration error"
    assert_not_called "systemctl restart nginx"
}

t_nginx_is_idempotent() {
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 0
    : >"$STUB_LOG"
    run_inst nginx NODE_DOMAIN=node1.example.com
    assert_rc 0
    assert_out "unchanged: /etc/nginx/conf.d/selfsni.conf"
    assert_out "unchanged: /etc/nginx/conf.d/default-decoy.conf"
    # The key and the repository are already there: no key download and no extra package list update.
    assert_not_called_like '^curl'
    assert_not_called "apt-get -o DPkg::Lock::Timeout=600 update"
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
    have haproxy
    fail_on "haproxy -c"
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 1
    assert_out "haproxy -c: configuration error"
    assert_not_called "systemctl restart haproxy"
}

# The generated file is checked by a real HAProxy when the machine has one (CI installs it).
t_haproxy_config_is_valid_for_a_real_haproxy() {
    [ -n "$REAL_HAPROXY" ] || skip "haproxy is not installed"
    run_inst haproxy NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 0
    "$REAL_HAPROXY" -c -f "$R/etc/haproxy/haproxy.cfg" >"$T/out" 2>&1 || fail "haproxy -c rejects the generated configuration"
}

t_node_step() {
    have docker
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
    assert_order "docker compose -f $_c pull" "docker compose -f $_c up -d"
    # The secret is nowhere else.
    assert_no_secret "$SECRET"
}

t_node_image_tag_is_a_parameter() {
    have docker
    run_inst node $NODE_ARGS NODE_IMAGE_TAG=3.5.0 NODE_PORT=3000
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" "image: remnawave/node:3.5.0"
    assert_contains "$R/opt/remnanode/docker-compose.yml" "- NODE_PORT=3000"
    assert_contains "$R/opt/remnanode/docker-compose.yml" '- "0.0.0.0:3000:3000"'
}

t_node_keeps_the_secret_of_an_existing_node() {
    have docker
    mkdir -p "$R/opt/remnanode"
    printf 'services:\n  remnanode:\n    environment:\n      - SECRET_KEY="OLDSECRETKEY0123456789abcdefghij"\n' >"$R/opt/remnanode/docker-compose.yml"
    run_inst node NODE_DOMAIN=node1.example.com PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" '- SECRET_KEY="OLDSECRETKEY0123456789abcdefghij"'
    assert_no_secret "OLDSECRETKEY0123456789abcdefghij"
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
    have docker
    fail_on "docker compose -f"
    run_inst node $NODE_ARGS
    assert_rc 1
    assert_out "docker compose pull failed"
    assert_not_called_like ' up -d$'
    assert_no_secret "$SECRET"
}
