# Tests of who counts as an administrator (the ssh step must close root login and password login only when somebody can really
# log in, ADR 0036 and 0040), the verify check that shows it, and of secrets given as files (NAME_FILE).

# ---------------------------------------------------------------- helpers

# sshd_conf [KEY VALUE]...: what `sshd -T` says for every account: a stock configuration with these directives changed or added.
sshd_conf() {
    printf 'port 22\npermitrootlogin yes\npasswordauthentication yes\npubkeyauthentication yes\nusepam yes\nstrictmodes yes\nauthorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2\nauthenticationmethods any\n' >"$STATE/sshd_T"
    while [ $# -ge 2 ]; do
        grep -v "^$1 " "$STATE/sshd_T" >"$STATE/sshd_T.new"
        printf '%s %s\n' "$1" "$2" >>"$STATE/sshd_T.new"
        mv "$STATE/sshd_T.new" "$STATE/sshd_T"
        shift 2
    done
}

# bare_member NAME: a member of the sudo group that exists and has a password, and nothing else: no key, no ~/.ssh.
bare_member() {
    echo "$1" >>"$STATE/users"; echo "$1" >>"$STATE/sudo_members"; echo "$1" >>"$STATE/haspw"
    mkdir -p "$R/home/$1"
    chmod 755 "$R/home/$1"
    have sudo ssh-keygen
}

# root_phase [NAME=value ...]: the ssh step, root phase, on a stock sshd_config; the operator names the administrator admin and
# the key KEY1 (a later NAME=value wins).
root_phase() {
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1" "$@"
}

# refused_root REASON: the step stopped before it changed anything, and said why.
refused_root() {
    assert_rc 1
    assert_out "Refusing to close root login"
    assert_out "$1"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_not_called_like '^sshd -t'
    assert_not_called_like '^systemctl (restart|reload)'
}

closed_root() {
    assert_rc 0
    assert_line "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf" "PermitRootLogin no"
    assert_called_like '^systemctl restart ssh'
}

# ---------------------------------------------------------------- an administrator that counts

t_admin_with_a_valid_key_counts() {
    add_admin admin
    root_phase
    closed_root
    assert_out "Administrators who can log in with a key: admin"
}

t_admin_counts_a_key_with_options_that_leave_a_shell() {
    add_admin admin 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding '"$KEY1"
    root_phase
    closed_root
    # from= still counts the account (the list), but the named key on such a line is not proof of a way in: the installer
    # does not evaluate from= or expiry-time=.
    printf 'from="192.0.2.0/24,198.51.100.7",no-agent-forwarding %s\n' "$KEY1" >"$R/home/admin/.ssh/authorized_keys"
    rm -f "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"; : >"$STUB_LOG"
    root_phase
    assert_out "Administrators who can log in with a key: admin"
    refused_named "from= and expiry-time= are not read"
    printf 'expiry-time="20200101" %s\n' "$KEY1" >"$R/home/admin/.ssh/authorized_keys"
    root_phase
    refused_named "from= and expiry-time= are not read"
}

t_admin_counts_restrict_when_pty_gives_the_terminal_back() {
    add_admin admin "restrict,pty $KEY1"
    root_phase
    closed_root
}

t_admin_counts_when_one_line_of_several_is_good() {
    add_admin admin
    {
        printf 'ssh-ed25519 AAAAnotakey broken\n'
        printf '# a comment\n\n'
        printf 'command="/usr/local/bin/backup" %s\n' "$KEY2"
        printf '%s\n' "$KEY1"
    } >"$R/home/admin/.ssh/authorized_keys"
    root_phase
    closed_root
}

t_admin_second_candidate_counts_when_the_first_fails() {
    bare_member provider
    add_admin admin
    root_phase
    closed_root
    assert_out "Administrators who can log in with a key: admin"
    assert_out "not counted: provider: "
}

t_admin_counts_a_root_owned_key_file_the_account_can_read() {
    add_admin admin
    echo 0 >"$R/home/admin/.ssh/authorized_keys.owner"
    echo 644 >"$R/home/admin/.ssh/authorized_keys.mode"
    root_phase
    closed_root
}

t_admin_counts_a_member_through_its_primary_group() {
    add_admin admin
    : >"$STATE/sudo_members"
    echo 27 >"$STATE/gid_admin"
    root_phase
    closed_root
}

# The image of a cloud provider: the password is locked, sudo has a rule without a password, the key logs in through PAM.
t_admin_with_a_locked_password_counts_when_sudo_needs_none() {
    add_admin admin
    : >"$STATE/haspw"
    printf '!:20000:0:99999:7:::\n' >"$STATE/shadow_admin"
    printf 'User admin may run the following commands on node1:\n    (ALL : ALL) NOPASSWD: ALL\n' >"$STATE/sudo_l_admin"
    root_phase
    closed_root
}

t_admin_counts_a_key_file_outside_the_home_when_sshd_reads_it() {
    add_admin admin
    rm -f "$R/home/admin/.ssh/authorized_keys"
    mkdir -p "$R/etc/ssh/authorized_keys"
    printf '%s\n' "$KEY1" >"$R/etc/ssh/authorized_keys/admin"
    echo 0 >"$R/etc/ssh/authorized_keys/admin.owner"; echo 644 >"$R/etc/ssh/authorized_keys/admin.mode"
    sshd_conf authorizedkeysfile "$R/etc/ssh/authorized_keys/%u"
    root_phase
    closed_root
}

t_admin_ordinary_uid_range_follows_login_defs() {
    add_admin admin
    echo 500 >"$STATE/uid_admin"
    printf 'UID_MIN\t\t\t  100\nUID_MAX\t\t\t60000\n' >"$R/etc/login.defs"
    root_phase
    closed_root
}

# ---------------------------------------------------------------- an account that is in the group and does not count

t_admin_empty_group_is_refused() {
    root_phase
    refused_root "The sudo group has no members"
}

t_admin_member_without_authorized_keys_is_refused() {
    bare_member provider
    root_phase
    refused_root "provider: /home/provider/.ssh/authorized_keys does not exist"
}

t_admin_empty_authorized_keys_is_refused() {
    add_admin admin
    : >"$R/home/admin/.ssh/authorized_keys"
    root_phase
    refused_root "holds no key"
}

t_admin_garbage_key_line_is_refused() {
    add_admin admin 'ssh-ed25519 AAAAnotakey broken'
    root_phase
    refused_root "1 that are not a valid key"
}

t_admin_forced_command_key_is_refused() {
    add_admin admin 'command="/usr/local/bin/backup",from="192.0.2.1" '"$KEY1"
    root_phase
    refused_root "1 with a forced command"
}

t_admin_forced_command_with_commas_and_spaces_in_its_quotes_is_refused() {
    add_admin admin 'command="echo a, b c",no-agent-forwarding '"$KEY1"
    root_phase
    refused_root "1 with a forced command"
}

t_admin_key_without_a_terminal_is_refused() {
    add_admin admin
    for _opt in restrict no-pty 'pty,restrict' 'restrict,from="192.0.2.1"'; do
        printf '%s %s\n' "$_opt" "$KEY1" >"$R/home/admin/.ssh/authorized_keys"
        root_phase
        refused_root "without a terminal (restrict or no-pty)"
    done
}

t_admin_group_writable_authorized_keys_is_refused() {
    add_admin admin
    echo 664 >"$R/home/admin/.ssh/authorized_keys.mode"
    root_phase
    refused_root "can be written by group or others, mode 664 (StrictModes)"
}

t_admin_world_writable_ssh_directory_is_refused() {
    add_admin admin
    echo 777 >"$R/home/admin/.ssh.mode"
    root_phase
    refused_root "/home/admin/.ssh can be written by group or others, mode 777"
}

t_admin_group_writable_home_is_refused() {
    add_admin admin
    echo 775 >"$R/home/admin.mode"
    root_phase
    refused_root "/home/admin can be written by group or others, mode 775"
}

t_admin_authorized_keys_of_somebody_else_is_refused() {
    add_admin admin
    echo 4242 >"$R/home/admin/.ssh/authorized_keys.owner"
    root_phase
    refused_root "is owned by user id 4242, not by the account or root"
}

t_admin_unreadable_authorized_keys_is_refused() {
    add_admin admin
    echo 000 >"$R/home/admin/.ssh/authorized_keys.mode"
    root_phase
    refused_root "cannot be read by the account (mode 000)"
    # Owned by root with mode 600: root can read it, the account cannot.
    echo 0 >"$R/home/admin/.ssh/authorized_keys.owner"; echo 600 >"$R/home/admin/.ssh/authorized_keys.mode"
    root_phase
    refused_root "cannot be read by the account (mode 600)"
}

t_admin_modes_do_not_matter_when_sshd_runs_without_strict_modes() {
    add_admin admin
    echo 664 >"$R/home/admin/.ssh/authorized_keys.mode"
    sshd_conf strictmodes no
    root_phase
    closed_root
}

t_admin_locked_and_expired_account_is_refused() {
    add_admin admin
    : >"$STATE/haspw"
    printf '!:20000:0:99999:7::1:\n' >"$STATE/shadow_admin"
    printf 'User admin may run the following commands on node1:\n    (ALL : ALL) NOPASSWD: ALL\n' >"$STATE/sudo_l_admin"
    root_phase
    refused_root "the account has expired"
}

t_admin_account_past_its_inactivity_period_is_refused() {
    add_admin admin
    printf 'x:19000:0:90:7:30:\n' >"$STATE/shadow_admin"
    root_phase
    refused_root "the inactivity period has passed"
}

t_admin_locked_password_without_pam_is_refused() {
    add_admin admin
    : >"$STATE/haspw"
    printf 'User admin may run the following commands on node1:\n    (ALL : ALL) NOPASSWD: ALL\n' >"$STATE/sudo_l_admin"
    sshd_conf usepam no
    root_phase
    refused_root "locked and sshd runs without PAM"
}

t_admin_with_a_nologin_shell_is_refused() {
    add_admin admin
    echo /usr/sbin/nologin >"$STATE/shell_admin"
    root_phase
    refused_root "its login shell is /usr/sbin/nologin"
    echo /bin/false >"$STATE/shell_admin"
    root_phase
    refused_root "its login shell is /bin/false"
}

t_admin_with_a_missing_shell_is_refused() {
    add_admin admin
    echo "$R/bin/no-such-shell" >"$STATE/shell_admin"
    root_phase
    refused_root "is missing or not executable"
}

t_admin_kept_out_by_allowusers_is_refused() {
    add_admin admin
    sshd_conf allowusers "ops deploy"
    root_phase
    refused_root "AllowUsers does not list it"
}

t_admin_allowusers_entry_with_a_host_is_taken_by_its_user_part() {
    add_admin admin
    sshd_conf allowusers "admin@192.0.2.9"
    root_phase
    closed_root
}

t_admin_kept_out_by_denyusers_is_refused() {
    add_admin admin
    sshd_conf denyusers "adm*"
    root_phase
    refused_root "DenyUsers keeps it out"
}

t_admin_denyusers_entry_limited_to_a_host_does_not_keep_it_out() {
    add_admin admin
    sshd_conf denyusers "admin@192.0.2.9"
    root_phase
    closed_root
}

t_admin_kept_out_by_allowgroups_is_refused() {
    add_admin admin
    sshd_conf allowgroups "wheel ssh-users"
    root_phase
    refused_root "AllowGroups does not list any of its groups"
}

t_admin_allowgroups_with_one_of_its_groups_counts() {
    add_admin admin
    echo ssh-users >"$STATE/groups_admin"
    sshd_conf allowgroups "wheel ssh-users"
    root_phase
    closed_root
}

t_admin_kept_out_by_denygroups_is_refused() {
    add_admin admin
    sshd_conf denygroups "su?o"
    root_phase
    refused_root "DenyGroups keeps it out (group sudo)"
}

# sshd -T -C user=NAME applies the Match blocks: one account may be kept out while another is not.
t_admin_is_asked_of_sshd_account_by_account() {
    add_admin admin
    add_admin ops
    sshd_conf
    printf 'port 22\npermitrootlogin yes\npasswordauthentication yes\npubkeyauthentication yes\nusepam yes\nstrictmodes yes\nauthorizedkeysfile .ssh/authorized_keys\nauthenticationmethods any\ndenyusers admin\n' >"$STATE/sshd_T.admin"
    root_phase NEW_USER=ops
    closed_root
    assert_out "Administrators who can log in with a key: ops"
    assert_out "not counted: admin: DenyUsers keeps it out"
    assert_called_like '^sshd -T -C user=admin,host=localhost,addr=127.0.0.1$'
    assert_called_like '^sshd -T -C user=ops,host=localhost,addr=127.0.0.1$'
}

t_admin_with_public_key_login_off_is_refused() {
    add_admin admin
    sshd_conf pubkeyauthentication no
    root_phase
    refused_root "PubkeyAuthentication off"
}

t_admin_needing_more_than_a_key_is_refused() {
    add_admin admin
    sshd_conf authenticationmethods "publickey,password password"
    root_phase
    refused_root "AuthenticationMethods asks for more than a key"
    sshd_conf authenticationmethods "password publickey"
    root_phase
    closed_root
}

t_admin_only_the_certificate_receiver_is_refused() {
    bare_member certsync
    root_phase
    refused_root "certsync only receives certificates"
}

t_admin_root_is_never_counted() {
    echo root >>"$STATE/users"; echo root >>"$STATE/sudo_members"
    root_phase
    refused_root "root is not counted"
}

t_admin_group_that_lists_a_missing_account_is_refused() {
    echo adminvps >>"$STATE/sudo_members"
    root_phase
    refused_root "adminvps: the account does not exist"
}

t_admin_system_account_is_refused() {
    add_admin admin
    echo 500 >"$STATE/uid_admin"
    root_phase
    refused_root "user id 500 is not an ordinary account (1000 to 60000)"
    echo 0 >"$STATE/uid_admin"
    root_phase
    refused_root "user id 0 is not an ordinary account"
}

# What happened on a real server: an account of the hosting provider (no key) was in the group, the real administrator was not.
t_admin_provider_account_without_a_key_beside_a_good_account_outside_the_group_is_refused() {
    bare_member provider
    add_admin admin
    echo provider >"$STATE/sudo_members"
    root_phase
    refused_root "provider: /home/provider/.ssh/authorized_keys does not exist"
}

t_admin_without_sudo_installed_is_refused() {
    add_admin admin
    remove_cmd sudo
    root_phase
    refused_root "sudo is not installed"
}

t_admin_refused_by_sudoers_is_refused() {
    add_admin admin
    printf 'User admin is not allowed to run sudo on node1.\n' >"$STATE/sudo_l_admin"
    root_phase
    refused_root "sudoers does not let it run sudo"
}

t_admin_without_a_password_and_without_a_nopasswd_rule_is_refused() {
    add_admin admin
    : >"$STATE/haspw"
    root_phase
    refused_root "sudo would ask for a password and the account has none"
}

t_admin_key_file_that_sshd_does_not_read_is_refused() {
    add_admin admin
    sshd_conf authorizedkeysfile none
    root_phase
    refused_root "sshd reads no key file (AuthorizedKeysFile none)"
    sshd_conf authorizedkeysfile "$R/etc/ssh/authorized_keys/%u"
    root_phase
    refused_root "/etc/ssh/authorized_keys/admin does not exist"
}

# ---------------------------------------------------------------- password login and the questions

t_admin_password_login_is_closed_only_for_an_account_that_counts() {
    add_admin admin 'command="/usr/local/bin/backup" '"$KEY1"
    root_phase SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=yes
    assert_rc 1
    assert_out "Refusing to close password login"
    assert_out "1 with a forced command"
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
    assert_not_called_like '^systemctl (restart|reload)'
    printf '%s\n' "$KEY1" >"$R/home/admin/.ssh/authorized_keys"
    root_phase SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=yes
    assert_rc 0
    assert_contains "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf" "PasswordAuthentication no"
}

t_admin_both_closings_are_refused_before_anything_is_written() {
    bare_member provider
    root_phase SSH_DISABLE_PASSWORD=yes
    refused_root "provider: "
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
}

t_admin_no_question_is_asked_when_the_answer_cannot_be_yes() {
    bare_member provider
    printf 'y\ny\n' >"$T/in"
    root_phase SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty"
    refused_root "provider: "
    ! grep -q "Close root login" "$T/tty" 2>/dev/null || fail "the question was asked although the step would refuse"
    # A question the parameters answered "no" may still be answered yes: the refusal comes then.
    printf 'y\nn\n' >"$T/in"
    root_phase SW_NONINTERACTIVE=0 SW_TTY_IN="$T/in" SW_TTY_OUT="$T/tty" SSH_DISABLE_ROOT=no
    refused_root "provider: "
}

t_admin_nothing_to_close_is_not_an_error() {
    bare_member provider
    root_phase SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=no
    assert_rc 0
    assert_out "No administrator can log in with a key: root login and password login will not be closed"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
}

t_admin_the_user_phase_says_whether_the_new_account_counts() {
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    run_inst ssh SSH_PHASE=user NEW_USER=admin NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD='correct horse battery staple'
    assert_rc 0
    assert_out "Administrators who can log in with a key: admin"
    assert_not_called_like '^sshd -t'
    # The same with a home directory the group can write: the key is written, sshd would not read it, and the step says so.
    echo 775 >"$R/home/admin.mode"
    run_inst ssh SSH_PHASE=user NEW_USER=admin NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD='correct horse battery staple'
    assert_rc 0
    assert_out "not counted: admin: /home/admin can be written by group or others"
    assert_out "No administrator can log in with a key"
}

# ---------------------------------------------------------------- the administrator and the key the operator names

# refused_named REASON: another account may count, but the named administrator and key are not shown to work: nothing is
# written and no rollback is armed.
refused_named() {
    assert_rc 1
    assert_out "Refusing to close root login"
    assert_out "$1"
    assert_out "Nothing was changed"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_contains "$R/etc/ssh/sshd_config" "#PermitRootLogin prohibit-password"
    assert_not_called "systemctl enable --now sw-ssh-rollback.timer"
    assert_not_called_like '^sshd -t'
    assert_not_called_like '^systemctl (restart|reload)'
}

t_named_admin_that_is_missing_is_refused() {
    add_admin admin
    root_phase NEW_USER=backup
    refused_named "backup is not an administrator: it is not in the sudo group"
}

t_named_admin_without_the_named_key_is_refused() {
    add_admin admin "$KEY2"
    root_phase
    refused_named "the key given as NEW_USER_PUBKEY is not in a key file of admin"
}

t_named_admin_whose_named_key_gives_no_shell_is_refused() {
    add_admin admin
    printf '%s\nrestrict %s\n' "$KEY2" "$KEY1" >"$R/home/admin/.ssh/authorized_keys"
    root_phase
    refused_named "is not in a key file of admin that sshd reads, as a line that gives a shell"
}

t_named_admin_with_an_empty_key_file_is_refused_beside_one_that_counts() {
    add_admin admin
    add_admin ops
    : >"$R/home/admin/.ssh/authorized_keys"
    root_phase
    refused_named "admin cannot be shown to log in: /home/admin/.ssh/authorized_keys holds no key"
}

# sshd is asked for a login from where the open SSH sessions come from (read from ss, not from the environment): an
# administrator that AllowUsers lets in only from elsewhere cannot be the way back in.
t_named_admin_unreachable_from_the_address_of_the_session_is_refused() {
    add_admin admin
    printf 'ESTAB 0 0 192.0.2.10:22 198.51.100.5:50000 users:(("sshd",pid=10,fd=4))\n' >"$STATE/ss_est"
    sshd_conf allowusers "admin@203.0.113.9"
    root_phase
    refused_named "AllowUsers does not let it in from 198.51.100.5"
    assert_called "sshd -T -C user=admin,host=198.51.100.5,addr=198.51.100.5"
    sshd_conf denyusers "admin@198.51.100.*"
    root_phase
    refused_named "DenyUsers keeps it out from 198.51.100.5"
    sshd_conf allowusers "admin@198.51.100.*"
    root_phase
    closed_root
}

# Every address an SSH session comes from must work (the session of this run cannot be told from another one, say the
# certificate sender's): one that does not is a refusal.
t_named_admin_must_work_from_every_session_address() {
    add_admin admin
    printf 'ESTAB 0 0 192.0.2.10:22 198.51.100.5:50000 users:(("sshd",pid=10,fd=4))\nESTAB 0 0 192.0.2.10:22 203.0.113.9:50001 users:(("sshd",pid=11,fd=4))\n' >"$STATE/ss_est"
    sshd_conf allowusers "admin@203.0.113.9"
    root_phase
    refused_named "AllowUsers does not let it in from 198.51.100.5"
}

# The named key must itself be a key: a valid key beside a broken copy of it in the file proves nothing.
t_named_admin_with_a_named_key_that_is_not_a_key_is_refused() {
    add_admin admin
    printf '%s\nssh-ed25519 AAAAAAAAAAAAAAAA\n' "$KEY2" >"$R/home/admin/.ssh/authorized_keys"
    root_phase NEW_USER_PUBKEY='ssh-ed25519 AAAAAAAAAAAAAAAA'
    refused_named "NEW_USER_PUBKEY is not a valid public key"
}

# A CIDR host part of DenyUsers cannot be read by a pattern of the shell: it is taken as keeping the account out.
t_named_admin_with_a_cidr_denyusers_entry_is_refused() {
    add_admin admin
    printf 'ESTAB 0 0 192.0.2.10:22 192.0.2.5:50000 users:(("sshd",pid=10,fd=4))\n' >"$STATE/ss_est"
    sshd_conf denyusers "admin@192.0.2.0/24"
    root_phase
    refused_named "DenyUsers has an entry admin@192.0.2.0/24 that this check cannot read (CIDR)"
}

# A Match block that sets PermitRootLogin or password login again would override the drop-ins for some connections: the
# change is undone and the operator is told to resolve it by hand.
t_ssh_refuses_when_a_match_block_sets_the_login_methods() {
    add_admin admin
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    printf 'Match User root\n    PermitRootLogin yes\n' >>"$R/etc/ssh/sshd_config"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "could set the login methods again (/etc/ssh/sshd_config: PermitRootLogin yes)"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_not_called_like '^systemctl restart ssh'
    assert_called "systemctl stop sw-ssh-rollback.timer"
    # An Include of another file (or any Include inside a Match block) is not read by the check: refused as well. The stock
    # Include of sshd_config.d is fine.
    printf '%sInclude /etc/ssh/sshd_config.d/*.conf\nInclude /etc/ssh/legacy.conf\n' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "Include /etc/ssh/legacy.conf (an Include this check does not read)"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    printf '%sInclude /etc/ssh/sshd_config.d/*.conf\n' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    run_ssh_confirmed root NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 0
}

# ChallengeResponseAuthentication, the old name of KbdInteractiveAuthentication, in a Match block keeps password login open
# through keyboard-interactive: closing password login is refused.
t_ssh_refuses_a_match_block_with_the_old_name_of_keyboard_interactive() {
    add_admin admin
    printf '%sMatch User admin\n    ChallengeResponseAuthentication yes\n' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    run_ssh_confirmed root SSH_DISABLE_ROOT=no SSH_DISABLE_PASSWORD=yes NEW_USER=admin NEW_USER_PUBKEY="$KEY1"
    assert_rc 1
    assert_out "could set the login methods again (/etc/ssh/sshd_config: ChallengeResponseAuthentication yes)"
    assert_no_file "$R/etc/ssh/sshd_config.d/01-sw-keys-only.conf"
}

# A cert-authority line trusts certificates signed by that key, not a login with the key itself: it is no proof.
t_named_admin_whose_named_key_is_only_a_certificate_authority_is_refused() {
    add_admin admin
    printf '%s\ncert-authority %s\n' "$KEY2" "$KEY1" >"$R/home/admin/.ssh/authorized_keys"
    root_phase
    refused_named "is not in a key file of admin that sshd reads, as a line that gives a shell"
}

# sshd -T for a root login from where the session comes from must say no as well (a Match on the address could say yes).
t_ssh_checks_root_login_for_the_address_of_the_session() {
    add_admin admin
    printf 'ESTAB 0 0 192.0.2.10:22 198.51.100.5:50000 users:(("sshd",pid=10,fd=4))\n' >"$STATE/ss_est"
    printf 'port 22\npermitrootlogin prohibit-password\npasswordauthentication yes\npubkeyauthentication yes\nusepam yes\nstrictmodes yes\nauthorizedkeysfile .ssh/authorized_keys\n' >"$STATE/sshd_T.root"
    : >"$STATE/sshd_ignores_dropins_for_root"
    root_phase
    assert_rc 1
    assert_out "PermitRootLogin is prohibit-password for root from 198.51.100.5"
    assert_no_file "$R/etc/ssh/sshd_config.d/00-sw-hardening.conf"
    assert_called "sshd -T -C user=root,host=198.51.100.5,addr=198.51.100.5"
}

# ---------------------------------------------------------------- verify shows it

t_verify_lists_the_administrators_that_count() {
    healthy_state
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK ok | SSH: administrators with key login | admin"
    bare_member provider
    printf 'admin\nprovider\n' >"$STATE/sudo_members"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK ok | SSH: administrators with key login | admin (not counted: provider: "
}

t_verify_warns_when_the_ssh_step_would_refuse() {
    healthy_state
    : >"$R/home/admin/.ssh/authorized_keys"
    printf 'port 22\npermitrootlogin yes\npasswordauthentication yes\n' >"$STATE/sshd_T"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK warn | SSH: administrators with key login | none, the ssh step would not close root or password login: admin: "
    assert_not_contains "$R/var/log/swellwright-node-installer.log" "CHECK fail | SSH: administrators"
}

t_verify_fails_when_root_and_password_login_are_closed_and_nobody_can_log_in() {
    healthy_state
    : >"$R/home/admin/.ssh/authorized_keys"
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10
    assert_contains "$R/var/log/swellwright-node-installer.log" "CHECK fail | SSH: administrators with key login | none, and root and password login are closed: admin: "
}

# ---------------------------------------------------------------- secrets as files

# write_secret FILE VALUE [nolf]: a secret file, mode 600 (the stat stub says so where the file system cannot hold the mode).
write_secret() {
    printf '%s' "$2" >"$1"
    [ "${3:-lf}" = nolf ] || printf '\n' >>"$1"
    chmod 600 "$1"
    [ "$(stat -c '%a' "$1" 2>/dev/null)" = 600 ] || echo 600 >"$1.mode"
}

node_with_secret_file() { run_inst node NODE_DOMAIN=node1.example.com PANEL_ALLOW_IP=192.0.2.20 "$@"; }

t_secret_file_is_read() {
    node_acl_ready
    write_secret "$T/node.key" "$SECRET"
    node_with_secret_file SECRET_KEY_FILE="$T/node.key"
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" "SECRET_KEY=\"$SECRET\""
    # Only the fact that a file was used is journaled, never the value.
    assert_contains "$R/var/log/swellwright-node-installer.log" "SECRET_KEY is read from SECRET_KEY_FILE ($T/node.key)"
    assert_no_secret "$SECRET"
}

t_secret_file_without_a_final_line_break_and_with_mode_400() {
    node_acl_ready
    write_secret "$T/node.key" "$SECRET" nolf
    chmod 400 "$T/node.key"; echo 400 >"$T/node.key.mode"
    node_with_secret_file SECRET_KEY_FILE="$T/node.key"
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" "SECRET_KEY=\"$SECRET\""
}

t_secret_file_from_an_env_file() {
    node_acl_ready
    write_secret "$T/node.key" "$SECRET"
    write_env "$T/p.env" <<EOF
NODE_DOMAIN=node1.example.com
PANEL_ALLOW_IP=192.0.2.20
SECRET_KEY_FILE=$T/node.key
EOF
    run_inst_args --non-interactive --env-file "$T/p.env" node
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" "SECRET_KEY=\"$SECRET\""
    assert_no_secret "$SECRET"
}

t_secret_file_from_the_option() {
    node_acl_ready
    write_secret "$T/node.key" "$SECRET"
    write_env "$T/p.env" <<'EOF'
NODE_DOMAIN=node1.example.com
PANEL_ALLOW_IP=192.0.2.20
EOF
    run_inst_args --non-interactive --env-file "$T/p.env" --secret-file "SECRET_KEY=$T/node.key" node
    assert_rc 0
    assert_contains "$R/opt/remnanode/docker-compose.yml" "SECRET_KEY=\"$SECRET\""
    run_inst_args --non-interactive --env-file "$T/p.env" "--secret-file=SECRET_KEY=$T/node.key" node
    assert_rc 0
}

t_secret_file_option_refuses_what_is_not_a_secret() {
    run_inst_args --non-interactive --secret-file "NODE_IP=$T/x" node
    assert_rc 1
    assert_out "NODE_IP is not a secret parameter"
    run_inst_args --non-interactive --secret-file "SECRET_KEY" node
    assert_rc 1
    assert_out "--secret-file needs NAME=PATH"
}

t_secret_given_twice_is_refused() {
    have docker
    write_secret "$T/node.key" "$SECRET"
    node_with_secret_file SECRET_KEY_FILE="$T/node.key" SECRET_KEY="$SECRET"
    assert_rc 1
    assert_out "SECRET_KEY and SECRET_KEY_FILE are both given"
    assert_no_file "$R/opt/remnanode/docker-compose.yml"
    assert_no_secret "$SECRET"
    # The plain value in an env file and the file in the environment are just as ambiguous.
    printf 'SECRET_KEY=%s\n' "$SECRET" | write_env "$T/p.env"
    node_with_secret_file SECRET_KEY_FILE="$T/node.key" SW_ENV_FILE="$T/p.env"
    assert_rc 1
    assert_out "both given"
    assert_no_secret "$SECRET"
}

t_secret_file_with_a_loose_mode_is_refused() {
    write_secret "$T/node.key" "$SECRET"
    for _m in 640 644 660 666 700 777; do
        chmod "$_m" "$T/node.key"; echo "$_m" >"$T/node.key.mode"
        node_with_secret_file SECRET_KEY_FILE="$T/node.key"
        assert_rc 1
        assert_out "must have mode 600 or 400 (it is $_m)"
    done
    assert_no_file "$R/opt/remnanode/docker-compose.yml"
    assert_no_secret "$SECRET"
}

t_secret_file_owned_by_somebody_else_is_refused() {
    write_secret "$T/node.key" "$SECRET"
    echo 4242 >"$T/node.key.owner"
    node_with_secret_file SECRET_KEY_FILE="$T/node.key"
    assert_rc 1
    assert_out "must be owned by root or by the user running the installer"
}

t_secret_file_that_is_a_symbolic_link_is_refused() {
    write_secret "$T/node.key" "$SECRET"
    ln -s "$T/node.key" "$T/link.key" 2>/dev/null
    [ -L "$T/link.key" ] || skip "this platform cannot make symbolic links"
    node_with_secret_file SECRET_KEY_FILE="$T/link.key"
    assert_rc 1
    assert_out "is a symbolic link"
    assert_no_secret "$SECRET"
}

t_secret_file_that_is_missing_or_not_a_file_is_refused() {
    node_with_secret_file SECRET_KEY_FILE="$T/nope.key"
    assert_rc 1
    assert_out "does not exist"
    mkdir "$T/dir.key"
    node_with_secret_file SECRET_KEY_FILE="$T/dir.key"
    assert_rc 1
    assert_out "is not a regular file"
}

t_secret_file_that_is_too_large_or_not_one_line_is_refused() {
    head -c 20000 /dev/zero | tr '\0' a >"$T/big.key"; chmod 600 "$T/big.key"; echo 600 >"$T/big.key.mode"
    node_with_secret_file SECRET_KEY_FILE="$T/big.key"
    assert_rc 1
    assert_out "is larger than 16384 bytes"
    write_secret "$T/two.key" "$SECRET$NL$SECRET"
    node_with_secret_file SECRET_KEY_FILE="$T/two.key"
    assert_rc 1
    assert_out "must hold one line"
    printf '%s\n\n' "$SECRET" >"$T/blank.key"; chmod 600 "$T/blank.key"; echo 600 >"$T/blank.key.mode"
    node_with_secret_file SECRET_KEY_FILE="$T/blank.key"
    assert_rc 1
    assert_out "must hold one line"
    : >"$T/empty.key"; chmod 600 "$T/empty.key"; echo 600 >"$T/empty.key.mode"
    node_with_secret_file SECRET_KEY_FILE="$T/empty.key"
    assert_rc 1
    assert_out "is empty"
    printf '\n' >"$T/lf.key"; chmod 600 "$T/lf.key"; echo 600 >"$T/lf.key.mode"
    node_with_secret_file SECRET_KEY_FILE="$T/lf.key"
    assert_rc 1
    assert_out "is empty"
    assert_no_secret "$SECRET"
}

t_secret_file_path_must_be_absolute_and_plain() {
    for _p in relative.key '/tmp/a b' '/tmp/$(id)' '/tmp/`id`' "/tmp/it's"; do
        node_with_secret_file "SECRET_KEY_FILE=$_p"
        assert_rc 1
        assert_out "SECRET_KEY_FILE: expected an absolute path"
    done
}

t_secret_file_with_an_invalid_value_is_refused_without_echoing_it() {
    write_secret "$T/node.key" 'SENTINEL bad secret"quote'
    node_with_secret_file SECRET_KEY_FILE="$T/node.key"
    assert_rc 1
    assert_out "Invalid value for SECRET_KEY"
    assert_not_out "SENTINEL"
    write_secret "$T/crlf.key" "$SECRET$(printf '\r')"
    node_with_secret_file SECRET_KEY_FILE="$T/crlf.key"
    assert_rc 1
    assert_out "Invalid value for SECRET_KEY"
    assert_no_secret "$SECRET"
}

t_password_file_of_the_new_administrator() {
    printf '%s' "$SSHD_DEFAULT" >"$R/etc/ssh/sshd_config"
    write_secret "$T/pw" 'correct horse battery staple'
    run_inst ssh SSH_PHASE=user NEW_USER=admin NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD_FILE="$T/pw"
    assert_rc 0
    assert_line "$STATE/chpasswd.in" "admin:correct horse battery staple"
    assert_contains "$R/var/log/swellwright-node-installer.log" "NEW_USER_PASSWORD is read from NEW_USER_PASSWORD_FILE"
    assert_no_secret "correct horse battery staple"
    assert_no_secret "battery"
    # Both: refused, nothing is created.
    run_inst ssh SSH_PHASE=user NEW_USER=ops NEW_USER_PUBKEY="$KEY1" NEW_USER_PASSWORD_FILE="$T/pw" NEW_USER_PASSWORD='another password here'
    assert_rc 1
    assert_out "NEW_USER_PASSWORD and NEW_USER_PASSWORD_FILE are both given"
    assert_not_called "adduser --disabled-password --gecos  ops"
    assert_no_secret "another password here"
}

t_read_only_actions_do_not_read_secret_files() {
    healthy_state
    run_inst verify NODE_DOMAIN=node1.example.com NODE_IP=192.0.2.10 SECRET_KEY_FILE="$T/nope.key"
    assert_not_out "does not exist"
}

t_every_secret_has_a_file_variant_and_the_help_says_so() {
    in_inst '
        _bad=0
        for _n in $SECRET_PARAMS; do
            is_param "${_n}_FILE" || { echo "no ${_n}_FILE"; _bad=1; }
        done
        exit $_bad
    '
    [ "$RC" -eq 0 ] || fail "$(cat "$T/out" "$T/err" | tr '\n' ';')"
    run_inst help
    assert_out "--secret-file NAME=PATH"
    assert_out "SECRET_KEY_FILE"
    assert_out "NEW_USER_PASSWORD_FILE"
}
