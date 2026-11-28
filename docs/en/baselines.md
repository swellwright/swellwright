# Baselines: what a healthy server looks like

A **baseline** is a document that lists what you expect to find on a healthy server, and Swellwright checks your servers against it over SSH. A check reads a server with one read-only script and changes nothing on it. The decisions behind it are in [ADR 0045](../adr/0045-baseline-checks.md); this page is for the person who writes baselines.

Your rules are **data**. Two baselines ship with Swellwright and are kept current by name: `linux-generic` (updates, time, resources, SSH, accounts, the firewall) and `node-selfsteal` (those, and what the [node installer](../../artifacts/node-installer/README.md) sets up). They cannot be edited; open one in **Fleet > Baseline > Baselines**, choose **Copy**, and change the copy. A fleet of your own is a copy with your values: [`examples/baselines`](../../examples/baselines).

## The format

```yaml
schema: 1                       # the only version there is
description: One sentence.      # optional
checks:
  - id: ssh.root-login          # unique; lower case, digits, dots, dashes, underscores
    title: Root cannot log in with a password
    category: ssh               # system updates time resources network firewall ssh accounts services docker node tls web installer
    severity: medium            # high: a miss is a fail. medium and low: a miss is a warn
    observe:
      kind: sshd.effective      # what to look at: a kind of the catalogue
      field: permitrootlogin    # which of the values that kind reports
      params: { }               # the parameters the kind takes, if any
    expect:
      in: [no, prohibit-password, forced-commands-only]
    remediationHint: Set PermitRootLogin no.   # what to do about it (optional)
```

`observe.kind` and `field` come from the catalogue. Every kind reports a few named values (a text, a number, a boolean or a list of texts); a check compares **one** of them. Several checks may use the same kind: it is observed once per run.

### The comparators

`expect` has exactly one of:

| Comparator | The value |
|---|---|
| `equals: X` / `notEquals: X` | is exactly X / is not X |
| `in: [X, Y]` | is one of these (for a list: every entry is one of these, so an empty list passes) |
| `matches: 'regex'` | the text matches (JavaScript syntax, at most 200 characters, no back reference, and bounded: see below) |
| `atLeast: N` / `atMost: N` | the number |
| `contains: X` / `notContains: X` | the list has this entry (for a text: contains it) |
| `absent: true` / `present: true` | is empty (nothing, an empty text or list) / is not. A field the server could not look at (`emptyPassword` without root) is neither: the check is `error` |
| `versionAtLeast: '3.4.6'` | the version, compared by its numbers part by part (`6.8.0-36-generic` is at least `6.8`) |
| `ageLessThan: 7d` | a number of seconds is below `30m`, `12h` or `7d` |

A pattern runs in the API process, so one that could make the engine backtrack for long is refused: a repetition of a part that has choices of its own (`(a|b)*` where the branches can begin alike, `(a+)+`, `(a?)*`), or several open-ended repetitions that can take the same characters as what follows them (`.*.*x`, `.*a.*b`). A repetition that the next character decides is fine: `^\d+\.\d+$`, `PermitRootLogin\s+no`, `--ctorigdstport 62050 .*-j DROP`. The pattern of a version saved before this rule is checked again when it runs, and a refused one makes the check `error`. Whatever the check says, a pattern also runs under a deadline of 50 ms: a match that takes longer is stopped and the check is `error`. All the patterns of one run share 300 ms, and a pattern that was stopped once is not run again; the checks past that are `error` as well.

Lookbehind is not supported. If the text passed to `matches` exceeds 1,000 characters, the check reports `error` without matching a truncated prefix. A denied or failed observation (for example, reading listener processes without root or querying an unavailable firewall tool) is also `error`, not evidence that the resource is absent.

The editor checks the whole document as you type and underlines what is wrong: an unknown kind or field, a parameter the kind does not take, a comparator that does not fit the type of the field (`atMost` on a list).

### What a result can be

| Status | Meaning |
|---|---|
| `pass` | as expected |
| `warn`, `fail` | not as expected; `fail` for a `high` check, `warn` for the others. A thing that is not there at all (a container that does not exist, a tool that is not installed) is a miss too |
| `error` | it could not be observed: the tool failed, it needs root and the login has none, it timed out. An unknown is never a pass |
| `skipped` | not applicable (the script on the server does not know this kind) |

A run whose server cannot be reached (no pinned host key, a changed host key, a login refused, an expired secret, a sealed vault) is `error` with the reason and has no results.

## The catalogue

The reference is in the console (the **Baselines** drawer lists every kind with its parameters and fields) and in the API (`GET /baseline-catalogue`). In short:

- **System:** `os.release`, `kernel` (running and newest installed kernel, reboot pending), `uptime`, `time.sync` (service, synchronised, offset, and the skew against the clock of Swellwright), `sysctl.value`, `users.login`, `sudoers`, `ssh.keys` (fingerprints only), `dns.self`.
- **Updates and resources:** `updates.pending` (from the package lists already on the disk), `updates.auto`, `disk.usage`, `memory`, `systemd.failed`, `service.state`.
- **Network and firewall:** `port.listener`, `ports.public`, `ufw.status`, `iptables.chain`, `fail2ban.status`, `sshd.effective`, `http.local` (a status code from loopback or the machine's own address).
- **Docker and the node:** `docker.engine`, `docker.container` (state, image tag, restart policy, health, the **names** of its environment variables, never the values), `nginx.config`, `haproxy.config`, `cert.file`, `certsync.account`, `installer.journal`, `file.stat`, `file.hash` (a SHA-256, never the content).

Parameters are checked against a pattern in the catalogue (a path starts with `/` and has plain characters only; a port is 1 to 65535; a unit is a full unit name such as `fail2ban.service`). A kind that needs root (`needsRoot` in the catalogue) says `denied` when the login can neither be root nor use `sudo`; the run then records `collectedAs: user` so you can see why.

## Versions, assignment and runs

- Every saved text is a **new version**; an older one can be shown and never changed. Saving needs a fresh authenticator code. If somebody saved a newer version first, your save is refused (409) and you start from theirs.
- **Assignment:** a baseline applies to servers named in it and to servers that carry a tag named in it. A baseline named for a server wins over a tag; a tag belongs to one baseline.
- **Running:** from the Baseline page (one server, or every server that has a baseline), or `POST /servers/{id}/baseline-runs` and `POST /baseline-runs`. Starting a check needs `servers:exec` and a fresh code. At most `SW_CHECKS_PARALLELISM` servers are checked at once and a server has one check at a time.
- **Schedule:** set `SW_CHECKS_INTERVAL_HOURS` (0 is off). The vault must be open; a server whose access has no secret that is still valid is left alone.
- **Drift:** every run says how many checks changed since the previous one and whether it got better or worse; `GET /baseline-runs/{id}/diff` lists them. A number that moves while its check passes (the use of a disk) is not drift.
- **Retention:** the newest `SW_CHECKS_KEEP_RUNS` runs of each server are kept.

## What a check can see

The script reads files and runs the usual read-only tools: `ss`, `ufw status`, `iptables -S`, `sshd -T`, `docker inspect`, `nginx -t`, `haproxy -c`, `openssl x509`, `systemctl`, `df`, `stat`. It never prints a secret: not a private key, not a password hash, not the value of an environment variable (only whether it is set), not the content of a file (only its hash). Its text is stored with every run by its SHA-256, so the history says which script made which result, and you can read it: `apps/api/src/baseline/observe.sh`.
