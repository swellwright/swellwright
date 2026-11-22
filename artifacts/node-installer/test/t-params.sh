# Tests of the command line, the parameters (environment, env file, saved configuration), the prompts and the journal.


# write_env FILE: an env file with mode 600 from stdin. Where the file system cannot hold the mode (NTFS under Git Bash), the
# stat stub of the suite reports it from FILE.mode.
write_env() {
    cat >"$1"; chmod 600 "$1"
    [ "$(stat -c '%a' "$1" 2>/dev/null)" = 600 ] || echo 600 >"$1.mode"
}

t_unknown_action_fails() {
    run_inst bogus
    assert_rc 1
    assert_out "Unknown action: bogus"
}

t_unknown_option_fails() {
    run_inst_args --nope
    assert_rc 1
    assert_out "Unknown option: --nope"
}

t_two_actions_fail() {
    run_inst_args base verify
    assert_rc 1
    assert_out "Only one action may be given"
}

t_root_is_required() {
    [ "$(id -u)" -ne 0 ] || skip "running as root"
    env -i PATH="$ORIG_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} HOME="$T" NO_COLOR=1 "$SHELL_UNDER_TEST" "$INSTALLER" preflight >"$T/out" 2>"$T/err" </dev/null
    RC=$?
    assert_rc 1
    assert_out "Root is needed"
}

t_env_file_is_read() {
    write_env "$T/p.env" <<'EOF'
# a comment
NODE_DOMAIN=node1.example.com
export NODE_IP="192.0.2.10"

NODE_PORT='62051'
EOF
    run_inst_args --non-interactive --env-file "$T/p.env" hostname
    assert_rc 0
    assert_called "hostnamectl set-hostname node1.example.com"
    assert_contains "$R/etc/hosts" "192.0.2.10 node1.example.com node1"
}

t_env_file_option_forms() {
    printf 'NODE_DOMAIN=node1.example.com\nNODE_IP=192.0.2.10\n' | write_env "$T/p.env"
    run_inst_args --non-interactive --env-file="$T/p.env" hostname
    assert_rc 0
    assert_called "hostnamectl set-hostname node1.example.com"
}

t_env_file_with_loose_mode_is_refused() {
    printf 'NODE_DOMAIN=node1.example.com\nNODE_IP=192.0.2.10\n' >"$T/p.env"
    chmod 644 "$T/p.env"; echo 644 >"$T/p.env.mode"
    run_inst_args --non-interactive --env-file "$T/p.env" hostname
    assert_rc 1
    assert_out "must have mode 600"
    assert_not_called "hostnamectl set-hostname node1.example.com"
}

t_env_file_is_never_executed() {
    write_env "$T/p.env" <<EOF
NODE_DOMAIN=\$(touch $T/pwned1)
NODE_IP=\`touch $T/pwned2\`
EOF
    run_inst_args --non-interactive --env-file "$T/p.env" hostname
    assert_rc 1
    assert_no_file "$T/pwned1"
    assert_no_file "$T/pwned2"
    assert_out "Invalid value for NODE_DOMAIN"
    assert_not_called_like '^hostnamectl'
}

t_env_file_unknown_name_is_refused() {
    for _bad in "NODE_PROT=1" "PATH=/tmp/evil" "LD_PRELOAD=/tmp/x" "SW_ENV_FILE=/etc/passwd"; do
        printf 'NODE_DOMAIN=node1.example.com\n%s\n' "$_bad" | write_env "$T/p.env"
        run_inst_args --non-interactive --env-file "$T/p.env" hostname
        assert_rc 1
        assert_out "unknown parameter ${_bad%%=*}"
    done
}

t_env_file_missing_is_refused() {
    run_inst_args --non-interactive --env-file "$T/nope.env" hostname
    assert_rc 1
    assert_out "Parameter file not found"
}

t_env_file_line_without_equals_is_refused() {
    printf 'NODE_DOMAIN node1.example.com\n' | write_env "$T/p.env"
    run_inst_args --non-interactive --env-file "$T/p.env" hostname
    assert_rc 1
    assert_out "a line without ="
}

t_precedence_environment_then_file_then_saved() {
    printf "NODE_DOMAIN='saved.example.com'\nNODE_PORT='1111'\nNODE_IP='192.0.2.99'\n" >"$R/etc/swellwright-node-installer.conf"
    printf 'NODE_DOMAIN=file.example.com\nNODE_PORT=2222\n' | write_env "$T/p.env"
    # The environment beats the file, the file beats the saved configuration, the saved configuration fills the rest.
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} HOME="$T" TMPDIR="$T/tmp" SW_TEST_ROOT="$R" NO_COLOR=1 NODE_DOMAIN=env.example.com \
        "$SHELL_UNDER_TEST" "$INSTALLER" --non-interactive --env-file "$T/p.env" hostname >"$T/out" 2>"$T/err" </dev/null
    RC=$?
    assert_rc 0
    assert_called "hostnamectl set-hostname env.example.com"
    assert_contains "$R/etc/hosts" "192.0.2.99 env.example.com env"
    # The file beats the saved port (the step above rewrote the saved configuration: put the old port back).
    printf "NODE_PORT='1111'\nNODE_DOMAIN='saved.example.com'\n" >"$R/etc/swellwright-node-installer.conf"
    run_inst firewall NODE_DOMAIN=ignored.example.com PANEL_ALLOW_IP=192.0.2.20 SW_ENV_FILE="$T/p.env"
    assert_rc 0
    assert_called "ufw allow from 192.0.2.20 to any port 2222 proto tcp"
}

t_saved_configuration_fills_gaps_and_holds_no_secret() {
    run_inst node $NODE_ARGS NODE_DOMAIN=node1.example.com
    assert_rc 1
    have docker
    run_inst node $NODE_ARGS
    assert_rc 0
    assert_file "$R/etc/swellwright-node-installer.conf"
    assert_contains "$R/etc/swellwright-node-installer.conf" "NODE_DOMAIN='node1.example.com'"
    assert_contains "$R/etc/swellwright-node-installer.conf" "NODE_PORT='62050'"
    assert_contains "$R/etc/swellwright-node-installer.conf" "PANEL_ALLOW_IP='192.0.2.20'"
    assert_not_contains "$R/etc/swellwright-node-installer.conf" "SECRET"
    assert_no_secret_in_file "$R/etc/swellwright-node-installer.conf"
    # A later run without parameters uses what was saved.
    run_inst firewall
    assert_rc 0
    assert_called "ufw allow from 192.0.2.20 to any port 62050 proto tcp"
}

assert_no_secret_in_file() { ! grep -qF -- "$SECRET" "$1" || fail "the secret is in ${1#"$T"/}"; }

t_missing_required_parameter_stops_the_run() {
    run_inst firewall NODE_DOMAIN=node1.example.com
    assert_rc 1
    assert_out "PANEL_ALLOW_IP is required"
    assert_not_called "ufw --force enable"
}

t_invalid_parameter_stops_before_any_step() {
    run_inst firewall PANEL_ALLOW_IP=192.0.2.20 NODE_PORT=70000
    assert_rc 1
    assert_out "Invalid value for NODE_PORT"
    assert_not_called_like '^ufw'
    # The message names the parameter and the format, never the value.
    run_inst node $NODE_ARGS HAPROXY_SOURCE=weird
    assert_rc 1
    assert_out "Invalid value for HAPROXY_SOURCE"
    assert_no_secret "$SECRET"
}

t_invalid_secret_is_not_echoed() {
    run_inst node NODE_DOMAIN=node1.example.com PANEL_ALLOW_IP=192.0.2.20 SECRET_KEY='SENTINEL bad secret"quote'
    assert_rc 1
    assert_out "Invalid value for SECRET_KEY"
    assert_not_out "SENTINEL"
}

t_values_are_normalised() {
    run_inst hostname NODE_DOMAIN=Node1.EXAMPLE.com NODE_IP=" 192.0.2.10 "
    assert_rc 0
    assert_called "hostnamectl set-hostname node1.example.com"
    run_inst firewall PANEL_ALLOW_IP='192.0.2.20,198.51.100.7'
    assert_rc 0
    assert_called "ufw allow from 192.0.2.20 to any port 62050 proto tcp"
    assert_called "ufw allow from 198.51.100.7 to any port 62050 proto tcp"
}

t_node_ip_is_guessed_only_when_unambiguous() {
    run_inst hostname NODE_DOMAIN=node1.example.com
    assert_rc 0
    assert_contains "$R/etc/hosts" "192.0.2.10 node1.example.com node1"
    # Two addresses and an A record that names neither: nothing to choose from.
    printf '2: eth0    inet 192.0.2.10/24 scope global eth0\n3: eth1    inet 198.51.100.5/24 scope global eth1\n' >"$STATE/ip_addr"
    printf 'node1.example.com 203.0.113.9\n' >"$STATE/dns"
    rm -f "$R/etc/swellwright-node-installer.conf"
    : >"$R/etc/hosts"
    run_inst hostname NODE_DOMAIN=node1.example.com
    assert_rc 1
    assert_out "NODE_IP is required"
    # Two addresses and an A record that names one of them: that one.
    printf 'node1.example.com 198.51.100.5\n' >"$STATE/dns"
    run_inst hostname NODE_DOMAIN=node1.example.com
    assert_rc 0
    assert_contains "$R/etc/hosts" "198.51.100.5 node1.example.com node1"
}

t_prompts_validate_and_retry() {
    printf 'bad_domain\n\nnode1.example.com\n\n' >"$T/in"
    run_inst hostname SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    assert_rc 0
    assert_out "Not valid"
    assert_out "A value is required"
    assert_called "hostnamectl set-hostname node1.example.com"
    assert_contains "$T/tty" "Node domain"
    # Without an answer the default (the address that matches the A record) is taken.
    assert_contains "$T/tty" "[192.0.2.10]"
}

t_prompt_eof_stops_instead_of_looping() {
    : >"$T/in"
    run_inst hostname SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    assert_rc 1
    assert_out "No input for NODE_DOMAIN"
}

t_secret_prompt_is_not_logged() {
    have docker
    printf '\n%s\n' "$SECRET" >"$T/in"
    run_inst node SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty" NODE_DOMAIN=node1.example.com PANEL_ALLOW_IP=192.0.2.20
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" "SECRET_KEY=\"$SECRET\""
    assert_no_secret "$SECRET"
    assert_not_contains "$T/tty" "$SECRET"
}

t_menu_runs_a_step_and_exits() {
    printf '3\n\n0\n' >"$T/in"
    run_inst menu SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    assert_rc 0
    assert_out "Preflight checks"
    assert_contains "$T/tty" "Choice"
}

t_menu_needs_a_terminal() {
    run_inst menu
    assert_rc 1
    assert_out "The menu needs a terminal"
}

t_no_terminal_without_the_flag_stops_with_advice() {
    run_inst hostname SW_NONINTERACTIVE=0 SW_TTY_IN="$T/does-not-exist"
    assert_rc 1
    assert_out "There is no terminal to ask on"
    assert_out "--non-interactive"
}

t_read_only_actions_need_no_terminal() {
    run_inst preflight SW_NONINTERACTIVE=0 SW_TTY_IN="$T/does-not-exist"
    assert_rc 0
    run_inst verify SW_NONINTERACTIVE=0 SW_TTY_IN="$T/does-not-exist"
    assert_not_out "no terminal"
}

t_colours_and_ascii() {
    run_inst demo
    ! grep -q "$(printf '\033')" "$T/out" || fail "colour codes without a terminal"
    run_inst demo SW_FORCE_COLOR=1
    grep -q "$(printf '\033')" "$T/out" || fail "SW_FORCE_COLOR=1 gives no colour"
    run_inst demo SW_ASCII=1
    ! LC_ALL=C grep -q "$(printf '\342')" "$T/out" || fail "SW_ASCII=1 still prints Unicode symbols"
    run_inst demo SW_FORCE_COLOR=1 NO_COLOR=1
    grep -q "$(printf '\033')" "$T/out" || fail "SW_FORCE_COLOR beats NO_COLOR for the tests"
}

t_journal_is_private_and_complete() {
    run_inst system
    assert_rc 0
    _log="$R/var/log/swellwright-node-installer.log"
    assert_file "$_log"
    assert_mode_recorded 600 "$_log"
    # The version in the journal is the one of the installer (a number that is raised with every change of the script).
    _ver=$(sed -n 's/^INSTALLER_VERSION=//p' "$INSTALLER")
    assert_contains "$_log" "=== swellwright-node-installer $_ver, action: system"
    assert_contains "$_log" "== System tuning"
    assert_contains "$_log" "OK written: /etc/sysctl.d/99-sw-net.conf"
}

t_concurrent_runs_are_refused() {
    # flock is stubbed to succeed: here only the call is checked.
    run_inst system
    assert_called_like '^flock -n 9$'
}
