# Node installer

`install.sh` installs and hardens a [Remnawave](https://github.com/remnawave) node on Debian or Ubuntu. It is the [artifact](../README.md) that Swellwright ships to a server, and it is a plain POSIX `sh` script you can also read and run yourself. The decisions behind it are in [ADR 0036](../../docs/adr/0036-node-installer-artifact.md).

```
Internet -> HAProxy (SNI routing, public IP:443)
              |- the node's domain ----> remnanode container (Xray on 127.0.0.1:443)
              |                             \-> nginx "SelfSNI" site (unix socket, PROXY protocol)
              \- any other SNI, or none -> nginx default site (404) on 127.0.0.1:8444
```

A foreign or missing SNI is answered with an ordinary 404, not a dropped connection. Docker publishes ports around UFW, so guarded startup applies and verifies the IPv4 `DOCKER-USER` rules before publishing the node API port. Certificates are delivered to `/opt/certs` by whatever you use (a restricted `rrsync` key is prepared for it); until the real one arrives a temporary self-signed one keeps nginx up.

## Requirements

- Debian 12, Ubuntu 22.04 or 24.04, `root`, an IPv4 address on the server, internet access to the package repositories, `download.docker.com` and `nginx.org` (and the HAProxy PPA on Ubuntu). The steps are derived from an installer that has run on Ubuntu servers in production; this script itself is verified by tests with stubbed commands (every step) and, since 1.0.1, by every step (twice each, and `full` on the finished node) on a reset Ubuntu 24.04 server; the rules of the `ssh` step (1.0.2) were also checked against the real sshd there. The changes of 1.1.0 (the keyring of only the pinned keys, the switch of the node API port rules in one transaction, the named administrator and the automatic rollback of the `ssh` step) are covered by the stubbed tests only and have not run on a real server yet. Debian is supported by the code and covered by stubs only.
- A domain name for the node whose A record points at the server, and the node's `SECRET_KEY` from the panel.
- The address of the panel, as the node sees it (`PANEL_ALLOW_IP`).

## Run it by hand

Check the file against the manifest first (the same check Swellwright makes before and after uploading it):

```sh
grep '"sha256"' manifest.json
sha256sum install.sh
```

Then, as root:

```sh
sh install.sh help                 # actions, options, parameters
sh install.sh preflight            # read-only checks of the server
sh install.sh                      # the menu (needs a terminal)
sh install.sh full                 # all steps in order; asks for what is missing
```

Without a terminal give everything as parameters, in the environment or in a file (`NAME=value` lines, mode 600, owned by the user running the installer; it is read, never executed):

```sh
cat >/root/node.env <<'EOF'
NODE_DOMAIN=node1.example.com
NODE_IP=192.0.2.10
PANEL_ALLOW_IP=192.0.2.20
SECRET_KEY=...the key from the panel...
CERTSYNC_PUBKEY=ssh-ed25519 AAAA... sender@example
EOF
chmod 600 /root/node.env
sh install.sh --non-interactive --env-file /root/node.env full
sh install.sh --non-interactive --env-file /root/node.env verify
```

Priority of a parameter: the environment, then the env file, then the configuration the installer saved (`/etc/swellwright-node-installer.conf`, never a secret), then the default. Every value is validated, whether it was typed or given, before the first step runs. The steps are idempotent: after a failure fix the cause and run the step (or `full`) again.

`ssh` is not part of `full`: it needs an administrator and keys. Run the account phase (`SSH_PHASE=user`), then run `SSH_PHASE=root` from a terminal with `NEW_USER` and `NEW_USER_PUBKEY`. The installer asks you to confirm a fresh login and root access before and after the change; it cannot verify those connections itself. A non-interactive invocation cannot close either login method.

### Secrets from files

A secret parameter (`SECRET_KEY`, `NEW_USER_PASSWORD`; the manifest marks them `secret: true`) can be given as a file instead of a value: `SECRET_KEY_FILE=/path`, `NEW_USER_PASSWORD_FILE=/path`, in the environment or in the env file, or as the option `--secret-file NAME=PATH`. A program that drives the installer should use this, so that no secret is ever an environment variable or an argument. The file must be a regular file (a symbolic link is refused), owned by root or by the user running the installer, with mode 600 or 400, hold one line (one final line break is removed) and be at most 16 KiB. The value is validated like a typed one. Giving the value as well as the file is refused as ambiguous, whichever of the two is in the environment and which in the env file. The value is never printed; the journal says only `SECRET_KEY is read from SECRET_KEY_FILE (path)`. `preflight` and `verify` do not read the files.

```sh
install -m 600 /dev/null /root/node-secret
printf '%s' "$KEY_FROM_THE_PANEL" >/root/node-secret
SECRET_KEY_FILE=/root/node-secret sh install.sh --non-interactive --env-file /root/node.env node
sh install.sh --non-interactive --env-file /root/node.env --secret-file SECRET_KEY=/root/node-secret node
```

## Steps

<!-- manifest:steps:begin -->
| Step | What it does | Changes the server | In `full` | Parameters |
| --- | --- | --- | --- | --- |
| `preflight` | Preflight checks | no (read-only) | no | - |
| `base` | Base packages and system upgrade | yes | yes | BASE_UPGRADE |
| `system` | System tuning: BBR, journald, NTP | yes | yes | - |
| `hostname` | Host name and /etc/hosts | yes | yes | **NODE_DOMAIN**, **NODE_IP** |
| `firewall` | Firewall (UFW) | yes | yes | SSH_PORT, NODE_PORT, **PANEL_ALLOW_IP** |
| `fail2ban` | fail2ban for SSH | yes | yes | SSH_PORT, PANEL_ALLOW_IP, FAIL2BAN_IGNORE_EXTRA |
| `docker` | Docker | yes | yes | DOCKER_SOURCE |
| `apiacl` | Node API port open to the panel only (DOCKER-USER and UFW) | yes | yes | NODE_PORT, **PANEL_ALLOW_IP** |
| `certsync` | Certificate receiver (restricted rsync key) | yes | yes | **CERTSYNC_PUBKEY**, **NODE_DOMAIN** |
| `nginx` | nginx: SelfSNI site and default site | yes | yes | **NODE_DOMAIN** |
| `haproxy` | HAProxy: SNI routing with a default backend | yes | yes | **NODE_DOMAIN**, **NODE_IP**, HAPROXY_SOURCE, HAPROXY_VERSION |
| `node` | Remnawave node container (guarded systemd startup; run apiacl first) | yes | yes | NODE_PORT, **SECRET_KEY**, SECRET_KEY_FILE, NODE_IMAGE_TAG |
| `verify` | Verify the node | no (read-only) | yes | NODE_DOMAIN, NODE_IP, NODE_PORT, NODE_IMAGE_TAG, PANEL_ALLOW_IP |
| `ssh` | SSH: administrator account, keys, root and password login | yes | no | SSH_PHASE, **NEW_USER**, **NEW_USER_PUBKEY**, NEW_USER_PUBKEY2, NEW_USER_PASSWORD, NEW_USER_PASSWORD_FILE, SSH_DISABLE_ROOT, SSH_DISABLE_PASSWORD |
| `rename` | Rename the node on this server | yes | no | **NODE_DOMAIN**, RENAME_FROM, RENAME_ALIAS, NODE_IP |
<!-- manifest:steps:end -->

`full` runs the steps marked "In `full`" in the order of the table; `certsync` is skipped when `CERTSYNC_PUBKEY` is empty. **Bold** parameters stop a step that cannot ask for them.

## Parameters

Read from the environment, an env file or the saved configuration:

<!-- manifest:nodeParams:begin -->
| Parameter | Required by a step | Default | Format or values | Secret | Meaning |
| --- | --- | --- | --- | --- | --- |
| `NODE_DOMAIN` | yes | - | `node1.example.com` | no | Public domain name of the node: SNI, host name and SelfSNI site. Upper case is converted to lower case. |
| `NODE_IP` | yes | - | `192.0.2.10` | no | Public IPv4 address of this server; HAProxy binds it on port 443. |
| `NODE_PORT` | no | `62050` | `62050` | no | TCP port of the node API (panel to node); not 80, 443 or 8444. Changing an existing managed port is not supported. |
| `SECRET_KEY` | yes | - | - | yes | Node secret key from the panel (the SECRET_KEY of the compose file the panel shows for the node). 16 to 8192 characters of letters, digits and + / = _ . : -. Kept only in the compose file, mode 600. Or give SECRET_KEY_FILE. |
| `SECRET_KEY_FILE` | no | - | `/run/secrets/node-secret-key` | no | Path of a file that holds the node secret key instead of SECRET_KEY: a regular file (not a link) owned by root or by the user running the installer, mode 600 or 400, one line, at most 16 KiB. Giving both is refused. Also the option --secret-file SECRET_KEY=PATH. |
| `PANEL_ALLOW_IP` | yes | - | `192.0.2.20 198.51.100.7` | no | IPv4 addresses (space separated) that may reach the node API port: the panel. Nobody else can. |
| `SSH_PORT` | no | `22` | `22` | no | SSH port that the firewall keeps open. Default: the port sshd reports, else 22. |
| `CERTSYNC_PUBKEY` | yes | - | `ssh-ed25519 AAAA... sender@example` | no | Public key of whatever delivers certificates to /opt/certs. Installed for the user certsync, limited to rrsync in that directory (command=, restrict). Empty: the receiver is not set up and full skips it. |
| `NODE_IMAGE_TAG` | no | `3.4.6` | `3.4.6` | no | Explicit release tag of the remnawave/node image. Floating tags such as latest and nightly are refused. Tags are not digest pins. |
| `FAIL2BAN_IGNORE_EXTRA` | no | - | `192.0.2.0/24 198.51.100.7` | no | Extra IPv4 addresses or CIDR ranges (prefix 8 to 32, space separated) that fail2ban never bans, for example the Swellwright server. |
| `BASE_UPGRADE` | no | `yes` | `yes`, `no` | no | Run apt upgrade in the base step. |
| `DOCKER_SOURCE` | no | `apt` | `apt` | no | Docker's apt repository with a pinned signing key. The convenience script is not supported. |
| `HAPROXY_SOURCE` | no | `auto` | `auto`, `ppa`, `distro` | no | auto: the PPA on Ubuntu, the distribution package on Debian. ppa: the vbernat PPA of HAPROXY_VERSION. distro: the distribution package. |
| `HAPROXY_VERSION` | no | `3.2` | `3.2` | no | HAProxy series for the PPA (major.minor). |
| `SSH_PHASE` | no | `all` | `user`, `root`, `all` | no | user: create the administrator and its keys. root: close the requested login methods, only with a terminal and a confirmed fresh administrator login with root access. all: both. |
| `NEW_USER` | yes | - | `admin` | no | Administrator account with sudo. Before root or password login is closed (SSH_PHASE=root or all) it names the administrator whose key login must work. Not root and not certsync. |
| `NEW_USER_PUBKEY` | yes | - | `ssh-ed25519 AAAA... admin@example` | no | Public SSH key of the administrator. Before root or password login is closed it must be a key in the key file of NEW_USER that gives a shell. |
| `NEW_USER_PUBKEY2` | no | - | `ssh-ed25519 AAAA... backup@example` | no | Optional second (backup) public SSH key of the administrator. |
| `NEW_USER_PASSWORD` | no | - | - | yes | Password of a newly created administrator (sudo needs it). Required without a terminal. Only through the environment, an env file or NEW_USER_PASSWORD_FILE, never logged. |
| `NEW_USER_PASSWORD_FILE` | no | - | `/run/secrets/admin-password` | no | Path of a file that holds the password of the new administrator instead of NEW_USER_PASSWORD: same rules as SECRET_KEY_FILE. Giving both is refused. Also the option --secret-file NEW_USER_PASSWORD=PATH. |
| `SSH_DISABLE_ROOT` | no | `yes` | `yes`, `no` | no | Close root login over SSH (only when an administrator can really log in: see the README, section SSH). |
| `SSH_DISABLE_PASSWORD` | no | `no` | `yes`, `no` | no | Close password login over SSH (only when an administrator can really log in with a key). Check the key login in another window first. |
| `RENAME_FROM` | no | - | `node1.example.com` | no | The former domain in the rename step. Default: the domain from the saved configuration. |
| `RENAME_ALIAS` | no | - | `node1.example.com` | no | Domains (space separated) that nginx and HAProxy keep accepting besides the new one, until clients have the new name. |
| `INSTALL_MODE` | no | `new` | `new`, `redeploy` | no | new: a node that is not in the panel yet. redeploy: an existing node on a new or reinstalled server (changes the closing checklist). |
<!-- manifest:nodeParams:end -->

Only the environment or an option (`--env-file`, `--non-interactive`):

<!-- manifest:installerParams:begin -->
| Parameter | Required by a step | Default | Format or values | Secret | Meaning |
| --- | --- | --- | --- | --- | --- |
| `SW_NONINTERACTIVE` | no | `0` | `0`, `1` | no | 1: never ask; a missing required parameter stops the run. |
| `SW_ENV_FILE` | no | - | `/root/node.env` | no | File with NAME=value lines for the parameters above (the option --env-file does the same). Mode 600, owned by root. |
| `SW_VERBOSE` | no | `0` | `0`, `1` | no | 1: show the output of apt and docker on the screen (it always goes to the journal). |
| `SW_ASCII` | no | `0` | `0`, `1` | no | 1: plain ASCII symbols instead of Unicode ones. |
| `NO_COLOR` | no | - | `1` | no | Any non-empty value switches colours off (no-color.org). |
<!-- manifest:installerParams:end -->

## SSH: who counts as an administrator

Closing root login, or password login, is safe only when somebody else can really log in and administer the server. Being a member of the `sudo` group does not show that: on a real server an account of the hosting provider sat in the group, had no key, and an earlier version (1.0.1) closed root login with nobody able to log in. Since 1.0.2 the `ssh` step closes either only when at least one account passes every rule below (one function, used before both closings), and a refusal names every account it looked at and the first rule that each failed, in words.

Candidates are the accounts the `sudo` group gives sudo to: its members and the accounts whose primary group it is. An account counts when:

1. **It is a real account**: it exists in `passwd`, is not `root` and not `certsync`, and has an ordinary user id (`UID_MIN` to `UID_MAX` of `login.defs`, 1000 to 60000 without it).
2. **sshd lets it in with a key.** Asked of `sshd -T -C user=NAME,host=localhost,addr=127.0.0.1`, which applies the `Match` blocks: `PubkeyAuthentication` is on, `AuthenticationMethods` does not ask for more than a key (`any`, or an alternative that is `publickey` alone), and `AllowUsers`, `DenyUsers`, `AllowGroups` and `DenyGroups` do not keep it out (patterns with `*` and `?`; an entry `user@host` is taken by its user part when it allows, and ignored when it denies).
3. **The account is not disabled.** Its login shell is an executable file that is not `nologin` or `false`; its expiry date (`shadow`) has not passed, nor the inactivity period after an expired password; a locked password is fine when sshd uses PAM (it accepts a key for a locked account) and refused when `UsePAM no` (sshd then refuses a locked account even for a key).
4. **A key can be read where sshd looks** (`AuthorizedKeysFile` of that dump, `%h`, `%u`, `%U` expanded, `none` meaning no file). Unless `StrictModes no`: the file, `~/.ssh` and the home directory belong to the account or to root and are not writable by group or others, and the account can read the file. At least one line must be a valid public key (`ssh-keygen -l` accepts a copy of it) that gives a shell: not `command=`, and not `restrict` or `no-pty` unless a later `pty` gives the terminal back. Other options (`from=`, `no-agent-forwarding`, ...) do not matter.
5. **It can become root**: `sudo` is installed, `sudo -l -U NAME` does not say that sudoers refuses it, and it has a usable password or a `NOPASSWD` rule (an account with a locked password and no such rule could log in and not administer).

The rules are stricter than sshd in one place, on purpose. Measured on Ubuntu 24.04 (OpenSSH 9.6): `StrictModes` refuses a path that others can write, and one that a group with other members can write, but accepts a group-writable home directory, `~/.ssh` or key file when the group is the account's own private group with no other member. The installer refuses any write by group or others, because it cannot know which build of sshd answers and a wrong yes loses access; `chmod g-w` is the fix. The same measurement confirmed the other rules: an expired account is refused by PAM even with a valid key, a locked password is not (the key logs in), a forced command runs instead of the shell, `restrict` still lets a key run commands but gives no terminal (the installer counts that as no administrator, see rule 4), and `nologin` accepts the key and closes the session.

An entry `user@host` of `AllowUsers` or `DenyUsers` is read differently for the named administrator (next section): there the address is that of an open SSH session, the host part must match it to allow, and it keeps the account out when it matches (a CIDR host part is not read, so such an entry does not allow).

You see this before anything is closed: the `ssh` step prints `Administrators who can log in with a key: ...` and one `not counted: NAME: reason` line for every other candidate, in both phases, and `verify` has a check, `SSH: administrators with key login`, with the same list (a warning when nobody counts, a failure when nobody counts and root and password login are already closed). A refusal is exit code 1 like every other stop. What it does not recognise: keys given by `AuthorizedKeysCommand` or certificates (`cert-authority`), accounts that are not in the `sudo` group (a `wheel` group, `sudoers` entries by name). On such a server the step refuses and root login stays open; there is no bypass, and closing it is then a decision made by hand.

## SSH: the change undoes itself

Counting an administrator is not enough to close root login: the account that counts may not be the one you can reach, or the key in its file may not be yours. Since 1.1.0 the step closes root login or password login only through these stages. If recovery fails, use the console and the saved files:

1. **The named pair passes a precheck and a live login.** `NEW_USER` must be a member of the `sudo` group that counts by the rules above, and `NEW_USER_PUBKEY` (type and key; the comment does not matter) must be a line that gives a shell in a key file sshd reads for that account, a file that passes rule 4. A line with `from=`, `expiry-time=`, `cert-authority` or `principals=` does not count for this; a `DenyUsers` entry with a CIDR host part counts as keeping the account out. sshd is asked for a login from the addresses that `ss` reports for open SSH sessions, or loopback if there are none. An `ss` error blocks the precheck. Before the installer writes anything to sshd, open a fresh connection with the named key, verify that `sudo id -u` prints `0`, and leave that session open.
2. **A persistent rollback is armed** before sshd is edited. The original files are saved under `/var/lib/swellwright-ssh-rollback`, and the step enables `sw-ssh-rollback.timer` and its service under `/etc/systemd/system`. The timer runs 300 seconds after activation, including after a reboot while it is enabled. The step refuses if it cannot arm the timer or an earlier rollback is still pending.
3. **The new configuration is checked**: `sshd -t` must accept it, and `sshd -T` must show `PermitRootLogin no` (and `PasswordAuthentication no`, `KbdInteractiveAuthentication no` when password login is closed) in effect, so a file read earlier is caught, also for a login of root and of the administrator from the address of every open session (`sshd -T -C`); a `Match` block in `sshd_config` or `sshd_config.d` that sets the value being closed to anything but `no`, an `Include` of anything but the stock `/etc/ssh/sshd_config.d/*.conf`, and an `Include` inside a `Match` block are refused, to be resolved by hand; the named pair must still work under the new configuration. A failure puts the saved files back at once, without a restart.
4. **sshd is restarted** and must be running; otherwise the saved files come back and sshd is restarted again.
5. **The rollback is disarmed** only after you confirm that a fresh connection as `NEW_USER` with the named key worked and `sudo id -u` printed `0` in a second window. Do not reuse a multiplexed connection. A negative or late answer triggers immediate rollback. If the run stops before confirmation, the enabled timer can restore the old configuration. The rollback runs `sshd -t` before restarting and tries the restart up to three times. It retains the backup if restoration fails; use the console in that case. The step and rollback use a separate `flock` lock. Confirmation is saved before the timer is stopped or disabled, so a later timer can clean up but cannot restore old SSH settings after confirmation.

The installer never asks for your private key. The fresh login and `sudo` test are operator checks, not inferences from `sshd -T`.

When the timer restores SSH, it validates the restored configuration and checks that the SSH unit is active before removing its own timer, service file and snapshot. It records the result in the installer journal and in the service journal (`journalctl -u sw-ssh-rollback.service`). If restoration fails, the snapshot and recovery state stay in place. If restoration succeeded but cleanup failed, the next SSH hardening run retries cleanup without restoring the files again. Invoking `rollback.sh` manually without arguments still restores and leaves the snapshot for inspection.

On upgrade, `done` alone is not proof of restoration. Cleanup requires a matching `rollback` claim, successful `sshd -t` and an active SSH service. If a claim is missing or contradictory, or SSH is unhealthy, the installer retains the snapshot and stops; use the console to diagnose it before trying again.

An immediate rollback also validates the restored files and checks the SSH service before marking the snapshot complete. If the bad configuration never reached the running service, rollback does not restart it. If validation fails or SSH is not active, the rollback keeps the snapshot and leaves the timer armed for recovery.

Open sessions are not touched by any of this.

## What it refuses to do

- It never lets a secret appear on the screen, in the journal or in an argument of a command. The node secret lives in `/opt/remnanode/docker-compose.yml` (mode 600); a new administrator's password goes to `chpasswd` on its standard input.
- The `node` step keeps at most three mode-600 `docker-compose.yml.bak.TIMESTAMP` files. It replaces the installer's single-line `SECRET_KEY` with `"(removed)"`, sanitizes legacy copies and discards backups with an unrecognized secret layout. Restore the key from the panel before reusing a backup.
- The node API ACL expects Docker's IPv4 iptables backend and an unconditional `FORWARD` jump to `DOCKER-USER` before other rules. It replaces the installer's rules for the same port in one `iptables-restore` transaction, so an interruption does not create a gap between deletion and insertion. It leaves rules for other ports and unrelated rules alone. `verify` checks the original destination, rule order and allowed sources rather than a port substring; unsupported policies can fail verification even when a custom firewall is safe. The UFW check looks for explicit panel rules, not a proof of all custom UFW policy.

### Guarded node startup and same-port upgrades

- On a new host, `full` prepares the ACL before `node`. For a separate `node` step, run `apiacl` first with the intended `NODE_PORT` and `PANEL_ALLOW_IP`. Only `apiacl` rotates confirmed panel sources; `node` and standalone `firewall` reject a different set. During `full`, the previous sources remain in effect until `apiacl` verifies the requested rules. Order and duplicate entries do not change the set.
- If an ACL rotation fails validation or read-back, the confirmed files and UFW are not updated. After a kernel commit followed by a read-back failure, the installer attempts to restore the previous confirmed ACL and reports if restoration cannot be verified. If an error occurs **after** the ACL has been confirmed, rerun `apiacl` to reconcile the saved configuration, service and UFW.
- The installer uses Compose only to pull and create. Docker restart policy is `no`. The ACL unit follows Docker even if no node has been created or Docker is stopped and started in separate operations. `sw-node.service` orders itself after the ACL unit, but independently checks the saved port, exact IPv4 bindings and Docker backend, applies and verifies the ACL, then starts the inspected container by ID. The service retries after a container exit or failed start. A normal stop waits for that container to stop. Do not start the managed container with `docker start` or `docker compose up`.
- Upgrade an existing installer-managed node at the **same port**. Expect node downtime: the installer checks the saved port against the actual container, verifies its Compose ownership, bindings, network and state, disables its old restart policy and stops that container alone. `full` does this before package upgrades. It refuses an unknown container, a shared Compose project, unreadable Docker state or a port change before it changes port configuration, UFW or Compose. It does not adopt third-party nodes or move other containers.
- If preparation or startup fails after the old node has been stopped, it stays stopped until the fault is fixed. See `journalctl -u sw-node.service -u sw-node-api-acl.service`, then rerun the failed step with the same port. If preparation already succeeded, the service retries; `systemctl restart sw-node.service` also takes the guarded path. Do not restore a legacy Docker restart policy as a rollback.
- The installer does not access the Docker socket while `docker.service` is inactive, even if `docker.socket` is active. Only a fresh Docker install starts the daemon. Existing Compose paths, helpers, unit files and their parents must be root-owned and not writable by non-root users. The installer refuses links at managed paths, unknown unit definitions and systemd overrides; it does not take ownership of them.
- The ACL helper does not support standalone removal. Failed stops keep the container ID in `/run/sw-node/container` until Docker confirms that the selected container stopped. An absent record does not prove that no container is running.
- Supported: a stock local, rootful Linux Docker daemon, its default IPv4-only Compose bridge and iptables firewall backend. IPv6 publishing, Docker's native nftables backend, live-restore, direct routing and third-party launches are not supported. The guard is not continuous firewall monitoring. `verify` checks the enabled and active service, container ownership, state, restart policy, bindings and ACL. The built-in node baseline flags missing service/restart indicators; it is not proof of startup order.
- The firewall allows SSH first: every port sshd listens on (`sshd -T`) and the local port of every open SSH session (read with `ss`, so it also works under `sudo`, which drops `SSH_CONNECTION`) are kept open besides `SSH_PORT`. A rule that cannot be added, a `NODE_PORT` that is also an SSH port and a firewall that cannot be enabled stop the run.
- It never closes root login or password login unless the administrator and the key you name can log in (not merely a member of the `sudo` group: see the two SSH sections), says who counts and why the others do not before it changes anything, and arms an automatic rollback first.
- It never executes what it reads. An env file and the saved configuration are parsed line by line, an unknown name stops the run, a value with a line break or shell syntax is refused by its validator before it can reach a configuration file.
- Docker's and nginx.org's signing keys are fetched over HTTPS only, and their installer-managed APT keyrings contain only pinned primary keys and their subkeys. Unknown primary keys are omitted. Before using these sources, the installer repairs legacy keyrings and HTTP entries, then requires a successful APT index refresh. A failed download or partial refresh stops the installation instead of using cached indices.
- The node image has an explicit default tag. The installer rejects `latest*`, `nightly*`, and `main`, `master`, `dev`, or `edge` (including their `-`, `_`, or `.` variants), regardless of case. Tags are not digest pins. `NODE_PORT` cannot be `80`, `443` or `8444`, which the web front end uses.
- Docker can be installed only from its pinned APT source; `DOCKER_SOURCE=script` is refused. The installer does not export the node key or administrator password to child commands. Failed nginx or HAProxy configuration validation restores the previous configuration before any service restart.
- It never rewrites a file with the same content, and keeps the old version of a changed one as `file.bak.TIMESTAMP`.
- It never runs twice at once (`flock`).

## Journal and exit codes

Everything is journaled to `/var/log/swellwright-node-installer.log` (mode 600): the commands (never their secrets), their output and, for `verify` and `preflight`, one line per check: `CHECK ok|warn|fail | label | detail`. A program that drives the installer should read those lines and the exit code: `0` success, `1` the run stopped on an error, `2` the checks of `verify` or `preflight` found a failure (warnings are not failures). The screen is for people: colour on a terminal, `NO_COLOR=1` and `SW_ASCII=1` switch it down, `SW_VERBOSE=1` shows the output of apt and Docker.

## Tests

```sh
sh artifacts/node-installer/test/run-tests.sh            # all
sh artifacts/node-installer/test/run-tests.sh nginx      # the tests whose name contains "nginx"
```

Runs on Linux and in Git Bash (slowly there), under dash when it is installed (`SW_TEST_SHELL` picks another shell), and refuses to run as root. Each test builds a fake root and runs the installer with stubbed system commands, then checks its files, command order and errors without touching a real host. The root execution path ignores test overrides. `validators.tsv` records when a shell validator applies restrictions beyond the published pattern. CI also runs `sh -n`, `dash -n`, ShellCheck and a real HAProxy on the generated configuration.

What the tests cannot show: how apt, systemd, UFW, Docker and iptables behave on a real server, and Debian at all. The first run of a new version belongs on a disposable server, one step at a time (`preflight`, `verify` change nothing).

## Changing it

1. Edit `install.sh`. A step is a function `step_<id>`; every change to the system goes through `run_cmd`, `q`, `write_file`, `make_dir` or `apt_install`, and every path under `/etc`, `/opt`, `/var`, `/home` is written `$R/path` so the tests can redirect it.
2. A new step needs a `#@step` line, an entry in the action check of `main` and the `case` that runs it, and tests. A new parameter needs a `#@param` line, a validator in `param_valid` and `param_hint`, a row in `validators.tsv` and, if the script reads it from files, a place in `PARAM_NAMES`.
3. Raise `INSTALLER_VERSION` (a released version is never edited, and `pnpm run artifacts:check` fails when a recorded version gets other bytes), run `pnpm run artifacts:build` (it records the version in `releases.json`), run the tests, commit the script, `manifest.json`, `releases.json` and this README together.
4. Pinned values go stale on purpose: `DEFAULT_NODE_IMAGE_TAG`, `DEFAULT_HAPROXY_VERSION`, `DOCKER_KEY_FPRS`, `NGINX_KEY_FPRS`. Updating one is a new version.
