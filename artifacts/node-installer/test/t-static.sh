# Tests that need no fake system: syntax, cleanliness of the file, the manifest, the validators.

t_syntax_sh_n() {
    sh -n "$INSTALLER" || fail "sh -n found a syntax error"
}

t_syntax_dash_n() {
    command -v dash >/dev/null 2>&1 || skip "dash is not installed"
    dash -n "$INSTALLER" || fail "dash -n found a syntax error"
}

t_syntax_posix_tools() {
    # Shell scripts of the suite itself.
    for _f in "$HERE"/*.sh; do
        sh -n "$_f" || fail "sh -n found a syntax error in ${_f#"$REPO"/}"
    done
}

# CI runs the tool as a step of its own; here it only has to agree when it is installed.
t_shellcheck_error_level() {
    [ -n "$REAL_SHELLCHECK" ] || skip "shellcheck is not installed"
    "$REAL_SHELLCHECK" -s sh -S error "$INSTALLER" >"$T/out" 2>&1 || fail "shellcheck found an error"
}

t_file_is_clean() {
    _cr=$(printf '\r')
    ! grep -q "$_cr" "$INSTALLER" || fail "install.sh has a carriage return"
    [ "$(head -n 1 "$INSTALLER")" = '#!/bin/sh' ] || fail "install.sh must start with #!/bin/sh"
    # Cyrillic letters are UTF-8 sequences starting with the bytes D0 or D1.
    ! LC_ALL=C grep -q "$(printf '[\320\321]')" "$INSTALLER" || fail "install.sh contains Cyrillic text: the messages are English only"
    # Only documentation address ranges, private ranges and the constants of the installer may appear as IPv4 addresses.
    _bad=$(grep -Eo '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' "$INSTALLER" | sort -u \
        | grep -Ev '^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|127\.0\.0\.1$|0\.0\.0\.0$)' || true)
    [ -z "$_bad" ] || fail "install.sh has an IPv4 address outside the documentation ranges: $_bad"
    # No e-mail addresses, no instance names.
    ! grep -Eq '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}' "$INSTALLER" || fail "install.sh contains an e-mail address"
    # Instance names are the business of scripts/check-hygiene.py (its forbidden patterns are not in the repository).
    ! grep -Eiq "owner's|BEGIN [A-Z ]*PRIVATE KEY" "$INSTALLER" || fail "install.sh talks about someone's decision or holds a key"
}

t_every_path_goes_through_the_root() {
    # A file under /etc, /opt, /var or /home is written as $R/... in a command; the exceptions are text inside configuration files.
    _bad=$(grep -nE '(>>?|\bmkdir -p|\bchmod [0-9]+|\bcp |\brm -f|\bwrite_file|\binstall -m) *"?/(etc|opt|var|home|usr/share)/' "$INSTALLER" | grep -v '^[0-9]*:[[:space:]]*#' || true)
    [ -z "$_bad" ] || fail "a path without \$R in a command: $_bad"
}

t_help_version_demo_need_no_root() {
    # No fake root and no stubs: the real system, without root, changes nothing.
    for _a in help version demo; do
        env -i PATH="$ORIG_PATH" ${SYSTEMROOT:+"SYSTEMROOT=$SYSTEMROOT"} HOME="$T" NO_COLOR=1 "$SHELL_UNDER_TEST" "$INSTALLER" "$_a" >"$T/out.$_a" 2>"$T/err" </dev/null
        RC=$?
        assert_rc 0
    done
    grep -q '^Swellwright node installer [0-9]' "$T/out.version" || fail "version prints no version"
    grep -q 'Usage:' "$T/out.help" || fail "help prints no usage"
    grep -q 'nothing is changed' "$T/out.demo" || fail "demo does not say that nothing is changed"
}

t_root_mode_ignores_the_test_root_and_source_hooks() {
    mkstub id <<'EOF'
[ "$1" = -u ] && echo 0
EOF
    have id
    run_inst version SW_SOURCE_ONLY=1
    assert_rc 0
    assert_out "Swellwright node installer"
    env PATH="$BIN:$ORIG_PATH" SW_TEST_ALLOW_ROOT=1 "$SHELL_UNDER_TEST" "$HERE/run-tests.sh" no-such-test >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 2
    assert_out "Refusing to run the test suite as root"
}

t_root_mode_uses_trusted_tmpdir_even_when_the_caller_sets_one() {
    mkstub id <<'EOF'
[ "$1" = -u ] && echo 0
EOF
    mkstub fold <<'EOF'
printf 'temporary directory: %s\n' "$TMPDIR"
EOF
    have id fold
    run_inst help TMPDIR="$T/caller-controlled"
    assert_rc 0
    assert_out "temporary directory: /run"
    assert_not_out "caller-controlled"
}

t_version_matches_manifest() {
    _v=$(sed -n 's/^INSTALLER_VERSION=//p' "$INSTALLER")
    _m=$(sed -n 's/^ *"version": "\(.*\)",$/\1/p' "$HERE/../manifest.json" | head -n1)
    [ "$_v" = "$_m" ] || fail "INSTALLER_VERSION $_v differs from the manifest $_m"
    env -i PATH="$ORIG_PATH" "$SHELL_UNDER_TEST" "$INSTALLER" version >"$T/out" 2>&1
    grep -qF "$_v" "$T/out" || fail "version prints something else than $_v"
}

t_manifest_is_current() {
    [ -n "$REAL_NODE" ] || skip "node is not installed"
    ( cd "$REPO" && "$REAL_NODE" scripts/artifact-manifest.mjs --check ) >"$T/out" 2>&1 || fail "the manifest or the README tables are out of date"
}

t_manifest_hash_matches_file() {
    _sum=$(sha256sum "$INSTALLER" | cut -d' ' -f1)
    grep -qF "\"sha256\": \"$_sum\"" "$HERE/../manifest.json" || fail "the sha256 of install.sh is not the one in manifest.json"
    _size=$(wc -c <"$INSTALLER" | tr -d ' ')
    grep -qF "\"size\": $_size," "$HERE/../manifest.json" || fail "the size of install.sh is not the one in manifest.json"
}

# A version is bound to its bytes (releases.json): the same version with other bytes is refused by build and by --check, and
# the hash is the hash of the bytes on disk (a byte that is not UTF-8 is refused, not re-encoded). Runs the tool on a copy.
t_manifest_tool_binds_a_version_to_its_bytes() {
    [ -n "$REAL_NODE" ] || skip "node is not installed"
    _a=$T/arts; mkdir -p "$_a/x"
    cp "$INSTALLER" "$HERE/../manifest.json" "$HERE/../README.md" "$HERE/../releases.json" "$_a/x/"
    _tool() { env SW_ARTIFACTS_ROOT="$_a" SW_ARTIFACT_BASE_REF="${_base:-}" "$REAL_NODE" "$REPO/scripts/artifact-manifest.mjs" "$@" >"$T/out" 2>"$T/err"; RC=$?; }
    _base=
    _tool --check
    assert_rc 0
    # One more byte, same version.
    printf '# changed\n' >>"$_a/x/install.sh"
    _tool --check
    assert_rc 1
    assert_out "is recorded in releases.json with other bytes"
    _tool build
    assert_rc 1
    assert_out "A released version is never edited"
    # A new version is recorded, and only grows the record.
    sed 's/^INSTALLER_VERSION=.*/INSTALLER_VERSION=9.9.9/' "$_a/x/install.sh" >"$_a/x/install.new" && mv "$_a/x/install.new" "$_a/x/install.sh"
    _tool build
    assert_rc 0
    assert_contains "$_a/x/releases.json" '"9.9.9": {'
    assert_contains "$_a/x/releases.json" '"1.0.2": {'
    _tool --check
    assert_rc 0
    grep -qF "\"sha256\": \"$(sha256sum "$_a/x/install.sh" | cut -d' ' -f1)\"" "$_a/x/manifest.json" || fail "the manifest hash is not the hash of the bytes"
    # A lower version than one recorded is refused.
    sed 's/^INSTALLER_VERSION=.*/INSTALLER_VERSION=1.0.3/' "$_a/x/install.sh" >"$_a/x/install.new" && mv "$_a/x/install.new" "$_a/x/install.sh"
    _tool build
    assert_rc 1
    assert_out "is lower than the recorded"
    # A byte that is not UTF-8.
    sed 's/^INSTALLER_VERSION=.*/INSTALLER_VERSION=9.9.10/' "$_a/x/install.sh" >"$_a/x/install.new" && mv "$_a/x/install.new" "$_a/x/install.sh"
    printf '# \377\n' >>"$_a/x/install.sh"
    _tool build
    assert_rc 1
    assert_out "is not valid UTF-8"
}

# --check compares with a base revision: a version that the base has may not get other bytes, and the record only grows.
t_manifest_tool_compares_with_the_base_revision() {
    [ -n "$REAL_NODE" ] || skip "node is not installed"
    command -v git >/dev/null 2>&1 || skip "git is not installed"
    _a=$T/arts; mkdir -p "$_a/x"
    cp "$INSTALLER" "$HERE/../manifest.json" "$HERE/../README.md" "$HERE/../releases.json" "$_a/x/"
    _g() { git -C "$_a" -c user.name=test -c user.email=test -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@" >/dev/null 2>&1; }
    _g init -q && _g add -A && _g commit -q -m base || skip "cannot make a temporary git repository"
    _tool() { env SW_ARTIFACTS_ROOT="$_a" SW_ARTIFACT_BASE_REF=HEAD "$REAL_NODE" "$REPO/scripts/artifact-manifest.mjs" "$@" >"$T/out" 2>"$T/err"; RC=$?; }
    _tool --check
    assert_rc 0
    assert_out "compared with HEAD"
    # Dropping a recorded version from releases.json is seen.
    "$REAL_NODE" -e '
      const fs = require("fs"); const f = process.argv[1];
      const r = JSON.parse(fs.readFileSync(f, "utf8")); delete r.versions["1.0.0"];
      fs.writeFileSync(f, JSON.stringify(r, null, 2) + "\n");' "$_a/x/releases.json"
    _tool --check
    assert_rc 1
    assert_out "version 1.0.0 is recorded at HEAD but not here"
    _g checkout -- x/releases.json
    # Rebuilding neither skips base validation nor assigns the old number again after a ledger edit.
    "$REAL_NODE" -e '
      const fs = require("fs"); const f = process.argv[1];
      const r = JSON.parse(fs.readFileSync(f, "utf8")); r.versions["1.0.0"].size++;
      fs.writeFileSync(f, JSON.stringify(r, null, 2) + "\n");' "$_a/x/releases.json"
    _tool build
    assert_rc 1
    assert_out "version 1.0.0 is recorded here with other bytes"
    _g checkout -- x/releases.json
    # The version the base has, with other bytes: build refuses to record it again.
    printf '# changed\n' >>"$_a/x/install.sh"
    _tool build
    assert_rc 1
    assert_out "and is in HEAD"
    _tool --check
    assert_rc 1
    env SW_ARTIFACTS_ROOT="$_a" SW_ARTIFACT_BASE_REF=no-such-revision "$REAL_NODE" "$REPO/scripts/artifact-manifest.mjs" --check >"$T/out" 2>"$T/err"
    RC=$?
    assert_rc 1
    assert_out "is not a revision of this repository"
    # Deleting the script must not delete the comparison with the base, even if another artifact still exists.
    mv "$_a/x" "$_a/y"
    _tool --check
    assert_rc 1
    assert_out "x: artifact exists at HEAD but not here"
}

t_artifact_base_guard_uses_trusted_code_and_fails_on_a_missing_blob() {
    [ -n "$REAL_NODE" ] || skip "node is not installed"
    command -v git >/dev/null 2>&1 || skip "git is not installed"
    _a="$T/candidate"
    mkdir -p "$_a/artifacts/x" "$_a/scripts"
    cp "$INSTALLER" "$HERE/../manifest.json" "$HERE/../README.md" "$HERE/../releases.json" "$_a/artifacts/x/"
    cp "$REPO/scripts/artifact-manifest.mjs" "$_a/scripts/"
    _g() { git -C "$_a" -c user.name=test -c user.email=test -c commit.gpgsign=false -c core.hooksPath=/dev/null -c core.autocrlf=false "$@"; }
    _g init -q && _g add -A && _g commit -q -m base || fail "cannot make a temporary git repository"
    _base=$(_g rev-parse HEAD) || fail "cannot read the base commit"
    _guard() { env PATH="$(dirname "$REAL_NODE"):$PATH" sh "$REPO/scripts/check-artifact-base.sh" "$_a" "$_base" "$@" >"$T/out" 2>"$T/err"; RC=$?; }
    _guard "$_base"
    assert_rc 0
    printf '# changed without raising the version\n' >>"$_a/artifacts/x/install.sh"
    "$REAL_NODE" -e '
        const fs = require("node:fs");
        const crypto = require("node:crypto");
        const dir = process.argv[1];
        const bytes = fs.readFileSync(dir + "/install.sh");
        const manifest = JSON.parse(fs.readFileSync(dir + "/manifest.json"));
        const releases = JSON.parse(fs.readFileSync(dir + "/releases.json"));
        const digest = { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
        Object.assign(manifest, digest);
        releases.versions[manifest.version] = digest;
        fs.writeFileSync(dir + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
        fs.writeFileSync(dir + "/releases.json", JSON.stringify(releases, null, 2) + "\n");
    ' "$_a/artifacts/x" || fail "cannot prepare candidate metadata"
    printf 'process.exit(0);\n' >"$_a/scripts/artifact-manifest.mjs"
    _g add -A && _g commit -q -m candidate || fail "cannot record the test candidate"
    _candidate=$(_g rev-parse HEAD) || fail "cannot read the candidate commit"
    _guard "$_candidate"
    assert_rc 1
    assert_out "recorded here with other bytes than at"
    cp "$INSTALLER" "$HERE/../manifest.json" "$HERE/../releases.json" "$_a/artifacts/x/"
    _blob=$(_g rev-parse "$_base:artifacts/x/releases.json") || fail "cannot read the base ledger object id"
    _rest=${_blob#??}
    rm -f "$_a/.git/objects/${_blob%"$_rest"}/$_rest"
    _guard
    assert_rc 1
    assert_out "cannot read artifacts/x/releases.json at"
}

# Every row of validators.tsv: accept|NAME|value or reject|NAME|value, optionally a fourth column y/n: does the
# published pattern of the manifest match (default: accept means yes, reject means no; a validator can be stricter than its pattern).
t_validators_table() {
    [ -n "$REAL_NODE" ] || skip "node is not installed (needed to read the patterns of the manifest)"
    "$REAL_NODE" -e '
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const [n, p] of Object.entries(m.params)) if (p.pattern) console.log(n + "\t" + p.pattern);
    ' "$HERE/../manifest.json" >"$T/patterns.tsv" || fail "could not read the patterns of the manifest"
    in_inst "
        TAB=\$(printf '\\t')
        while IFS=\$TAB read -r _n _p; do eval \"PAT_\$_n=\\\$_p\"; done <'$T/patterns.tsv'
        _bad=0
        while IFS='|' read -r _e _n _v _m; do
            case \$_e in ''|'#'*) continue ;; esac
            if param_valid \"\$_n\" \"\$_v\"; then _got=accept; else _got=reject; fi
            [ \"\$_got\" = \"\$_e\" ] || { echo \"validator: \$_n '\$_v': expected \$_e, got \$_got\"; _bad=1; }
            eval \"_pat=\\\${PAT_\$_n:-}\"
            if [ -n \"\$_pat\" ]; then
                [ -n \"\$_m\" ] || { if [ \"\$_e\" = accept ]; then _m=y; else _m=n; fi; }
                if printf '%s\\n' \"\$_v\" | LC_ALL=C grep -Eq \"\$_pat\"; then _pm=y; else _pm=n; fi
                [ \"\$_pm\" = \"\$_m\" ] || { echo \"pattern of \$_n: '\$_v': expected match=\$_m, got \$_pm\"; _bad=1; }
            fi
        done <'$HERE/validators.tsv'
        exit \$_bad
    "
    [ "$RC" -eq 0 ] || fail "validator table: $(cat "$T/out" "$T/err" | head -n 8 | tr '\n' ';')"
}

t_validators_refuse_line_breaks() {
    in_inst '
        NLX=$(printf "\nx")
        _bad=0
        for _c in "NODE_DOMAIN node1.example.com$NLX" "NODE_IP 192.0.2.10$NLX" "NODE_PORT 443$NLX" "PANEL_ALLOW_IP 192.0.2.20$NLX" "NEW_USER admin$NLX" "CERTSYNC_PUBKEY ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLE$NLX" "NODE_IMAGE_TAG 3.4.6$NLX" "SECRET_KEY ABCDEFGHIJKLMNOPQRSTUVWX$NLX"; do
            _n=${_c%% *}; _v=${_c#* }
            param_valid "$_n" "$_v" && { echo "accepted a line break: $_n"; _bad=1; }
        done
        _v=$(printf "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLE\nssh-rsa AAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        param_valid CERTSYNC_PUBKEY "$_v" && { echo "accepted two keys"; _bad=1; }
        _v="node1.example.com
evil.example.com"
        param_valid NODE_DOMAIN "$_v" && { echo "accepted two domains on two lines"; _bad=1; }
        exit $_bad
    '
    [ "$RC" -eq 0 ] || fail "a value with a line break was accepted: $(cat "$T/out" "$T/err" | head -n 5 | tr '\n' ';')"
}

t_secret_length_limits() {
    # The pattern has no upper bound (grep would need half a minute to compile {16,8192}); the validator has.
    in_inst '
        _ok=$(printf "%8192s" "" | tr " " a)
        _long=$(printf "%8193s" "" | tr " " a)
        param_valid SECRET_KEY "$_ok" || { echo "8192 characters refused"; exit 1; }
        param_valid SECRET_KEY "$_long" && { echo "8193 characters accepted"; exit 1; }
        param_valid SECRET_KEY "aaaaaaaaaaaaaaa" && { echo "15 characters accepted"; exit 1; }
        param_valid SECRET_KEY "aaaaaaaaaaaaaaaa" || { echo "16 characters refused"; exit 1; }
        exit 0
    '
    [ "$RC" -eq 0 ] || fail "$(cat "$T/out" "$T/err" | head -n 3 | tr '\n' ';')"
}

t_every_validator_is_fast() {
    # A validator that takes seconds is a bug (a large repetition bound in a pattern did once): every row of the table in a few seconds.
    in_inst '
        _t0=$(date +%s)
        for _n in NODE_DOMAIN RENAME_ALIAS NODE_IP PANEL_ALLOW_IP FAIL2BAN_IGNORE_EXTRA CERTSYNC_PUBKEY SECRET_KEY NEW_USER_PASSWORD NODE_IMAGE_TAG; do
            param_valid "$_n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || true
        done
        _t1=$(date +%s)
        [ $((_t1 - _t0)) -le 10 ] || { echo "validators took $((_t1 - _t0)) s"; exit 1; }
        exit 0
    '
    [ "$RC" -eq 0 ] || fail "$(cat "$T/out" "$T/err" | head -n 3 | tr '\n' ';')"
}

t_every_param_has_a_validator_and_a_hint() {
    in_inst '
        _bad=0
        for _n in $PARAM_NAMES SW_NONINTERACTIVE SW_VERBOSE SW_ASCII; do
            h=$(param_hint "$_n")
            [ "$h" != "a known parameter" ] || { echo "no hint: $_n"; _bad=1; }
        done
        exit $_bad
    '
    [ "$RC" -eq 0 ] || fail "$(cat "$T/out" "$T/err" | tr '\n' ';')"
}
