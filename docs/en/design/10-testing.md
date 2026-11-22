# 10. Testing and quality

> This document describes the target test strategy. Current commands and actually available CI gates are in [development.md](../development.md); the existing TypeScript suites use `node:test`.

> English translation of the [Russian design document](../../ru/design/10-testing.md).

Without a clean lab there is nowhere to verify rollback and deployment: typical install failures (a locked package manager, an unreachable repository) show up only when running on a real server. The lab and fault injection are part of the plan, not a "later" item.

## 1. Test pyramid
| Level | What | Tools |
|---|---|---|
| Unit | pure functions, policies, the impact calculator, steps with fakes | Vitest |
| Contract | panel client against the frozen spec; Swellwright API against its own spec | `oasdiff`, Schemathesis, Prism |
| Integration | api, worker, queues, DB | Testcontainers (Postgres, Valkey) |
| Engine | workflows on a fake panel and fake SSH (end-to-end golden scenario tests of behavior) | own test bed |
| System (E2E) | workflows in the lab: a real panel in containers and real VM nodes | Docker Compose + VM |
| UI | forms, flows, visual regressions, accessibility | Playwright, axe |
| Security | authorization, secret leaks, XSS/CSRF/SSRF, output injection | own checks, ZAP, gitleaks |
| Load (small) | dozens of concurrent runs and logs | k6 |
| Upgrades | migrations forward and backward, backups | scenario tests |

## 2. Fakes and test beds
- **Fake panel:** a stateful server built from OpenAPI (in-memory model: nodes, hosts, profiles, squads), including the "restart all nodes of a shared profile" behavior, to test the impact calculator.
- **Real panel in the lab:** the `remnawave/backend` image, version 3.4.x, with Postgres and Valkey in Docker; real nodes connect (`remnawave/node` in VMs). A panel version matrix (the current and the previous minor).
- **Fake SSH server** on `ssh2` with scripted responses (for tests of drops, slow commands, exit codes) and **real containers/VMs** with Ubuntu 22.04 and 24.04 (systemd, apt, ufw, Docker inside the VM).
- **Fake DNS providers:** an HTTP server that imitates the RU-CENTER (NIC.RU) API, and UDP DNS for checking authoritative answers.

## 3. Lab
- Platform: Multipass, QEMU/KVM, Hyper-V or another virtualization platform (your choice), 4-6 VMs: 2x Ubuntu 24.04, 2x 22.04, 1 "panel host", 1 "Swellwright host"; VM snapshots for a fast reset.
- Network: isolated; a managed DNS (dnsmasq/CoreDNS) with its own zone; fake "external addresses".
- Lab scenarios: deploy, redeploy, rename, rollback, image updates, reboots, ACL changes, terminal.
- **Rollback equivalence:** after a rollback, the file manifest and the lists of packages, users and rules must match the snapshot taken before the run (exceptions are listed); the test compares them automatically.

## 4. Fault injection catalog
SSH drop in the middle of a step; server reboot in the middle of a run; worker kill (another worker picks the run up); package manager locked by another process (for example `unattended-upgrades`); repository or its key unavailable; slow DNS and resolver cache; 5xx responses and timeouts from the panel; expired panel and DNS tokens; empty or corrupted response; disk full; clock skew; SECRET_KEY mismatch; cert-sync failure; loss of access after a UFW change (check of the safety timer); concurrent runs on the same resource (locks); an object changed in the panel between read and write; SSH host key change; loss of connectivity between the worker and the DB; log overflow.

## 5. Acceptance criteria by scenario (Given/When/Then samples)
- **Deploy:** Given a clean Ubuntu 24.04 and a panel with a sample profile, When N03 runs, Then the node is online, hosts and squads are created, `verify` reports no errors, Swellwright access works, root is closed, and a repeat run changes nothing.
- **Deploy rollback:** Given a failed N03 at the `nginx` step, When rolled back, Then the panel is cleaned, DNS is restored, and the server matches the snapshot (except the listed exceptions).
- **Rename:** Given a node with two hosts and a hop profile with a reference, When N05 runs in safe mode, Then both names work, references are updated as chosen, `finalize` removes the old name, and rollback restores everything.
- **Resume:** Given a worker killed at step 7, When the run is picked up, Then the step is read through to completion from the journal on the node and the run continues without duplication.
- **Policies:** Given an edit of a shared profile bound to several nodes, When planned, Then the list of nodes and the time are shown and approval is required.
- **Secrets:** Given a run with any outcome, Then there are no secret values in logs, events, API responses and backups (automated search).

## 6. Quality gates (CI or a local script)
`tsc --noEmit` (strict), ESLint, formatting, unit and contract tests (coverage of the engine and policies at least 85%), Spectral and `oasdiff`, gitleaks, `pnpm audit`, SBOM, license check, bundle size, axe; a release is not published unless all of them pass.

## 7. Test data
Anonymized exports of a real panel (domains, IPs and keys replaced), generators of synthetic fleets of different sizes, scripted probe profiles.

## 8. Definition of done (DoD) for a feature
Code, tests (including negative and failure cases), updated OpenAPI and SDK, documentation and examples, an entry in the scenario catalog, policy and permissions described, metrics and audit wired in, a lab check with the "verified in the lab" label where applicable.

## 9. Checklist for the first lab runs
Read first (adoption, audit), then a test DNS name (create and roll back), then redeploy and rename of a test node, then nodes with traffic outside peak hours if the administrator decides so; after each step, compare the state and the journal.

## 10. Lab on a real server (recommendations)
- **Server role:** a separate real VPS for the full cycles N03, N04, N05, N06, N07, N11 with real `apt`, `ufw`, Docker and reboots; the OS is reinstalled between cycles (in the hoster's panel or through the provider API).
- **Panel:** a separate test panel with objects tagged `sw-lab`: node `XX-99`, a test profile, a test squad, hosts marked 🧪. This is guarded by policy **P-016 "lab mode"**: a run may change only objects tagged `sw-lab`, everything else is blocked; bulk operations and operations on shared profiles are forbidden in this mode. A panel snapshot is taken automatically before every run.
- **Server access:** the administrator enters the IP, root and password at the time of the check (they never go into the repository or the configuration); before risky checks, have access to the hoster's console.
- **What to check there:** the full cycle "deploy, rollback, repeat"; package manager lock (starting `unattended-upgrades`); an SSH drop with an `iptables` rule; a reboot in the middle of a run; the safety timer when access is lost after UFW; rename and finalize; slow DNS; sidecar plugins.
- **Limitation:** this server is not available to public CI (secrets); public checks use fakes and containers (sections 2-3).
