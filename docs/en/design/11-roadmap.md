# 11. Roadmap and phases

> English translation of the [Russian design document](../../ru/design/11-roadmap.md).

The estimates are approximate (±50%), for a single maintainer (as in `docs/en/roadmap.md`), counted in calendar weeks with regular work. The total is about **42-53 weeks** to version 1.0 (with the plugin system, container runtime for third-party plugins and release preparation); a working slice for deployment appears after phase 4 (around week 12-16).

Order principle: first the foundation and security, then **reading** (panel, servers), then **writing with rollback** (deployment), then scale (fleet, Remnawave, monitoring); the terminal and the riskiest parts come after security is tuned.

## Phase 0. Preparation, decisions and repository (1-2 weeks)
**Contents:** a git repository with a clean history and a public structure (`apps/`, `packages/`, `plugins/official/`, `docs/en|ru`, `deploy/`, `examples/`); AGPL-3.0-only license, SPDX headers, DCO, CONTRIBUTING, SECURITY and CODE_OF_CONDUCT templates; a CI skeleton on GitHub Actions (linters, types, tests, gitleaks, licenses, a check that no instance data is present); ADRs for the decisions made; a **test server** (a separate VPS for full cycles) and a lab panel in Docker.
**Acceptance:** the empty skeleton builds, CI is green, gitleaks is clean, the lab comes up, the test server is reachable over SSH, a 3.4.x panel accepts a test node manually.

## Phase 1. Skeleton and plugin runtime (4-5 weeks)
**Contents:** monorepo and a Docker development environment; NestJS API with an OpenAPI pipeline; authentication (password, TOTP, sessions, CSRF), roles; **vault**; audit with a hash chain; **plugin runtime**: manifest, discovery, enabling with permissions, schema-based settings, plugin storage, declarative UI contributions, declarative drivers, running `builtin/official` plugins in the worker process under restrictions, and **container sidecars for `community` plugins** (communication protocol, network policy, compose fragment generation, no `docker.sock`); `plugin-api` contracts; manual DNS and hosting mode and local login as part of the core; UI shell, theme, i18n (en, ru); health, ready, metrics; compose deployment.
**Acceptance:** login with TOTP; a secret is created and decrypted after unsealing, and a sealed vault cannot be read; a test sidecar plugin connects, shows its permissions, cannot reach the database and secrets, cannot call a disallowed host, and is disabled without restarting the core; a declarative driver works without executing code; the audit chain verifies.
**After the phase:** persistent settings (tokens, DNS) can be stored and changed safely.

## Phase 2. Inventory and SSH core (3-4 weeks)
**Contents:** servers and access, host key pinning, facts collection, SSH layer (pool, detached steps, journal reading, resume, sudo via stdin), SFTP, ad-hoc commands and a script library (audit and diagnostics), artifacts (node installer, `node-engine`), read-only access for snapshot and verification, servers UI.
**Acceptance:** a server is added, the fingerprint is shown, facts are collected; a command runs on 3 nodes with per-node output; an SSH drop does not kill the step and the output is read through to completion; artifact hashes are verified.
**After the phase:** running commands and collecting facts on fleet servers is available from the UI and the API.

## Phase 3. Panel integration (3-4 weeks)
**Contents:** panel connection wizard (tokens with scopes, the JWT is discarded), typed client and adapters, read access to all objects, snapshots and diff, **convention linter** and reconciliation of hosts with nodes, **impact calculator**, API console (read), baseline checks of a node over SSH (read-only; built, ADR 0045), dashboard v1, token expiry calculation.
**Acceptance:** the panel is connected, objects are visible, a dry run of a profile edit shows the impact "restarts N nodes", reconciliation finds `address` drift, snapshot and diff work, a token without permissions cannot write.
**After the phase:** checking the consistency of hosts and node addresses ("check only" mode) and a fleet audit are available.

## Phase 4. Engine and first workflows (4-6 weeks)
**Contents:** durable engine (checkpoints, resume, locks), approvals, policies P-001…P-016, events and WebSocket, run UI (timeline, live output, estimate, rollback), workflows **Adopt (N01), Verify (N12), Deploy (N03), Redeploy (N04), Rollback**, end-to-end golden scenario tests of behavior, fault injection, first runs in the lab following the checklist.
**Acceptance:** deploy in the lab succeeds, rollback gives equivalence with the snapshot, a killed worker is picked up, policies block a shared profile without approval; a repeat run changes nothing.
**After the phase (milestone M4):** real runs are executed from Swellwright.

## Phase 5. DNS, certificates, rename and lifecycle (3-4 weeks)
**Contents:** DNS plugins (`dns-rucenter` first: password-based OAuth, XML, commit/rollback, waiting on the authoritative NS; then `dns-cloudflare`, `dns-rfc2136`, a declarative driver), DNS steps and checks in the core, certificate distribution management (through certificate distribution plugins), **Rename (N05) and finalize**, **Decommission (N06)**, **Replace a blocked node (N07)**, **Change IP (N08)**, move between profiles (N09).
**Acceptance:** rename on a test server with a hop profile, rollback and finalize; node replacement with TTL lowering; decommission with no leftovers; the core without a DNS plugin works in manual mode.

## Phase 6. Fleet operations (4-5 weeks)
**Contents:** node image and Xray update (canary, waves, gates), OS and kernel updates, reboots one node at a time, baseline drift repair, API port ACL, UFW/fail2ban/SSH policies with a safety timer, SSH key rotation (and the SSH CA, if enabled), bulk operations skeleton, schedules and windows, notifications (**the `notify-telegram` plugin first**: alerts, summaries, approvals by buttons for low and medium risk; then webhook and email), advisory feed (USN, GitHub), node certificate management through `CertDistributor`.
**Acceptance:** a wave update of the image on 5 test nodes with a stop on a gate failure and a rollback; key rotation without losing access; a change to the list of addresses the nodes' API port is open to is rolled out to the nodes; an alert and an approval arrive in Telegram.

## Phase 7. Remnawave features (5-7 weeks)
**Contents:** profile editor (Monaco, inbound builder, `xray -test` sandbox), REALITY rotation, host convention sync, subscription templates and SRR rules (rollout, client matrix), **hop chains** (wizard, graph, check, service objects, "direct with fallback" mode, experimental), plugins and snippets, billing, users module (optional), panel backups and upgrade planner (through the panel host), snapshots and GitOps export, writes through the API console.
**Acceptance:** an entry → exit hop is created and removed by the wizard; key rotation on a lab node; template rollout with rollback; snapshots restore a single object.

## Phase 8. Probes and monitoring (3-4 weeks; can run in parallel with 6-7)
**Contents:** probe-agent (Linux and Windows), tests (TCP, TLS/SNI, VLESS through `xray` with a test user, 16-20 KB freeze, `mtr -T`), scheduler, matrix and daily charts, alerts and suppression, incident log, recommendations (with approval), SLO.
**Acceptance:** an agent on a separate machine sends results, the matrix shows periodic unavailability at certain hours of the day, an alert fires when a node is blocked in transit, a "replace the IP" recommendation appears with no automatic action.

## Phase 9. Security and terminal (3-4 weeks)
**Contents:** web terminal (xterm, recording, step-up, timeouts), SSH CA refinement, audit chain verification tool, incident wizards, secret rotations, pen-test checklist and fixes, recovery drills (loss of the vault, loss of the server), outbound connection policy.
**Acceptance:** the terminal is unavailable without step-up, the recording plays back, the "lost Swellwright" drill ends with access through the emergency key and a restore from backup.

## Phase 10. Completion, release and extensions (4-5 weeks)
**Contents:** MCP server, webhooks, `sw` CLI, reports, full localization, hoster API drivers, ACME module (as a plugin, optional), multi-panel support; **release preparation:** cleanup of the repository and its history, README and documentation in English (a Russian copy), demo mode (fake panel and nodes), release pipeline (GHCR, SBOM, cosign), SECURITY.md, plugin registry (`registry/index.json` in the repository), plugin author guide, public roadmap.
**Acceptance:** all catalog scenarios are covered by tests; a clean clone comes up from the README in 15 minutes; the repository contains no instance data (automatic check); OpenAPI and the documentation are complete.

## Milestones
| Milestone | End of phase | What works |
|---|---|---|
| M1 | 1 | login, vault, audit, UI |
| M2 | 2 | inventory, SSH, commands, terminal stub |
| M3 | 3 | the panel is visible, drift and impact |
| **M4** | **4** | **deploy and rollback from Swellwright** |
| M5 | 5 | DNS, rename, replace, decommission |
| M6 | 6 | the fleet under management: updates, drift, access, schedules |
| M7 | 7 | hops, profiles, templates, GitOps, backups |
| M8 | 8 | probes from different networks |
| M9 | 9 | terminal, drills, pen test |
| **1.0** | 10 | full scope |

## Parallelism
Phase 8 does not depend on phases 5-7 and can run in parallel with them (it needs only the inventory and the panel). Phase 9 (terminal) starts only after phase 6 (the SSH CA and the access policies are ready).
