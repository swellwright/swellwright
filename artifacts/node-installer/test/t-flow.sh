# Tests of the SSH step (it must never lose access), rename, verify, preflight, full and the read-only actions.

SSHD_DEFAULT='#PermitRootLogin prohibit-password
PasswordAuthentication yes
'

# admin_exists: an administrator with a key, as the user phase leaves it.
admin_exists() {
    add_admin admin
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
    # sudo itself is installed when it is missing; sshd is only asked (sshd -T), its configuration is not touched in this phase.
    assert_called_like 'install -y .* sudo$'
    assert_not_called_like '^sshd -t'
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

t_ssh_user_phase_refuses_an_existing_system_account_before_changes() {
    echo www-data >>"$STATE/users"
    echo 33 >"$STATE/uid_www-data"
    run_inst ssh SSH_PHASE=user NEW_USER=www-data NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD='synthetic admin password'
    assert_rc 1
    assert_out "not an ordinary account"
    assert_not_called_like '^(adduser|usermod|chpasswd) '
    assert_no_file "$R/home/www-data/.ssh/authorized_keys"
}

t_ssh_root_phase() {
    admin_exists
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 0
    assert_contains "$R/etc/ssh/sshd_config" "PermitRootLogin no"
    assert_not_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin"
    assert_line "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf" "PermitRootLogin no"
    assert_order "sshd -t" "systemctl restart ssh"
    # The rollback is armed before anything is written and disarmed only after sshd runs with the new configuration.
    assert_order "systemctl enable --now sw-ssh-rollback.timer" "sshd -t"
    assert_order "sync -f $R/etc/systemd/system" "sshd -t"
    assert_order_like '^systemctl restart ssh$' '^systemctl stop sw-ssh-rollback\.timer$'
    assert_out "the change is kept (the automatic rollback is disarmed)"
    assert_no_file "$R/var/lib/swellwright-ssh-rollback/rollback.sh"
    assert_no_file "$R/etc/systemd/system/sw-ssh-rollback.timer"
    assert_no_file "$R/etc/systemd/system/sw-ssh-rollback.service"
    # Password login stays open unless asked for.
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
    assert_contains "$R/etc/ssh/sshd_config" "PasswordAuthentication yes"
    assert_not_called_like '^adduser'
}

# Without a named administrator and key nothing is closed (a run without a terminal stops before it changes anything).
t_ssh_root_phase_needs_the_named_administrator() {
    admin_exists
    run_inst ssh SSH_PHASE=root
    assert_rc 1
    assert_out "NEW_USER is required"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_not_called "systemctl enable --now sw-ssh-rollback.timer"
    assert_not_called_like '^systemctl (restart|reload)'
}

t_ssh_root_phase_refuses_without_live_login_confirmation() {
    admin_exists
    run_inst ssh SSH_PHASE=root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "requires a terminal"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_not_called_like '^systemctl (enable --now sw-ssh-rollback|restart ssh)'
}

t_ssh_never_writes_hardening_before_a_confirmed_login() {
    admin_exists
    printf '\n\n\n\nn\n' >"$T/in"
    run_inst ssh SSH_PHASE=root NEW_USER=admin NEW_USER_PUBKEY="$KEY1" \
        SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    assert_rc 1
    assert_out "No existing login was confirmed"
    assert_not_called_like '^systemctl (enable --now sw-ssh-rollback|restart ssh)|^sshd -t'
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
}

assert_ssh_files_restored() {
    assert_rc 1
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_not_contains "$R/etc/ssh/sshd_config" "PermitRootLogin no"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
}

# A successful immediate rollback restores the files, then stops the timer.
rolled_back() {
    assert_ssh_files_restored
    assert_called "systemctl stop sw-ssh-rollback.timer"
    assert_no_file "$R/var/lib/swellwright-ssh-rollback/rollback.sh"
}

# sshd -T shows what sshd would really load: when another file keeps root login open, the change is undone, nothing restarted.
t_ssh_reverts_a_change_that_is_not_in_effect() {
    admin_exists
    : >"$STATE/sshd_ignores_dropins"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    rolled_back
    assert_out "sshd -T: PermitRootLogin is yes in effect, not no"
    assert_not_called_like '^systemctl restart ssh'
}

# The new configuration would keep the named administrator out (a Match block, say): undone before sshd is restarted.
t_ssh_reverts_a_change_that_locks_the_administrator_out() {
    admin_exists
    mkstub sshd <<'EOF'
case "${1:-}" in
    -t) printf 'port 22\npermitrootlogin no\npubkeyauthentication yes\nusepam yes\nstrictmodes yes\nauthorizedkeysfile .ssh/authorized_keys\ndenyusers admin\n' >"$STUB_STATE/sshd_T.admin" ;;
    -T) if [ -f "$STUB_STATE/sshd_T.admin" ]; then cat "$STUB_STATE/sshd_T.admin"
        else printf 'port 22\npermitrootlogin yes\npubkeyauthentication yes\nusepam yes\nstrictmodes yes\nauthorizedkeysfile .ssh/authorized_keys\n'; fi ;;
esac
exit 0
EOF
    have sshd
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    rolled_back
    assert_out "with the new configuration, admin cannot be shown to log in: DenyUsers keeps it out"
    assert_not_called_like '^systemctl restart ssh'
}

t_ssh_restart_that_fails_brings_the_old_configuration_back() {
    admin_exists
    fail_on "systemctl restart ssh"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    # sshd did not come back with the old files either: the rollback is not reported as done, the saved files stay.
    assert_out "Could not restart SSH; the old configuration is back; but the rollback did not complete"
    assert_file "$R/var/lib/swellwright-ssh-rollback/rollback.sh"
    assert_no_file "$R/var/lib/swellwright-ssh-rollback/done"
    # The timer stays armed as a second chance, and its run (sshd restarts now) completes the rollback.
    assert_not_called "systemctl stop sw-ssh-rollback.timer"
    : >"$STATE/fail"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} "$SHELL_UNDER_TEST" "$R/var/lib/swellwright-ssh-rollback/rollback.sh" >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 0
    assert_file "$R/var/lib/swellwright-ssh-rollback/done"
}

t_ssh_sshd_not_running_after_the_restart_brings_the_old_configuration_back() {
    admin_exists
    : >"$STATE/ssh_down"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_ssh_files_restored
    assert_out "sshd is not running after the restart"
    assert_out "the rollback did not complete"
    _plan="$R/var/lib/swellwright-ssh-rollback"
    assert_line "$_plan/claim" rollback
    assert_file "$_plan/1"
    assert_no_file "$_plan/done"
    assert_not_called "systemctl stop sw-ssh-rollback.timer"
    rm -f "$STATE/ssh_down"
    run_automatic_ssh_rollback
    assert_rc 0
    assert_no_file "$_plan"
}

t_ssh_norestart_validates_restored_files_and_active_service() {
    admin_exists
    : >"$STATE/sshd_reject_candidate"
    : >"$STATE/ssh_down"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_ssh_files_restored
    assert_out "the rollback did not complete"
    _plan="$R/var/lib/swellwright-ssh-rollback"
    assert_file "$_plan/1"
    assert_no_file "$_plan/done"
    assert_not_called "systemctl stop sw-ssh-rollback.timer"
    assert_not_called_like '^systemctl restart ssh'
    rm -f "$STATE/ssh_down"
    fail_on 'sshd -t'
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} "$SHELL_UNDER_TEST" "$_plan/rollback.sh" norestart >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 1
    assert_no_file "$_plan/done"
    : >"$STATE/fail"
    run_automatic_ssh_rollback
    assert_rc 0
    assert_no_file "$_plan"
}

# The run dies before confirmation: the timer's script, run as systemd would,
# puts the old configuration back and restarts sshd.
t_ssh_rollback_script_restores_the_old_configuration() {
    admin_exists
    printf 'PasswordAuthentication yes\n' >"$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
    : >"$STATE/interrupt_before_confirmation"
    run_ssh_confirmed root SSH_DISABLE_PASSWORD=yes NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    [ "$RC" -ne 0 ] || fail "the installer was not interrupted"
    assert_line "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf" "PermitRootLogin no"
    assert_line "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf" "PasswordAuthentication no"
    assert_file "$R/var/lib/swellwright-ssh-rollback/rollback.sh"
    : >"$STUB_LOG"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} "$SHELL_UNDER_TEST" "$R/var/lib/swellwright-ssh-rollback/rollback.sh" >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 0
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_line "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf" "PasswordAuthentication yes"
    assert_called "systemctl restart ssh"
    # It waited for the lock of the SSH change first (so the two never write at the same time), and said it is done.
    assert_called "flock 8"
    assert_file "$R/var/lib/swellwright-ssh-rollback/done"
}

run_automatic_ssh_rollback() {
    _test_rollback="$R/var/lib/swellwright-ssh-rollback/rollback.sh"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} "$SHELL_UNDER_TEST" \
        "$_test_rollback" automatic >"$T/out" 2>"$T/err"
    RC=$?
}

t_ssh_automatic_rollback_cleans_up_after_restoring_ssh() {
    admin_exists
    : >"$STATE/interrupt_before_confirmation"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    [ "$RC" -ne 0 ] || fail "the installer was not interrupted"
    : >"$STUB_LOG"
    run_automatic_ssh_rollback
    assert_rc 0
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_order "systemctl restart ssh" "systemctl disable sw-ssh-rollback.timer"
    assert_not_called "systemctl stop sw-ssh-rollback.service"
    assert_no_file "$R/etc/systemd/system/sw-ssh-rollback.timer"
    assert_no_file "$R/etc/systemd/system/sw-ssh-rollback.service"
    assert_no_file "$R/var/lib/swellwright-ssh-rollback"
    assert_contains "$R/var/log/swellwright-node-installer.log" "Automatic SSH rollback: restored"
    assert_contains "$R/var/log/swellwright-node-installer.log" "Automatic SSH rollback: cleanup complete"
}

t_ssh_automatic_rollback_retries_cleanup_without_restoring_twice() {
    admin_exists
    : >"$STATE/interrupt_before_confirmation"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    [ "$RC" -ne 0 ] || fail "the installer was not interrupted"
    fail_on "systemctl disable sw-ssh-rollback.timer"
    run_automatic_ssh_rollback
    assert_rc 1
    _plan="$R/var/lib/swellwright-ssh-rollback"
    assert_line "$_plan/claim" "rollback"
    assert_file "$_plan/done"
    assert_file "$_plan/1"
    assert_file "$R/etc/systemd/system/sw-ssh-rollback.timer"
    assert_contains "$R/var/log/swellwright-node-installer.log" "Automatic SSH rollback: cleanup incomplete"
    : >"$STATE/fail"
    : >"$STUB_LOG"
    run_automatic_ssh_rollback
    assert_rc 0
    assert_not_called_like '^systemctl restart ssh'
    assert_no_file "$_plan"
}

t_ssh_automatic_rollback_resumes_after_interrupted_cleanup() {
    admin_exists
    : >"$STATE/interrupt_before_confirmation"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    [ "$RC" -ne 0 ] || fail "the installer was not interrupted"
    : >"$STATE/interrupt_disable"
    run_automatic_ssh_rollback
    [ "$RC" -ne 0 ] || fail "cleanup was not interrupted"
    _plan="$R/var/lib/swellwright-ssh-rollback"
    assert_file "$_plan/done"
    assert_file "$_plan/1"
    assert_contains "$R/var/log/swellwright-node-installer.log" "Automatic SSH rollback: restored"
    : >"$STUB_LOG"
    run_automatic_ssh_rollback
    assert_rc 0
    assert_not_called_like '^systemctl restart ssh'
    assert_no_file "$_plan"
}

t_ssh_automatic_rollback_recovers_if_snapshot_deletion_was_interrupted() {
    admin_exists
    : >"$STATE/interrupt_before_confirmation"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    [ "$RC" -ne 0 ] || fail "the installer was not interrupted"
    _plan="$R/var/lib/swellwright-ssh-rollback"
    # Pretend a recursive delete removed part of the snapshot before it failed.
    mkstub rm <<EOF
if [ "\$*" = "-rf $_plan" ]; then
    "$(command -v rm)" -f "$_plan/done"
    exit 1
fi
exec "$(command -v rm)" "\$@"
EOF
    have rm
    run_automatic_ssh_rollback
    assert_rc 1
    assert_line "$_plan.completed" "restored"
    assert_no_file "$_plan/done"
    assert_no_file "$R/etc/systemd/system/sw-ssh-rollback.timer"
    : >"$STUB_LOG"
    run_automatic_ssh_rollback
    assert_rc 1
    assert_not_called_like '^systemctl restart ssh'
    remove_cmd rm
    rm -f "$STATE/interrupt_before_confirmation"
    : >"$STUB_LOG"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 0
    assert_no_file "$_plan"
    assert_no_file "$_plan.completed"
    [ "$(grep -cx 'systemctl restart ssh' "$STUB_LOG")" = 1 ] || fail "a completed rollback was replayed"
}

t_ssh_incomplete_automatic_rollback_retains_recovery_state() {
    admin_exists
    : >"$STATE/interrupt_before_confirmation"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    [ "$RC" -ne 0 ] || fail "the installer was not interrupted"
    : >"$STUB_LOG"
    fail_on "systemctl restart ssh"
    run_automatic_ssh_rollback
    assert_rc 1
    _plan="$R/var/lib/swellwright-ssh-rollback"
    assert_line "$_plan/claim" "rollback"
    assert_no_file "$_plan/done"
    assert_file "$_plan/1"
    assert_not_called_like '^systemctl (stop|disable) sw-ssh-rollback'
    assert_contains "$R/var/log/swellwright-node-installer.log" "Automatic SSH rollback: incomplete"
}

t_ssh_rollback_is_persistent_and_retries_a_failed_restart() {
    admin_exists
    # Keep the armed plan and force the first restart of the restored configuration to fail.
    : >"$STATE/interrupt_before_confirmation"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    [ "$RC" -ne 0 ] || fail "the installer was not interrupted"
    _timer="$R/etc/systemd/system/sw-ssh-rollback.timer"
    _backup="$R/var/lib/swellwright-ssh-rollback"
    assert_line "$_timer" "OnActiveSec=300s"
    assert_line "$_timer" "WantedBy=timers.target"
    assert_called "systemctl enable --now sw-ssh-rollback.timer"
    assert_file "$R/etc/systemd/system/sw-ssh-rollback.service"
    assert_file "$_backup/rollback.sh"
    : >"$STATE/fail"
    : >"$STUB_LOG"
    mkstub systemctl <<'EOF'
case "$*" in
    'restart ssh')
        if [ -f "$STUB_STATE/rollback_restart_failed" ]; then
            : >"$STUB_STATE/rollback_restart_succeeded"; exit 0
        fi
        : >"$STUB_STATE/rollback_restart_failed"; exit 1 ;;
    'restart sshd') exit 1 ;;
    'is-active ssh'|'is-active sshd')
        if [ -f "$STUB_STATE/rollback_restart_succeeded" ]; then echo active; exit 0; fi
        echo inactive; exit 3 ;;
esac
exit 0
EOF
    have systemctl
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} "$SHELL_UNDER_TEST" "$_backup/rollback.sh" >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 0
    assert_order "sshd -t" "systemctl restart ssh"
    [ "$(grep -cx 'systemctl restart ssh' "$STUB_LOG")" = 2 ] || fail "rollback did not retry restart"
    assert_called "systemctl is-active ssh"
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_file "$_backup/done"
}

t_ssh_confirmation_survives_interruption_between_stop_and_disable() {
    admin_exists
    : >"$STATE/interrupt_disable"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    [ "$RC" -ne 0 ] || fail "the installer was not interrupted"
    _plan="$R/var/lib/swellwright-ssh-rollback"
    assert_line "$_plan/claim" "keep"
    assert_order "sync -f $_plan" "systemctl stop sw-ssh-rollback.timer"
    assert_order "systemctl stop sw-ssh-rollback.timer" "systemctl disable sw-ssh-rollback.timer"
    assert_file "$_plan/rollback.sh"
    : >"$STUB_LOG"
    env -i PATH="$SUT_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} "$SHELL_UNDER_TEST" "$_plan/rollback.sh" >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 0
    assert_line "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf" "PermitRootLogin no"
    assert_not_called_like '^systemctl restart ssh'
    assert_no_file "$R/etc/systemd/system/sw-ssh-rollback.timer"
    assert_no_file "$_plan"
}

t_ssh_recovers_an_unarmed_snapshot_but_preserves_an_incomplete_rollback() {
    admin_exists
    _plan="$R/var/lib/swellwright-ssh-rollback"
    mkdir -p "$_plan"
    printf 'incomplete staging only\n' >"$_plan/rollback.sh"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 0
    assert_no_file "$_plan"

    mkdir -p "$_plan"
    echo rollback >"$_plan/claim"
    printf 'backup to preserve\n' >"$_plan/rollback.sh"
    : >"$STUB_LOG"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "needs recovery from the console"
    assert_line "$_plan/rollback.sh" "backup to preserve"
    assert_not_called "systemctl enable --now sw-ssh-rollback.timer"
}

# The timer fires while the step waits for confirmation: its rollback claims the change first,
# puts the old configuration back, and the step reports that instead of keeping the change; the saved files are not removed
# under the running rollback.
t_ssh_rollback_that_already_ran_is_reported() {
    admin_exists
    : >"$STATE/fire_on_unlock"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    rolled_back
    assert_out "The automatic rollback plan is gone"
    assert_not_out "the change is kept"
    assert_contains "$R/var/log/swellwright-node-installer.log" "Automatic SSH rollback: cleanup complete"
    [ "$(grep -c '^systemctl restart ssh$' "$STUB_LOG")" = 2 ] || fail "the rollback must restart sshd with the old configuration"
}

# When the step itself undoes the change (sshd -t refused it), the timer is stopped only after the rollback completed; the
# timer's script, if it fires then, finds the rollback done and does nothing.
t_ssh_rollback_now_stops_the_timer_after_the_rollback() {
    admin_exists
    : >"$STATE/fire_on_stop"
    : >"$STATE/sshd_reject_candidate"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    rolled_back
    assert_out "sshd -t: configuration error, the change was reverted"
    [ "$(grep -c '^systemctl restart ssh' "$STUB_LOG")" = 0 ] || fail "sshd was restarted although nothing was restarted with the new files"
}

t_ssh_refuses_without_an_automatic_rollback() {
    admin_exists
    remove_cmd systemctl
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "systemctl is missing"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_not_called_like '^sshd -t'
    : >"$STUB_LOG"
    have systemctl
    echo sw-ssh-rollback.timer >>"$STATE/active_units"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "rollback of an earlier run is still pending"
    assert_not_called "systemctl enable --now sw-ssh-rollback.timer"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
}

t_ssh_interactive_change_is_undone_without_a_confirmed_login() {
    admin_exists
    printf '\n\n\n\ny\nn\n' >"$T/in"
    run_inst ssh SSH_PHASE=root NEW_USER=admin NEW_USER_PUBKEY="$KEY1" SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    rolled_back
    assert_contains "$T/tty" "Did the fresh login as admin work and sudo id -u print 0?"
    assert_out "Not confirmed: the old SSH configuration is back"
    # The lock of the SSH change is released before the question, so the timer's rollback is not held up by an unanswered
    # prompt (or by another run of the installer, which holds only its own lock).
    assert_order_like '^systemctl restart ssh$' '^flock -u 8$'
    assert_called "flock -n 8"
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
    : >"$STATE/sshd_reject_candidate"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    rolled_back
    assert_out "sshd -t: configuration error, the change was reverted"
    assert_not_called_like '^systemctl (restart|reload)'
}

t_ssh_password_login_closes_only_with_a_key() {
    admin_exists
    run_ssh_confirmed root SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=yes NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 0
    assert_contains "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf" "PasswordAuthentication no"
    assert_contains "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf" "KbdInteractiveAuthentication no"
    assert_order "sshd -t" "systemctl restart ssh"
    # The administrator has no key: refused, nothing written.
    : >"$R/home/admin/.ssh/authorized_keys"
    rm -f "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
    run_inst ssh SSH_PHASE=root SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=yes NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "Refusing to close password login"
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
}

t_ssh_removes_the_keys_only_file_when_sshd_refuses_it() {
    admin_exists
    : >"$STATE/sshd_reject_candidate"
    run_ssh_confirmed root SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=yes NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    rolled_back
    assert_out "the change was reverted"
}

t_ssh_all_phases_in_order() {
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    run_ssh_confirmed all NEW_USER=admin NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD='correct horse battery staple'
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
    # Enter accepts the defaults: root login closed, password login left open (the named administrator and key are offered
    # as defaults, then the login in a second window is confirmed).
    printf '\n\n\n\ny\ny\n' >"$T/in"
    run_inst ssh SSH_PHASE=root NEW_USER=admin NEW_USER_PUBKEY="$KEY1" SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    assert_rc 0
    assert_out "the change is kept"
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
    printf 'not the current config\n' >"$R/etc/nginx/conf.d/default.conf.bak.29990101000000"
    fail_on "nginx -t"
    run_inst rename NODE_DOMAIN=node2.example.com
    assert_rc 1
    assert_out "The rename configuration was not applied"
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
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10 PANEL_ALLOW_IP=192.0.2.20
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
    assert_out "port 62050: only 192.0.2.20 get through, everything else is dropped"
    assert_out "404 (the default site)"
    _log="$R/var/log/swellwright-node-installer.log"
    assert_contains "$_log" "CHECK ok | Node API port: DOCKER-USER rules | port 62050: only 192.0.2.20 get through, everything else is dropped"
    assert_contains "$_log" "CHECK ok | SNI_VERIFICATION | true"
}

t_verify_fills_saved_panel_addresses_and_distinguishes_unknown_addresses() {
    healthy_state
    rm -f "$R/etc/sw-node-api-allow.conf"
    printf "NODE_PORT='62050'\n" >"$R/etc/swellwright-node-installer.conf"
    in_inst 'apply_defaults; step_verify'
    assert_out "PANEL_ALLOW_IP is not known"
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK warn | Node API port: DOCKER-USER rules"
    printf "PANEL_ALLOW_IP='192.0.2.20'\n" >"$R/etc/swellwright-node-installer.conf"
    in_inst 'apply_defaults; step_verify'
    assert_out "explicit panel rules found for port 62050"
}

t_verify_failures_give_exit_code_2() {
    healthy_state
    printf -- '-N DOCKER-USER\n-A DOCKER-USER -j RETURN\n' >"$STATE/iptables_rules"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 2
    assert_out "port 62050: open to everybody"
}

t_verify_rejects_acl_when_forward_bypasses_it() {
    healthy_state
    printf -- '-P FORWARD ACCEPT\n-A FORWARD -j ACCEPT\n-A FORWARD -j DOCKER-USER\n' >"$STATE/ipt.FORWARD"
    run_inst verify NODE_DOMAIN=node1.example.com PANEL_ALLOW_IP=192.0.2.20
    assert_rc 2
    assert_out "FORWARD does not begin with an unconditional jump to DOCKER-USER"
}

t_verify_does_not_accept_an_unrelated_ufw_rule() {
    healthy_state
    printf 'Status: active\n\nTo Action From\n22/tcp ALLOW IN 192.0.2.20 # node port 62050\n' >"$STATE/ufw_status"
    run_inst verify NODE_DOMAIN=node1.example.com PANEL_ALLOW_IP=192.0.2.20
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK warn | UFW | active, no matching panel TCP rule for port 62050"
}

t_verify_rejects_a_drop_limited_to_translated_port_or_connection_state() {
    legacy_acl
    for _match in '--dport 62050' '--ctstate NEW'; do
        printf -- '-N DOCKER-USER\n-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 62050 %s -j DROP\n' "$_match" >"$STATE/iptables_rules"
        in_inst 'api_acl_check 62050 "192.0.2.20"'
        assert_out "fail"
    done
}

# verify judges what the rules do with a connection to the port, not whether some rule mentions it (an interrupted change of an
# older installer could leave only the RETURN of the panel, which mentions the port and drops nothing).
t_verify_api_port_rules_are_judged_by_what_they_do() {
    _p='-p tcp -m conntrack --ctorigdstport 62050 --ctdir ORIGINAL'
    _docker='-A DOCKER-USER -j RETURN'
    # acl_case EXPECTED "PANEL" RULES... : DOCKER-USER is "-N DOCKER-USER" and the rules; the check must begin with EXPECTED.
    acl_case() {
        _want=$1; _panel=$2; shift 2
        { echo "-N DOCKER-USER"; for _r in "$@"; do echo "$_r"; done; } >"$STATE/iptables_rules"
        in_inst "api_acl_check 62050 '$_panel'"
        case $(cat "$T/out") in "$_want"*) ;; *) fail "expected '$_want' for: $* -> $(cat "$T/out" "$T/err")" ;; esac
    }
    acl_case "fail open to everybody: let through by: $_docker" 192.0.2.20 "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "$_docker"
    acl_case "fail open to everybody: no rule of DOCKER-USER drops it" 192.0.2.20 "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN"
    acl_case "fail open to everybody: let through by: $_docker" 192.0.2.20 "$_docker" "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP"
    acl_case "fail open to everybody" 192.0.2.20 "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER -i eth1 $_p -j DROP" "$_docker"
    acl_case "fail open to everybody" 192.0.2.20 "-A DOCKER-USER $_p -j ACCEPT" "-A DOCKER-USER $_p -j DROP"
    acl_case "fail also open to 203.0.113.9" 192.0.2.20 "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER -s 203.0.113.9/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP" "$_docker"
    acl_case "fail also open to 10.0.0.0/8" 192.0.2.20 "-A DOCKER-USER -s 10.0.0.0/8 -j ACCEPT" "-A DOCKER-USER $_p -j DROP"
    acl_case "ok only 192.0.2.20 get through" 192.0.2.20 "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP" "$_docker"
    # Rules for another original port, replies and a log rule change nothing.
    acl_case "ok only 192.0.2.20 get through" 192.0.2.20 "-A DOCKER-USER -m conntrack --ctdir REPLY -j RETURN" "-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 8080 -j ACCEPT" "-A DOCKER-USER -j LOG" "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP" "$_docker"
    acl_case "warn only 192.0.2.20 get through, everything else is dropped; nothing lets 198.51.100.7 through" "192.0.2.20 198.51.100.7" "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP" "$_docker"
    # A negated condition is not read as "does not match": these rules may accept the connection.
    acl_case "fail open to everybody" 192.0.2.20 "-A DOCKER-USER ! -p udp -j ACCEPT" "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP"
    acl_case "fail open to everybody" 192.0.2.20 "-A DOCKER-USER -p tcp -m conntrack ! --ctorigdstport 1 -j ACCEPT" "-A DOCKER-USER $_p -j DROP"
    acl_case "fail open to everybody" 192.0.2.20 "-A DOCKER-USER -m conntrack ! --ctstate NEW -j ACCEPT" "-A DOCKER-USER $_p -j DROP"
    # A comment is not parsed (quotes and escapes could hide conditions): an ACCEPT with one is not certified.
    acl_case "fail open to everybody" 192.0.2.20 '-A DOCKER-USER -m comment --comment "allow \" -p udp" -j ACCEPT' "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP"
    # The DNAT state matches a new connection to a published port as well.
    acl_case "fail open to everybody" 192.0.2.20 "-A DOCKER-USER -m conntrack --ctstate DNAT -j ACCEPT" "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP"
    # A goto returns past the rules after it, and a target the check does not know may end the chain: neither is certified.
    printf -- '-N BYPASS\n-A BYPASS -j RETURN\n' >"$STATE/ipt.BYPASS"
    acl_case "fail open to everybody: a goto (-g) is not followed" 192.0.2.20 "-A DOCKER-USER -g BYPASS" "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP"
    acl_case "fail open to everybody: a rule with a target this check does not read" 192.0.2.20 "-A DOCKER-USER $_p -j DNAT --to-destination 192.0.2.99" "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j DROP"
    # A jump to another chain: its DROP for everybody counts; a RETURN there for some sources goes back to DOCKER-USER, which
    # this check does not follow, so it does not certify (a refusal, never a false ok).
    printf -- '-N SW-ACL\n-A SW-ACL -j DROP\n' >"$STATE/ipt.SW-ACL"
    acl_case "ok only 192.0.2.20 get through" 192.0.2.20 "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j SW-ACL" "$_docker"
    printf -- '-N SW-ACL\n-A SW-ACL -s 203.0.113.9/32 -j RETURN\n-A SW-ACL -j DROP\n' >"$STATE/ipt.SW-ACL"
    acl_case "fail open to everybody: a rule sends some sources back" 192.0.2.20 "-A DOCKER-USER -s 192.0.2.20/32 $_p -j RETURN" "-A DOCKER-USER $_p -j SW-ACL" "$_docker"
    printf -- '-N SW-ACL\n-A SW-ACL -s 192.0.2.20/32 -j RETURN\n' >"$STATE/ipt.SW-ACL"
    acl_case "fail open to everybody" 192.0.2.20 "-A DOCKER-USER $_p -j SW-ACL" "$_docker"
    rm -f "$STATE/iptables_rules"
    in_inst "api_acl_check 62050 192.0.2.20"
    assert_out "fail there is no DOCKER-USER chain"
}

t_verify_reports_a_missing_container() {
    healthy_state
    rm -f "$STATE/container"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 2
    assert_out "no container"
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK fail | Container remnanode"
}

t_verify_rejects_disabled_guard_and_autonomous_docker_restart() {
    healthy_state
    rm -f "$STATE/node_enabled"
    printf 'always\n' >"$STATE/restart_policy"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_rc 2
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK fail | Guarded node startup | active (disabled)"
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK fail | Guarded node lifecycle | Node startup: Docker autonomous restart is enabled"
    assert_not_called_like '^docker .* (update|stop|create|up|start) '
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
    assert_order "systemctl enable --now docker" "systemctl start sw-node-api-acl.service"
    assert_order "systemctl start sw-node-api-acl.service" "useradd -r -m -s /bin/bash certsync"
    assert_order "useradd -r -m -s /bin/bash certsync" "systemctl restart nginx"
    assert_order "systemctl restart nginx" "systemctl restart haproxy"
    assert_order "systemctl restart haproxy" "systemctl restart sw-node.service"
    assert_order_like '^systemctl restart sw-node\.service$' '^docker .* container start '
    assert_order_like '^docker .* container start ' '^docker .* inspect -f \{\{\.State.Status\}\} remnanode$'
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

t_full_disarms_the_old_node_before_package_upgrades() {
    node_acl_ready
    printf 'remnawave/node:3.4.6\n' >"$STATE/container"
    printf 'NODE_PORT=62050\n' >"$STATE/container_env"
    printf 'always\n' >"$STATE/restart_policy"
    fail_on 'apt-get -o DPkg::Lock::Timeout=600 update'
    : >"$STUB_LOG"
    run_inst full $NODE_ARGS PANEL_ALLOW_IP=192.0.2.21
    assert_rc 1
    assert_order_like '^docker .* update --restart=no ' '^docker .* container stop '
    assert_order_like '^docker .* container stop ' '^apt-get .*update'
    assert_line "$STATE/restart_policy" no
    assert_line "$STATE/node_state" exited
    assert_not_called_like '^docker .* (up|start) '
    assert_not_called_like '^systemctl (restart|stop) (docker|ssh)'
    assert_line "$R/etc/swellwright-node-installer.conf" "PANEL_ALLOW_IP='192.0.2.20'"
    assert_not_called_like '^ufw (allow|delete)'
}

t_full_preserves_panel_ufw_rules_before_reaching_apiacl() {
    node_acl_ready
    fail_on 'systemctl restart fail2ban'
    : >"$STUB_LOG"
    run_inst full $NODE_ARGS PANEL_ALLOW_IP=192.0.2.21
    assert_rc 1
    assert_called 'ufw --force enable'
    assert_not_called_like '^ufw (allow from |delete )'
    assert_not_called_like '^iptables-restore '
    assert_line "$R/etc/swellwright-node-installer.conf" "PANEL_ALLOW_IP='192.0.2.20'"
    assert_line "$R/etc/sw-node-api-allow.conf" 'ALLOW_SRC="192.0.2.20"'
}

t_ssh_preserves_unverified_pre_upgrade_completion() {
    admin_exists
    _plan="$R/var/lib/swellwright-ssh-rollback"
    mkdir -p "$_plan"
    printf 'original configuration\n' >"$_plan/1"
    : >"$_plan/done"
    cat >"$_plan/rollback.sh" <<'EOF'
#!/bin/sh
[ ! -f "$(dirname "$0")/done" ] || exit 0
exit 1
EOF
    for _claim in absent pending unexpected rollback; do
        if [ "$_claim" = absent ]; then rm -f "$_plan/claim"
        else printf '%s\n' "$_claim" >"$_plan/claim"; fi
        : >"$STATE/ssh_down"
        : >"$STUB_LOG"
        run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
        assert_rc 1
        assert_line "$_plan/1" "original configuration"
        assert_file "$_plan/done"
        assert_not_called_like '^systemctl (restart|stop|disable)'
    done
    rm -f "$STATE/ssh_down"
    : >"$STATE/fail"
    fail_on 'sshd -t'
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_file "$_plan/1"
    : >"$STATE/fail"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 0
    assert_no_file "$_plan"
}

t_ssh_automatic_rollback_preserves_a_done_snapshot_without_rollback_claim() {
    admin_exists
    : >"$STATE/interrupt_before_confirmation"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    [ "$RC" -ne 0 ] || fail "expected the initial SSH change to be interrupted"
    _plan="$R/var/lib/swellwright-ssh-rollback"
    : >"$_plan/done"
    for _claim in pending keep absent; do
        if [ "$_claim" = absent ]; then rm -f "$_plan/claim"
        else printf '%s\n' "$_claim" >"$_plan/claim"; fi
        : >"$STUB_LOG"
        run_automatic_ssh_rollback
        assert_rc 1
        assert_file "$_plan/1"
        assert_file "$_plan/done"
        assert_not_called_like '^systemctl (stop|disable|restart)'
    done
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
    fail_on "docker --host unix:///var/run/docker.sock compose -f"
    run_inst full $NODE_ARGS
    assert_rc 1
    assert_out "The installation stopped at an error"
    assert_called_like '^systemctl restart haproxy$'
    # verify is the last step and was never reached.
    assert_not_called_like '^docker .* inspect -f \{\{\.State.Status\}\} remnanode$'
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
    : >"$STUB_LOG"
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
    assert_not_called_like '^docker (--host [^ ]+ )?(compose|update|container (start|stop))'
    assert_not_called_like '^iptables (-w [0-9]+ )?-[NIDAFPX]|^iptables-restore '
    assert_not_called_like '^sysctl -q'
    assert_not_called_like '^sshd -t'
}
