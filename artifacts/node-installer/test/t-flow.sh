# Tests of the SSH step (it must never lose access), rename, verify, preflight, full and the read-only actions.

SSHD_DEFAULT='#PermitRootLogin prohibit-password
PasswordAuthentication yes
'

# admin_exists: an administrator with a key, as the user phase leaves it.
admin_exists() {
    echo admin >>"$STATE/users"; echo admin >>"$STATE/sudo_members"; echo admin >>"$STATE/haspw"
    mkdir -p "$R/home/admin/.ssh"
    printf '%s\n' "$KEY1" >"$R/home/admin/.ssh/authorized_keys"
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
}

# ---------------------------------------------------------------- ssh

t_ssh_user_phase() {
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    run_inst ssh SSH_PHASE=user NEW_USER=admin NEW_USER_PUBKEY="$KEY1" NEW_USER_PUBKEY2="$KEY2" NEW_USER_PASSWORD='correct horse battery staple'
    assert_rc 0
    assert_called "adduser --disabled-password --gecos  admin"
    assert_called "usermod -aG sudo admin"
    _ak="$R/home/admin/.ssh/authorized_keys"
    assert_line "$_ak" "$KEY1"
    assert_line "$_ak" "$KEY2"
    assert_mode_recorded 600 "$_ak"
    assert_mode_recorded 700 "$R/home/admin/.ssh"
    # sudo needs a password; it reaches chpasswd on the standard input, never an argument, the journal or the screen.
    assert_line "$STATE/chpasswd.in" "admin:correct horse battery staple"
    assert_no_secret "correct horse battery staple"
    assert_no_secret "battery"
    # sudo itself is installed when it is missing; nothing of sshd is touched in this phase.
    assert_called_like 'install -y .* sudo$'
    assert_not_called_like '^sshd'
    assert_not_called_like '^systemctl (restart|reload) ssh'
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    # Again: the keys are not duplicated, the account is not created again and the password is not reset.
    run_inst ssh SSH_PHASE=user NEW_USER=admin NEW_USER_PUBKEY="$KEY1" NEW_USER_PUBKEY2="$KEY2" NEW_USER_PASSWORD='another password here'
    assert_rc 0
    [ "$(grep -c . "$_ak")" = 2 ] || fail "keys were duplicated"
    [ "$(grep -c '^adduser' "$STUB_LOG")" = 1 ] || fail "the account was created twice"
    [ "$(grep -c '^chpasswd' "$STUB_LOG")" = 1 ] || fail "the password was set again"
    assert_no_secret "another password here"
}

# An authorized_keys file written without a final line break (a provider's image, a hand edit) must not swallow the new key.
t_ssh_user_phase_appends_the_key_to_a_file_without_a_final_line_break() {
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    mkdir -p "$R/home/admin/.ssh"
    printf '%s' "$KEY2" >"$R/home/admin/.ssh/authorized_keys"
    run_inst ssh SSH_PHASE=user NEW_USER=admin NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD='correct horse battery staple'
    assert_rc 0
    assert_line "$R/home/admin/.ssh/authorized_keys" "$KEY1"
    assert_line "$R/home/admin/.ssh/authorized_keys" "$KEY2"
}

t_ssh_user_phase_without_password_stops_before_creating_anything() {
    run_inst ssh SSH_PHASE=user NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "NEW_USER_PASSWORD is required"
    assert_not_called_like '^adduser'
    assert_no_file "$R/home/admin"
}

t_ssh_user_phase_sets_a_missing_password_of_an_existing_account() {
    echo admin >>"$STATE/users"
    run_inst ssh SSH_PHASE=user NEW_USER=admin NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD='correct horse battery staple'
    assert_rc 0
    assert_not_called_like '^adduser'
    assert_line "$STATE/chpasswd.in" "admin:correct horse battery staple"
}

t_ssh_user_must_not_be_root_or_certsync() {
    for _u in root certsync; do
        run_inst ssh SSH_PHASE=user NEW_USER=$_u NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD='correct horse battery staple'
        assert_rc 1
        assert_out "Invalid value for NEW_USER"
    done
    assert_not_called_like '^adduser'
}

t_ssh_root_phase() {
    admin_exists
    run_inst ssh SSH_PHASE=root
    assert_rc 0
    assert_contains "$R/etc/ssh/sshd_config" "PermitRootLogin no"
    assert_not_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin"
    assert_line "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf" "PermitRootLogin no"
    assert_order "sshd -t" "systemctl restart ssh"
    # Password login stays open unless asked for.
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
    assert_contains "$R/etc/ssh/sshd_config" "PasswordAuthentication yes"
    assert_not_called_like '^adduser'
}

t_ssh_root_login_stays_when_asked() {
    admin_exists
    run_inst ssh SSH_PHASE=root SSH_DISABLE_ROOT=no
    assert_rc 0
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_not_called_like '^systemctl (restart|reload) ssh'
}

t_ssh_never_closes_root_without_an_administrator() {
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    run_inst ssh SSH_PHASE=root
    assert_rc 1
    assert_out "The sudo group has no members"
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_not_called_like '^sshd'
    assert_not_called_like '^systemctl (restart|reload)'
}

t_ssh_reverts_a_configuration_sshd_refuses() {
    admin_exists
    fail_on "sshd -t"
    run_inst ssh SSH_PHASE=root
    assert_rc 1
    assert_out "sshd -t: configuration error, the change was reverted"
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_not_contains "$R/etc/ssh/sshd_config" "PermitRootLogin no"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_not_called_like '^systemctl (restart|reload)'
}

t_ssh_password_login_closes_only_with_a_key() {
    admin_exists
    run_inst ssh SSH_PHASE=root SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=yes
    assert_rc 0
    assert_contains "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf" "PasswordAuthentication no"
    assert_contains "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf" "KbdInteractiveAuthentication no"
    assert_order "sshd -t" "systemctl reload ssh"
    # The administrator has no key: refused, nothing written.
    : >"$R/home/admin/.ssh/authorized_keys"
    rm -f "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
    run_inst ssh SSH_PHASE=root SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=yes
    assert_rc 1
    assert_out "Refusing to close password login"
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
}

t_ssh_removes_the_keys_only_file_when_sshd_refuses_it() {
    admin_exists
    fail_on "sshd -t"
    run_inst ssh SSH_PHASE=root SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=yes
    assert_rc 1
    assert_out "the file was removed"
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
}

t_ssh_all_phases_in_order() {
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    run_inst ssh NEW_USER=admin NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD='correct horse battery staple'
    assert_rc 0
    assert_order "usermod -aG sudo admin" "sshd -t"
    assert_line "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf" "PermitRootLogin no"
}

t_ssh_interactive_questions_can_be_declined() {
    admin_exists
    printf 'n\nn\n' >"$T/in"
    run_inst ssh SSH_PHASE=root SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    assert_rc 0
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
    assert_contains "$T/tty" "[Y/n]"
    assert_contains "$T/tty" "[y/N]"
    # Enter accepts the defaults: root login closed, password login left open.
    printf '\n\n' >"$T/in"
    run_inst ssh SSH_PHASE=root SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    assert_rc 0
    assert_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
}

# ---------------------------------------------------------------- rename

# a_node: the files a node installation leaves, written by the steps themselves.
a_node() {
    have nginx haproxy docker
    run_inst hostname $NODE_ARGS || true
    run_inst nginx $NODE_ARGS
    assert_rc 0
    run_inst haproxy $NODE_ARGS
    assert_rc 0
    : >"$STUB_LOG"
}

t_rename_step() {
    a_node
    run_inst rename NODE_DOMAIN=node2.example.com RENAME_ALIAS=node1.example.com
    assert_rc 0
    assert_contains "$R/etc/nginx/conf.d/default.conf" "server_name node2.example.com node1.example.com;"
    assert_contains "$R/etc/nginx/conf.d/selfsni.conf" "server_name node2.example.com node1.example.com;"
    assert_contains "$R/etc/haproxy/haproxy.cfg" "use_backend xray_vless if { req_ssl_sni -i node2.example.com node1.example.com }"
    assert_line "$R/etc/hosts" "192.0.2.10 node2.example.com node2"
    assert_not_contains "$R/etc/hosts" "node1.example.com"
    assert_called "hostnamectl set-hostname node2.example.com"
    assert_order "nginx -t" "systemctl reload nginx"
    assert_order "haproxy -c -f $R/etc/haproxy/haproxy.cfg" "systemctl reload haproxy"
    assert_not_called "systemctl restart nginx"
    assert_contains "$R/etc/swellwright-node-installer.conf" "NODE_DOMAIN='node2.example.com'"
    assert_out "The alias (node1.example.com) stays"
    # The alias is removed by running the step again without it.
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 0
    assert_contains "$R/etc/nginx/conf.d/selfsni.conf" "server_name node2.example.com;"
    assert_not_contains "$R/etc/nginx/conf.d/selfsni.conf" "node1.example.com"
    assert_contains "$R/etc/haproxy/haproxy.cfg" "use_backend xray_vless if { req_ssl_sni -i node2.example.com }"
    # Only the names changed: the rest of the HAProxy file is as it was.
    assert_contains "$R/etc/haproxy/haproxy.cfg" "default_backend decoy_default"
    assert_contains "$R/etc/haproxy/haproxy.cfg" "bind 192.0.2.10:443"
}

# The README promises that a file is never rewritten with the same content and that only a changed file keeps a backup.
# A second run with the same names must not leave new backups (found on a real server: every run added four).
t_rename_with_the_same_names_again_changes_and_backs_up_nothing() {
    a_node
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 0
    rm -f "$R"/etc/nginx/conf.d/*.bak.* "$R"/etc/haproxy/*.bak.* "$R"/etc/hosts.bak.*
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 0
    ls "$R"/etc/nginx/conf.d/*.bak.* "$R"/etc/haproxy/*.bak.* "$R"/etc/hosts.bak.* >/dev/null 2>&1 && fail "a second run left backups of files it did not change"
    assert_contains "$R/etc/nginx/conf.d/selfsni.conf" "server_name node2.example.com;"
    assert_line "$R/etc/hosts" "192.0.2.10 node2.example.com node2"
    [ "$(grep -c 'node2.example.com' "$R/etc/hosts")" = 1 ] || fail "the hosts line was changed or added twice"
}

# A refused configuration restores what this run changed and nothing else: with nothing changed there is nothing to
# restore, and an older backup of an earlier rename must not come back.
t_rename_that_changes_nothing_does_not_bring_an_older_backup_back() {
    a_node
    run_inst rename NODE_DOMAIN=node2.example.com RENAME_ALIAS=node1.example.com
    assert_rc 0
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 0
    fail_on "nginx -t"
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 1
    assert_contains "$R/etc/nginx/conf.d/selfsni.conf" "server_name node2.example.com;"
    assert_not_contains "$R/etc/nginx/conf.d/selfsni.conf" "node1.example.com"
    assert_contains "$R/etc/haproxy/haproxy.cfg" "req_ssl_sni -i node2.example.com }"
}

t_rename_adds_the_hosts_line_after_a_last_line_without_a_line_break() {
    a_node
    printf '198.51.100.5	vm-name' >"$R/etc/hosts"
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 0
    assert_line "$R/etc/hosts" "198.51.100.5	vm-name"
    assert_line "$R/etc/hosts" "192.0.2.10 node2.example.com node2"
}

t_rename_restores_everything_when_a_configuration_is_refused() {
    a_node
    fail_on "nginx -t"
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 1
    assert_out "the files were restored"
    assert_contains "$R/etc/nginx/conf.d/selfsni.conf" "server_name node1.example.com;"
    assert_contains "$R/etc/nginx/conf.d/default.conf" "server_name node1.example.com;"
    assert_contains "$R/etc/haproxy/haproxy.cfg" "req_ssl_sni -i node1.example.com }"
    assert_not_called_like '^hostnamectl'
    assert_not_called_like '^systemctl reload'
}

t_rename_restores_everything_when_haproxy_refuses() {
    a_node
    fail_on "haproxy -c"
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 1
    assert_contains "$R/etc/nginx/conf.d/selfsni.conf" "server_name node1.example.com;"
    assert_contains "$R/etc/haproxy/haproxy.cfg" "req_ssl_sni -i node1.example.com }"
    assert_not_called_like '^hostnamectl'
}

t_rename_needs_the_configuration_of_this_installer() {
    run_inst rename NODE_DOMAIN=node2.example.com RENAME_FROM=node1.example.com
    assert_rc 1
    assert_out "renaming works on the configuration this installer writes"
}

t_rename_needs_a_former_name() {
    a_node
    rm -f "$R/etc/swellwright-node-installer.conf"
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 1
    assert_out "RENAME_FROM: the former domain is unknown"
}

# ---------------------------------------------------------------- verify

t_verify_healthy_node() {
    healthy_state
    if make_socket "$R/dev/shm/nginx.sock"; then _sock=yes; else _sock=no; fi
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    if [ "$_sock" = yes ]; then
        assert_rc 0
        assert_out "Total: "
        [ "$(grep -c 'CHECK fail' "$R/var/log/swellwright-node-installer.log")" = 0 ] || fail "a check failed on a healthy node"
    else
        # No unix socket on this platform: that one check fails and nothing else does.
        assert_rc 2
        assert_out "missing /dev/shm/nginx.sock"
        [ "$(grep -c 'CHECK fail' "$R/var/log/swellwright-node-installer.log")" = 1 ] || fail "more than the socket check failed"
    fi
    assert_out "Container remnanode"
    assert_out "port 62050 is for the panel only"
    assert_out "404 (the default site)"
    _log="$R/var/log/swellwright-node-installer.log"
    assert_contains "$_log" "CHECK ok | Node API port: DOCKER-USER rules | port 62050 is for the panel only"
    assert_contains "$_log" "CHECK ok | SNI_VERIFICATION | true"
}

t_verify_failures_give_exit_code_2() {
    healthy_state
    : >"$STATE/iptables_rules"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 2
    assert_out "no rules: port 62050 is open to everybody"
}

t_verify_reports_a_missing_container() {
    healthy_state
    rm -f "$STATE/container"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 2
    assert_out "no container"
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK fail | Container remnanode"
}

t_verify_reports_sni_verification_off() {
    healthy_state
    printf 'NODE_PORT=62050\n' >"$STATE/container_env"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 2
    assert_out "not true"
}

t_verify_reports_a_foreign_sni_that_is_answered() {
    healthy_state
    echo 200 >"$STATE/http_decoy"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 2
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK fail | HTTPS with a foreign SNI"
}

t_verify_reports_a_stopped_service() {
    healthy_state
    printf '%s\n' docker nginx fail2ban sw-certs-reload.path sw-node-api-acl.service >"$STATE/active_units"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 2
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK fail | HAProxy"
}

t_verify_warns_about_a_self_signed_certificate() {
    healthy_state
    printf 'CN = node1.example.com\n' >"$STATE/cert_issuer"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK warn | SelfSNI certificate | self-signed"
    printf 'CN = Example CA\n' >"$STATE/cert_issuer"
    printf 'notAfter=Jan  1 00:00:00 2001 GMT\n' >"$STATE/cert_end"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK fail | SelfSNI certificate | expires in"
}

t_verify_reads_the_saved_configuration() {
    healthy_state
    printf "NODE_DOMAIN='node1.example.com'\nNODE_IP='192.0.2.10'\nNODE_PORT='62050'\n" >"$R/etc/swellwright-node-installer.conf"
    run_inst verify
    assert_out "HTTPS with the SNI of the node"
    assert_not_out "NODE_DOMAIN and NODE_IP are not known"
}

# ---------------------------------------------------------------- preflight

t_preflight_on_supported_systems() {
    run_inst preflight
    assert_rc 0
    assert_out "Ubuntu 24.04"
    set_os debian
    run_inst preflight
    assert_rc 0
    assert_out "Debian GNU/Linux 12"
    assert_not_out "written for Debian 12 and Ubuntu"
}

t_preflight_warns_about_other_systems_and_fails_without_apt() {
    set_os other
    run_inst preflight
    assert_rc 0
    assert_out "written for Debian 12 and Ubuntu 22.04 / 24.04"
    remove_cmd apt-get
    run_inst preflight
    assert_rc 2
    assert_out "apt-get not found"
}

t_preflight_reports_a_busy_port() {
    printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("apache2",pid=1,fd=4))\n' >"$STATE/ss"
    run_inst preflight
    assert_rc 0
    assert_out "in use"
}

# ---------------------------------------------------------------- full

t_full_installation_runs_every_step_in_order() {
    run_inst full $NODE_ARGS CERTSYNC_PUBKEY="$KEY1"
    assert_rc 0
    assert_out "Step 1/12"
    assert_out "Step 12/12"
    # The order matters: the firewall before Docker, the API restriction after Docker, nginx before HAProxy, the node last.
    _c="$R/opt/remnanode/docker-compose.yml"
    assert_order "hostnamectl set-hostname node1.example.com" "ufw --force enable"
    assert_order "ufw --force enable" "systemctl restart fail2ban"
    assert_order "systemctl restart fail2ban" "systemctl enable --now docker"
    assert_order "systemctl enable --now docker" "systemctl restart sw-node-api-acl.service"
    assert_order "systemctl restart sw-node-api-acl.service" "useradd -r -m -s /bin/bash certsync"
    assert_order "useradd -r -m -s /bin/bash certsync" "systemctl restart nginx"
    assert_order "systemctl restart nginx" "systemctl restart haproxy"
    assert_order "systemctl restart haproxy" "docker compose -f $_c up -d"
    assert_order "docker compose -f $_c up -d" "docker inspect -f {{.State.Status}} remnanode"
    # The report and the checklist.
    assert_out "Node installation: result"
    assert_out "What is left to do"
    assert_out "A record node1.example.com -> 192.0.2.10"
    assert_out 'target "/dev/shm/nginx.sock", xver 1, serverNames ["node1.example.com"]'
    # SSH hardening is not part of full.
    assert_not_called_like '^adduser'
    assert_not_called_like '^sshd -t'
    assert_no_secret "$SECRET"
    assert_contains "$_c" "SECRET_KEY=\"$SECRET\""
}

t_full_skips_the_certificate_receiver_without_a_key() {
    run_inst full $NODE_ARGS
    assert_rc 0
    assert_out "Step 11/11"
    assert_out "No CERTSYNC_PUBKEY"
    assert_not_called_like '^useradd'
    assert_no_file "$R/home/certsync"
    assert_file "$R/opt/certs/fullchain.cer"
}

t_full_stops_at_the_first_failed_step() {
    fail_on "docker compose -f"
    run_inst full $NODE_ARGS
    assert_rc 1
    assert_out "The installation stopped at an error"
    assert_called_like '^systemctl restart haproxy$'
    # verify is the last step and was never reached.
    assert_not_called_like '^docker inspect'
    assert_no_secret "$SECRET"
}

t_full_does_not_fail_on_a_verify_warning() {
    run_inst full $NODE_ARGS
    # The stubbed system is not healthy (no listening ports): verify reports failures, full still ends successfully.
    assert_rc 0
    assert_out "Checks"
}

t_redeploy_has_its_own_checklist() {
    run_inst redeploy $NODE_ARGS
    assert_rc 0
    assert_out "Node redeployment: result"
    assert_out "Do not create a node, a profile or hosts"
    assert_not_out 'target "/dev/shm/nginx.sock"'
}

t_full_with_prompts() {
    printf 'node1.example.com\n\n\n\n192.0.2.20\n\n%s\ny\n' "$SECRET" >"$T/in"
    run_inst full SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" "SECRET_KEY=\"$SECRET\""
    assert_called "ufw allow from 192.0.2.20 to any port 62050 proto tcp"
    assert_contains "$T/tty" "Start the installation (11 steps)?"
    assert_no_secret "$SECRET"
}

t_full_can_be_cancelled() {
    printf 'node1.example.com\n\n\n\n192.0.2.20\n\n%s\nn\n' "$SECRET" >"$T/in"
    run_inst full SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    assert_rc 0
    assert_out "Cancelled"
    assert_not_called_like '^ufw'
    assert_not_called_like '^docker compose'
}

# ---------------------------------------------------------------- what read-only means

t_read_only_actions_change_nothing() {
    healthy_state
    find "$R" -type f | grep -v "$R/var/log/\|$R/run/" | sort >"$T/before"
    for _a in preflight verify; do
        run_inst "$_a" NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    done
    for _a in help version demo; do
        run_inst "$_a"
        assert_rc 0
    done
    find "$R" -type f | grep -v "$R/var/log/\|$R/run/" | sort >"$T/after"
    cmp -s "$T/before" "$T/after" || fail "a read-only action created or removed a file"
    assert_not_called_like '^(apt-get|add-apt-repository|useradd|adduser|usermod|chpasswd|hostnamectl|modprobe|journalctl|rsync|install|chown)( |$)'
    assert_not_called_like '^ufw (allow|delete|--force|enable)'
    assert_not_called_like '^systemctl (restart|reload|enable|start|stop|daemon-reload)'
    assert_not_called_like '^docker compose'
    assert_not_called_like '^iptables -[NIDAFPX]'
    assert_not_called_like '^sysctl -q'
    assert_not_called_like '^sshd -t'
}
