# 03. Scenario catalog (complete)

> English translation of the [Russian design document](../../ru/design/03-scenarios.md).

Each scenario is a "workflow" of the engine (`08-engine.md`) with the cycle **plan, approval, apply, verify, rollback**. For each one: what it does, safeguards, rollback. Locks are placed on resources: node, server, DNS zone, panel profile, panel server. Risk levels: L low, M medium, H high (approval and a maintenance window are required).

Rollback notation: **full** (return to the state before the run, except the listed exceptions), **partial** (some steps are irreversible, listed), **none** (read-only).

## A. Servers and nodes (N)

### N01 Adopting an existing node (risk L, read-only)
Connect over SSH, collect facts, take a baseline snapshot of the "as is" state, compare with the baseline (the check set of the node flavor and the extension), produce a drift report, link the node to the panel node and to the DNS and cert-sync records, assess risk. Changes nothing. Result: the node is in the inventory with the status "adopted"; the differences and the plan to fix them are visible.

### N02 Adding a server to the inventory (L)
Enter the IP, provider and credentials (root password of the new server, key, certificate), check reachability, show the host key fingerprint with explicit confirmation, detect OS, architecture, resources and `python3`. Import from the panel ("nodes without a server"). Rollback: delete the record.

### N03 Deploying a new node (H)
Parameters: country and number (next free), domain by convention, IP, provider and billing, traffic limit and reset day, reference profile, **inbound placement mode** (a new dedicated profile, adding to a shared profile with a warning about the restart of all nodes of that profile, a clone of the reference), squads, reference hosts, hardening profile, maintenance window, DNS mode (manual / via driver), login policy (root, administrator, Swellwright SSH certificate).
Stages: `connect` (SSH, fingerprint, OS), `dns` (A record), `snapshot` (server snapshot before changes), `preflight` (resources, internet, ports, time), `install` (installation steps; their set is defined by the node flavor, node-flavor; the self-steal scheme is the steps of the `node-installer` artifact in the order of its `full` action: `base`, `system`, `hostname`, `firewall`, `fail2ban`, `docker`, `apiacl`, `certsync`, `nginx`, `haproxy`, `node`, `verify`, each with its parameters in `manifest.json`, ADR 0036; steps that risk losing access, for example the firewall, run with a safety timer), `reboot` (if needed), `certsync_panel`, `panel` (profile and inbound, REALITY keys from the panel, node, two hosts, squads, billing, node metadata), `online`, `verify` (the baseline check set, defined by the node flavor), `access` (install Swellwright access: key/certificate, administrator, check of login and sudo), `ssh` (ban root login, etc., only after verification), `cleanup`, `notify`.
General requirements for steps and safeguards against typical failures: idempotency, waiting for the package manager lock, retries when fetching external artifacts, detailed logs, steps run as a separate process on the node; check of tag and name uniqueness; the administrator login is verified before root is banned (SSH is not hardened until a verified fallback access exists); a snapshot before the first change; a repeated run is idempotent.
Rollback: **full**, except package updates, kernel, reboot and logs (panel by records, DNS by records, server by snapshot, cert-sync record).

### N04 Redeploy (H)
An existing node on a new or reinstalled server. The profile and REALITY keys are kept, a new SECRET_KEY is taken (`GET /api/keygen`; the assumption "any key works" is verified in the lab), host addresses and DNS are updated when the IP changes, the old key is removed from the cert-sync `known_hosts`, and the node is restarted through the panel if needed. Variants: same IP (OS reinstall), new IP, new provider (provider and billing are updated). Rollback: **full** by records (host addresses, DNS, cert-sync, server).

### N05 Renaming a node (M)
New code (`XX-04`), domain, mode "safe" (the old name stays as a fallback: nginx `server_name`, HAProxy SNI, inbound `serverNames`) or "fast". What changes: hostname, `/etc/hosts`, nginx, HAProxy, the installer's saved parameters; the cert-sync record (from the old name to the new one); DNS (a new A record; the old one after confirmation); in the panel: node name, address (if a domain), country code, inbound `serverNames`, profile name (if it belongs to this node only), remark, `sni` and `address` of hosts, metadata, billing record. Test hosts (marked by convention, for example 🧪) are not touched. References to the old name are searched for in all profiles, templates, hosts of other nodes, rules and hops; what is found in hop profiles is offered for replacement, the rest is shown as a list.
Stage 2, **"finalize"**: remove the fallback name on the server and in `serverNames`, delete the old A record; it runs manually or on a schedule after verifying that clients have updated their subscriptions (by `subscription-request-history`).
Safeguards: DNS check on authoritative servers, a warning about the Xray restart on all nodes of a shared profile, the option to choose "profile clone for the node" in advance, a check against the new SNI after the changes. Rollback: **full**.

### N06 Decommissioning a node (H)
Drain the load (`isDisabled` on hosts, removal from squads, wait for users to disconnect), check that no references remain (hops, templates), disable the node, delete the node, hosts and inbound (or the profile), delete DNS, cert-sync and billing records, archive the server, optionally revoke access and "wipe" the server (erase secrets and stop services), return the server to the provider (via API, if available). Rollback: **full** before the node is deleted; "partial" after deletion (panel objects are restored from the snapshot).

### N07 Replacing a blocked node (H)
A scenario for cases such as a node blocked in transit: deploy on a new IP or server (N03 or N04), lower the TTL in advance, dual mode (the old node stays until verification), switch hosts, verify from probes, decommission the old node (N06). Optionally enable a hop as a fallback path (P10).

### N08 Changing the IP of a server (M)
A new IP on the same server: DNS, hosts, API port ACL if needed, fail2ban rules, update of the HAProxy `bind`, cert-sync, probes; the scenario enforces the order "add first, then remove".

### N09 Moving between profiles, splitting and merging (H)
Cloning a shared profile "for a node" (as for the entry node of a chain), moving an inbound, merging back; impact calculation for restarts; the old state is recorded for rollback. Built in Phase 3 (ADR 0044): the impact calculation is a dry run (`POST /panel/impact`) that says which nodes restart, stop or start and why (each rule marked observed, documented or assumed), which hosts and subscriptions change, what the linter would find afterwards, a risk level and, for a shared profile, the safer way (clone it for the node); it changes nothing.

### N10 Updating the node image and Xray (H)
Strategies: canary (one node), then waves; checks after each: node online, Xray uptime, users online, configured thresholds; stop on failure and roll back to the previous tag. Version source: node and Xray releases on GitHub, with the tag pinned in compose and in the artifact. "Urgent" security releases are taken into account. Rollback: **full** (the previous image stays on disk until the end of the window).

### N11 OS and kernel updates, reboots (H)
Policies: list of affected packages, CVE labels (`S09`), windows, canary, `reboot-required`, waiting for the node to return, verification (BBR, `fq`, time, services, Xray), parallelism 1: one node is rebooted at a time, with protection against loss of access. Rollback: the kernel is not rolled back (the old one stays in the bootloader).

### N12 Hardening baseline: check, drift, repair (L/M)
The baseline and extension check set (service, ports, UFW, DOCKER-USER, fail2ban, sshd, sysctl, certificate, key permissions, SNI_VERIFICATION, decoy site, etc.). Comparison with the baseline; for each difference a **fixing step from the installer** (idempotent) is proposed and a diff is shown. Schedule: "check" daily, "fix" on demand with approval. Results are stored, trends are visible.

**Built in Phase 3 (ADR 0045): the check half, read-only.** A baseline is a versioned document of checks over a closed catalogue of 31 read-only observations (`docs/en/baselines.md`); two ship with Swellwright (`linux-generic`, `node-selfsteal`) and yours are copies with your values. One script, one SSH session per server; results with the value seen, what was expected and a hint; the drift against the previous run; the fleet view; a schedule (`SW_CHECKS_INTERVAL_HOURS`, off by default). The fixing step and the approval are phase 4: a hint names the installer step to run.

### N13 Node API port (ACL): changing the allow list (H)
Bulk change of the list of addresses to which the node API port is open (allow list, the sources allowed to reach the API port; DOCKER-USER, UFW), for example when the panel's external address changes: canary, a check that the panel sees the node, rollback. Several addresses are supported (primary and spare).

### N14 UFW, fail2ban, SSH ports (M/H)
Adding and removing allowed addresses, `ignoreip`, changing the SSH port through dual mode (two ports, verification, removing the old one), password and root policy; everything with a safety timer on the node (auto-revert) and verification of the new login.

### N15 Access: keys, passwords, certificate authority, emergency access (H)
Rotation of administrator SSH keys (add, verify, remove), rotation of the sudo password, issuing SSH certificates (`TrustedUserCAKeys`), revocation, a list of keys per node, a check that "a fallback login exists" before hardening, a check whether fail2ban has banned Swellwright itself.

### N16 Node certificates: check and distribution (M)
**Core:** the certificate state on each node (issuer, expiry, key permissions, self-signed or not), expiry dates and alerts, the scenarios "register a node to receive the certificate", "sync now", "forget the old host key on redeploy".
**Distribution** is performed by a plugin (`CertDistributor`): `certs-rsync` (distribution via rsync), `certs-push-ssh`, and `certs-cron-script`, an adapter to an external certificate sync script (the command, node list and user are set in the settings). Certificate issuance: `CertIssuer` (`acme-*` plugins; an external source of issued certificates is described by the plugin settings).
Safeguards: a state check before and after, restoring the scheme record on rollback, key permission control (640), a warning for a self-signed certificate. Rollback: **full** by records.

### N17 SelfSNI, decoy site, nginx, HAProxy (M)
Versioned config templates (SelfSNI, default site, HAProxy), the content of decoy pages (including pages unique per node; a possible future extension), applying with validation (`nginx -t`, `haproxy -c`), a soft reload and rollback. A baseline `curl` check set run from the outside.

### N18 Docker and containers (L/M)
Docker log rotation, limits, image cleanup, compose drift, check of `SNI_VERIFICATION=true`, pinned tag.

### N19 System settings (L/M)
sysctl (BBR, `fq`, MTU probing, etc.), journald, NTP with fallback servers, modules, limits.

### N20 Restarts and power (M)
Restart of the node container, of Xray through the panel, of services (nginx, HAProxy, fail2ban), server reboot, power control through the hosting provider API.

### N21 OS reinstall via the hosting provider API and automatic redeploy (H)
For providers with an API: reinstall the image, obtain the root password, then N04. For the others: a "manual step" (the administrator reinstalls the OS at the hosting provider and enters the IP, root and password).

### N22 Node configuration backups and restore (M)
A regular encrypted snapshot of `/etc` (selected parts), the node installation directory and the certificate directory (paths are set in the settings), and package lists; restore on a new server (part of N04). Storage outside Swellwright is selectable.

### N23 Node health dashboard and timeline (L)
Online, Xray uptime, users, traffic, load, disk, memory, kernel, versions, certificate expiry, last check and drift, deployment events, probes; filters and alerts.

### N24 Bulk operations (framework)
Selecting nodes by tags and conditions, strategies (sequential, canary, batches of N, maximum failures, pause on failure, windows), a pre-calculation (which nodes, how much time, impact), approval, a single progress view across all nodes, retry for the failed ones.

### N25 Ad-hoc commands and scripts (M/H)
A script library (audit, diagnostics), parameters, danger level, permissions; run on selected nodes, output per node, `sudo` by policy, approval for dangerous ones. **Built in Phase 2 (ADR 0038):** thirteen built-in read-only diagnostics and scripts of the instance with typed parameters and a danger level; a script or an inline command runs on one to fifty selected servers, each as a target of its own with its state, exit status and output (kept up to a limit, read by offset, live while it runs); stored access and the pinned host key, `sudo` through the stored sudo secret, a time limit, cancel, and a history of runs that keeps the exact text that ran. It needs `servers:exec` and a fresh authenticator code; a run that is not `read` has to be confirmed (the approvals of the engine come in phase 4).

### N26 Files (M)
Browsing, upload and download over SFTP, distributing a file to selected nodes with a checksum, permissions, rollback (a backup copy of the replaced file).

### N27 Web SSH terminal (H)
Tabs, step-up authentication per session, recording and playback, idle timeout, banner, a list of active sessions, forced close, a separate permission, a command log (where possible), broadcast input is off by default (`05`).

### N28 Emergency scenarios (H)
**Node compromise**: isolation (close ports, disable hosts), rotation of REALITY keys and shortIds, SECRET_KEY and SSH keys, rebuilding the node. **Leak of a panel, DNS or vault token**: revocation, issuing new ones, rewriting secrets, an audit of usage. Step-by-step wizards with checks.

## B. Remnawave panel (P)

### P01 Connecting a panel (M)
Wizard: URL, admin sign-in (login/password, OAuth2 or passkey), **creating tokens with scopes** (`POST /api/tokens`, catalog `GET /api/tokens/scopes`), saving them to the vault, **discarding the admin JWT**, version compatibility check (`/api/system/metadata`), list of capabilities, token lifetimes and rotation reminders. Several panels.

### P02 Config profiles (H)
List, view, version diff (Monaco), clone, inbound editing through a builder (REALITY: `serverNames`, `target`, `xver`, `shortIds`, `privateKey` from `GET /api/system/tools/x25519/generate`), presets for sniffing (`routeOnly: true`, without `fakedns`), DNS (DoH) and routing (SMTP block, etc.), a **config linter** (a sandbox with `xray -test` in a container), an **impact calculator** (which nodes restart, for how many seconds), applying with a snapshot and rollback, tag uniqueness. Warnings for shared profiles.

### P03 Rotating REALITY keys and shortIds (H)
In stages: generation, profile update, check of subscriptions and clients, rollback. Separately for each node when profiles are cloned.

### P04 Hosts (M)
CRUD, clone, batch operations (disable, enable, delete, update), sorting; a **conventions engine** (defaults, configurable): remark from a pattern, `address` = IP, explicit `sni`, fingerprint policy (default `firefox`; the allowed set is configurable, the observed compatibility constraint is described in `04-remnawave-integration.md`), subscription types, `vlessRouteId` range (default outside 0x4000-0x4FFF), marking of test hosts (for example 🧪) and protecting them from bulk edits; **host and node reconciliation**: drift of address, SNI and inbound binding; fixing with a dump and rollback. Built in Phase 3 (ADR 0044): the conventions engine is a rule pack as data (30 rules, a pattern language that cannot take exponential time, versions, import and export; the owner's own scheme is a pack and not code) and reconciliation of hosts, nodes and the server inventory is check only, with DNS looked up under a timeout, a cap and a rate limit; the fix with a dump and rollback comes with the writes of the panel.

### P05 Squads (M)
Internal (inbound composition, impact: restart of the affected node), external (template, headers, subscription page), users in batches.

### P06 Subscription templates (H)
Versions and diff, a sandbox for checking a complete client config, rollout to external squads and hosts with a copy and rollback, standard templates (for example "selective routing" and "global mode") with split DNS, optional parameters for local client authentication taken from the vault; the client compatibility matrix (Happ and others) is filled in by the administrator.

### P07 Subscription settings and SRR rules (M)
`GET/PATCH /api/subscription-settings`: headers (`providerid`, `socks-auth-mode`, `http-auth-mode`), rule tester (`POST /api/system/testers/srr-matcher`), rollout.

### P08 Subscription pages (L/M)
`subscription-page-configs`: list, clone, order, binding.

### P09 Users (optional, L/M)
CRUD, batch actions (extend, reset traffic, update squads, disable), HWID devices, "sharing suspects", subscription request history, connections (reset, geocheck), test users for probes (created and auto-deleted), personal data masked by default.

### P10 Hop chains (H)
Wizard: entry (for example, an entry node) and exit (an exit node), hop profile (a VLESS+REALITY outbound to the exit, fingerprint, parameters from the exit inbound), `vlessRoute` (a free one is allocated; by default outside 0x4000-0x4FFF and not 0), hop hosts (by default two modes, for example "selective routing" and "global mode"), a service user and service squads (protected from deletion and disabling by default), an end-to-end check through a probe (the external IP of the exit), a default control (configurable): **do not enable Torrent Blocker** on the exit and in the chain without analysis (traffic source = IP of the previous node), removal of a chain without leftovers. Multi-hop chains (A, B, C). The topology is shown as a graph.
**"Direct path with hop fallback" mode** (experimental, depends on client support): Xray balancer and observatory, `injectHosts`, `fallbackTag`, a check of client support; the fallback option is "two hosts to choose from".

### P11 Plugins, snippets, node integrations (M)
Torrent Blocker (reports, statistics, cleanup), shared lists, plugins, executor, snippets, integrations: list, binding to nodes, warnings for chains.

### P12 Infrastructure billing (L/M)
Providers, per-node records, payment history; synchronization with the inventory (provider, due date, reminders), cost reports.

### P13 Nodes in the panel (M/H)
CRUD of nodes, tags, enable/disable, restart, traffic reset, order, batch profile changes (`bulk-actions/profile-modification`), node metadata (link to the Swellwright server); **dangerous** operations (`DELETE`, `restart-all`, bulk operations) require elevated approval.

### P14 Remnawave settings (H)
View and edit `remnawave-settings` (OAuth2, passkeys, Telegram, branding) with warnings; read-only by default.

### P15 Panel API tokens (H)
Scope catalog, creating tokens with the least privileges (for Swellwright, MCP, probes, reports), lifetime and reminders, revocation; an admin JWT is required (step-up authentication flow).

### P16 Panel versions and upgrade (H)
Compatibility, release sources (panel, node, Xray, subscription-page), security recommendations, an upgrade planner: backup, `docker compose pull`, migrations, verification, rollback from the backup; the order "panel, then nodes" with a compatibility check of `node` and `backend`.

### P17 Panel backups (M)
Schedule, encryption (CMS, key kept off the server), storage on the server and in external storage (S3, SFTP, rclone targets), retention period, a **monthly restore check** in a disposable Postgres, a restore wizard (protection against accidental launch), a list of secrets to keep when reinstalling.

### P18 Panel configuration snapshots (GitOps) (M)
A daily export of all objects (profiles, hosts, squads, templates, settings, plugins, billing) with secret masking or encryption, diff and "who changed what and when" (from the Swellwright audit log), restoring a single object, export to YAML (optionally to Git).

### P19 Statistics and reports (L)
Traffic by node and squad, usage, recap and digest, Prometheus, summaries.

### P20 Panel audit (L)
Automatic checks: versions, port 62050 open only to the panel, `SNI_VERIFICATION`, kernel and CVEs, BBR, log limits, SSH policies, convention drift; a report in Markdown format and in the UI.

### P21 API console (M/H)
A typed explorer of all 218 operations (the Remnawave 3.4.x OpenAPI specification) with schema prefill, history and a "dry run" (validation of the body against the contract); writes require approval; dangerous operations (`DELETE`, bulk) are flagged. **Built in Phase 3 (ADR 0046), the read half:** the catalogue, typed parameters, the masked answer and the history; writes and the dry run are phase 7.

## C. DNS (D)
- **D01 Drivers:** RU-CENTER (NIC.RU) (OAuth password grant, XML exchange, commit/rollback, waiting on authoritative NS), Cloudflare, Route 53, Yandex Cloud DNS, Selectel, Reg.ru, Timeweb, RFC 2136 (nsupdate), "manual".
- **D02 Records:** desired and actual state, create, replace, delete, rollback, conflicts (CNAME, multiple A records), change history, visibility on each NS and at the recursive resolver, zone import.
- **D03 TTL strategy:** lowering before a migration, raising after it.
- **D04 Naming convention:** `{cc}{n}.{base}`, a pool of neutral domains for SNI (possible future extension), zone and wildcard checks.
- **D05 DNS switching (optional):** temporarily pointing a name at another IP when it is blocked; off by default.

## D. Security and access (S)
- **S01 Vault:** sealing, unsealing with a password, KEK and DEK rotation, emergency export, "who used a secret".
- **S02 Sign-in:** local users, TOTP, WebAuthn (passkey), OIDC (opt.), session policy, IP restrictions, step-up authentication for dangerous actions.
- **S03 Swellwright roles and tokens:** instance owner (`owner`), operator (`operator`), observer (`observer`), terminal (`terminal`), auditor (`auditor`); token scopes.
- **S04 SSH certificate authority:** issuing short-lived certificates, distributing `TrustedUserCAKeys`, revocation (`RevokedKeys`), an emergency key kept outside Swellwright.
- **S05 Audit:** an immutable log with a hash chain, export, search.
- **S06 Secret redaction in output** and scanning logs for leaks.
- **S07 Supply chain:** frozen dependencies, SBOM, image scanning, license checks, review of third-party code before it is connected.
- **S08 Compliance reports:** summary by nodes and panel, history.
- **S09 Vulnerability feeds:** Ubuntu USN, GitHub advisories (Remnawave, Xray, kernel), matching against node versions, urgent notifications and ready-made plans (for example a temporary mitigation for a kernel CVE).
- **S10 Incident wizards** (see N28).

## E. Monitoring and probes (O)
- **O01 Probe agents** on machines in other networks: TCP connect, TLS handshake with SNI, a request through VLESS (test user, `xray`), a freeze test (sending 16-20 KB), ICMP, `mtr -T`; "direct" and "through tunnel" modes; recording of the path (external IP).
- **O02 Schedules and matrix:** node by network operator by time of day; a chart of the daily availability pattern (periodic unavailability at certain hours of the day), comparison with the baseline, overlay of deployment events.
- **O03 Alerts:** rules (failure rate, node blocked in transit, mismatch between the panel's external address and the allow list of the node API port, certificate expiry, token expiry, drift), flapping suppression, maintenance windows, escalation.
- **O04 Node metrics:** polling over SSH (lightweight) and panel metrics (`/api/system/nodes/metrics`), optional Prometheus exporter.
- **O05 Notifications:** Telegram first (plugin `notify-telegram`: bot, allow list of chats, alerts, run summaries, pending approvals with "approve/reject" buttons for low and medium risk; high risk only in the UI), then webhook and e-mail; daily and weekly summaries, quiet hours.
- **O06 Recommendations** (with approval, not an automatic action): replace the IP, enable a hop, temporarily disable a host, move to another profile; labeled "measured / assumption".
- **O07 Incident log:** start, cause, actions, duration.
- **O08 SLO:** availability by node and network operator.

## F. Platform (X)
- **X01 `sw` CLI:** all runs and reads from the terminal.
- **X02 MCP server (opt.):** read first, writes only through approval.
- **X03 Outgoing webhooks:** run and alert events (HMAC signature).
- **X04 Import and export:** templates, conventions, baselines, schedules in YAML.
- **X05 Schedules** and maintenance windows.
- **X06 Reports** (HTML/Markdown/PDF): audit, fleet, cost, incidents.
- **X07 Localization:** ru and en.
- **X08 Swellwright backups** and self-recovery.
- **X09 Swellwright updates** (release check, migrations, rollback).
- **X10 Driver plugins** for hosting providers and DNS (pluggable).
- **X11 First-run wizard** (creating the instance owner, vault, panel, adopting the fleet).
- **X12 Help catalog** ("fact / hypothesis"), built-in reference documentation.
- **X13 Node agent (opt., later):** outbound connection, for servers without SSH.
- **X14 Multi-panel.**
- **X15 Test lab** as a built-in mode: run scenarios on lab VMs or containers before production nodes.
