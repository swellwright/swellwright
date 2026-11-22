# Node installer

`install.sh` installs and hardens a [Remnawave](https://github.com/remnawave) node on Debian or Ubuntu. It is the [artifact](../README.md) that Swellwright ships to a server, and it is a plain POSIX `sh` script you can also read and run yourself. The decisions behind it are in [ADR 0036](../../docs/adr/0036-node-installer-artifact.md).

```
Internet -> HAProxy (SNI routing, public IP:443)
              |- the node's domain ----> remnanode container (Xray on 127.0.0.1:443)
              |                             \-> nginx "SelfSNI" site (unix socket, PROXY protocol)
              \- any other SNI, or none -> nginx default site (404) on 127.0.0.1:8444
```

A foreign or missing SNI is answered with an ordinary 404, not a dropped connection. The node API port is open to the panel and nobody else, in UFW and in Docker's `DOCKER-USER` chain (Docker publishes ports around UFW). Certificates are delivered to `/opt/certs` by whatever you use (a restricted `rrsync` key is prepared for it); until the real one arrives a temporary self-signed one keeps nginx up.

## Requirements

- Debian 12, Ubuntu 22.04 or 24.04, `root`, an IPv4 address on the server, internet access to the package repositories, `download.docker.com` and `nginx.org` (and the HAProxy PPA on Ubuntu). The steps are derived from an installer that has run on Ubuntu servers in production; this script itself is verified by tests with stubbed commands (every step) and, since 1.0.1, by every step (twice each, and `full` on the finished node) on a reset Ubuntu 24.04 server. Debian is supported by the code and covered by stubs only.
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

`ssh` is not part of `full`: it needs an administrator and keys. Run it when you are ready, in two phases if you want to test the new login between them (`SSH_PHASE=user`, then `SSH_PHASE=root`).

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
| `node` | Remnawave node container | yes | yes | NODE_PORT, **SECRET_KEY**, NODE_IMAGE_TAG |
| `verify` | Verify the node | no (read-only) | yes | NODE_DOMAIN, NODE_IP, NODE_PORT, NODE_IMAGE_TAG |
| `ssh` | SSH: administrator account, keys, root login | yes | no | SSH_PHASE, **NEW_USER**, **NEW_USER_PUBKEY**, NEW_USER_PUBKEY2, NEW_USER_PASSWORD, SSH_DISABLE_ROOT, SSH_DISABLE_PASSWORD |
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
| `NODE_PORT` | no | `62050` | `62050` | no | TCP port of the node API (panel to node). |
| `SECRET_KEY` | yes | - | - | yes | Node secret key from the panel (the SECRET_KEY of the compose file the panel shows for the node). 16 to 8192 characters of letters, digits and + / = _ . : -. Kept only in the compose file, mode 600. |
| `PANEL_ALLOW_IP` | yes | - | `192.0.2.20 198.51.100.7` | no | IPv4 addresses (space separated) that may reach the node API port: the panel. Nobody else can. |
| `SSH_PORT` | no | `22` | `22` | no | SSH port that the firewall keeps open. Default: the port sshd reports, else 22. |
| `CERTSYNC_PUBKEY` | yes | - | `ssh-ed25519 AAAA... sender@example` | no | Public key of whatever delivers certificates to /opt/certs. Installed for the user certsync, limited to rrsync in that directory (command=, restrict). Empty: the receiver is not set up and full skips it. |
| `NODE_IMAGE_TAG` | no | `3.4.6` | `3.4.6` | no | Tag of the remnawave/node image, pinned in the compose file. |
| `FAIL2BAN_IGNORE_EXTRA` | no | - | `192.0.2.0/24 198.51.100.7` | no | Extra IPv4 addresses or CIDR ranges (prefix 8 to 32, space separated) that fail2ban never bans, for example the Swellwright server. |
| `BASE_UPGRADE` | no | `yes` | `yes`, `no` | no | Run apt upgrade in the base step. |
| `DOCKER_SOURCE` | no | `apt` | `apt`, `script` | no | apt: Docker's apt repository with its signing key checked against a pinned fingerprint. script: the get.docker.com convenience script. |
| `HAPROXY_SOURCE` | no | `auto` | `auto`, `ppa`, `distro` | no | auto: the PPA on Ubuntu, the distribution package on Debian. ppa: the vbernat PPA of HAPROXY_VERSION. distro: the distribution package. |
| `HAPROXY_VERSION` | no | `3.2` | `3.2` | no | HAProxy series for the PPA (major.minor). |
| `SSH_PHASE` | no | `all` | `user`, `root`, `all` | no | user: create the administrator and its keys. root: close root login (needs an administrator). all: both. |
| `NEW_USER` | yes | - | `admin` | no | Administrator account with sudo (not required for SSH_PHASE=root). Not root and not certsync. |
| `NEW_USER_PUBKEY` | yes | - | `ssh-ed25519 AAAA... admin@example` | no | Public SSH key of the administrator (not required for SSH_PHASE=root). |
| `NEW_USER_PUBKEY2` | no | - | `ssh-ed25519 AAAA... backup@example` | no | Optional second (backup) public SSH key of the administrator. |
| `NEW_USER_PASSWORD` | no | - | - | yes | Password of a newly created administrator (sudo needs it). Required without a terminal. Only through the environment or an env file, never logged. |
| `SSH_DISABLE_ROOT` | no | `yes` | `yes`, `no` | no | Close root login over SSH (only when an administrator exists). |
| `SSH_DISABLE_PASSWORD` | no | `no` | `yes`, `no` | no | Close password login over SSH (only when an administrator has a key). Check the key login in another window first. |
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

## What it refuses to do

- It never lets a secret appear on the screen, in the journal or in an argument of a command. The node secret lives in `/opt/remnanode/docker-compose.yml` (mode 600); a new administrator's password goes to `chpasswd` on its standard input.
- It never opens the node API port to anyone but `PANEL_ALLOW_IP`, and it removes an older rule that opened it to everybody. The firewall allows SSH first; the port of the session that runs the installer is kept open too, and a firewall that cannot be enabled stops the run.
- It never closes root login unless the `sudo` group has a member, never closes password login unless a member has a key, and reverts a change that `sshd -t` refuses. Open sessions are not touched.
- It never executes what it reads. An env file and the saved configuration are parsed line by line, an unknown name stops the run, a value with a line break or shell syntax is refused by its validator before it can reach a configuration file.
- It never trusts a downloaded signing key by its name: Docker's and nginx.org's keys are accepted only with a pinned fingerprint.
- It never installs `latest`: the node image tag is a parameter with a pinned default.
- It never rewrites a file with the same content, and keeps the old version of a changed one as `file.bak.TIMESTAMP`.
- It never runs twice at once (`flock`).

## Journal and exit codes

Everything is journaled to `/var/log/swellwright-node-installer.log` (mode 600): the commands (never their secrets), their output and, for `verify` and `preflight`, one line per check: `CHECK ok|warn|fail | label | detail`. A program that drives the installer should read those lines and the exit code: `0` success, `1` the run stopped on an error, `2` the checks of `verify` or `preflight` found a failure (warnings are not failures). The screen is for people: colour on a terminal, `NO_COLOR=1` and `SW_ASCII=1` switch it down, `SW_VERBOSE=1` shows the output of apt and Docker.

## Tests

```sh
sh artifacts/node-installer/test/run-tests.sh            # all
sh artifacts/node-installer/test/run-tests.sh nginx      # the tests whose name contains "nginx"
```

Runs on Linux and in Git Bash (slowly there), under dash when it is installed (`SW_TEST_SHELL` picks another shell), and refuses to run as root. Each test builds a fake root in a temporary directory, puts stubs of `apt-get`, `ufw`, `systemctl`, `docker`, `sshd`, `useradd`, `iptables`, `curl`, `gpg` and the rest first in `PATH` (the installer sees only them and the basic tools), runs a step and asserts the files it wrote, the calls it made and their order, the modes it asked for and that no secret leaked. `validators.tsv` lists accepted and refused values per parameter; each row runs through the shell validator and through the pattern published in the manifest, and the two must agree. CI also runs `sh -n`, `dash -n`, shellcheck and a real HAProxy on the generated configuration.

What the tests cannot show: how apt, systemd, UFW, Docker and iptables behave on a real server, and Debian at all. The first run of a new version belongs on a disposable server, one step at a time (`preflight`, `verify` change nothing).

## Changing it

1. Edit `install.sh`. A step is a function `step_<id>`; every change to the system goes through `run_cmd`, `q`, `write_file`, `make_dir` or `apt_install`, and every path under `/etc`, `/opt`, `/var`, `/home` is written `$R/path` so the tests can redirect it.
2. A new step needs a `#@step` line, an entry in the action check of `main` and the `case` that runs it, and tests. A new parameter needs a `#@param` line, a validator in `param_valid` and `param_hint`, a row in `validators.tsv` and, if the script reads it from files, a place in `PARAM_NAMES`.
3. Raise `INSTALLER_VERSION` (a released version is never edited), run `pnpm run artifacts:build`, run the tests, commit the script, `manifest.json` and this README together.
4. Pinned values go stale on purpose: `DEFAULT_NODE_IMAGE_TAG`, `DEFAULT_HAPROXY_VERSION`, `DOCKER_KEY_FPRS`, `NGINX_KEY_FPRS`. Updating one is a new version.
