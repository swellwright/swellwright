# Roadmap

As of `phase-3-complete` (2026-11-22), phases 0–3 are implemented. Phase 4 is next; see [current status and follow-ups](project-status.md). The original estimates below are planning estimates, not remaining-time forecasts.

Rough estimates (plus or minus 50%) for a single full-time maintainer: **42 to 53 weeks** to 1.0. A usable deploy-and-rollback slice appears after phase 4.

| Phase | Weeks | Contents | Acceptance |
|---|---|---|---|
| 0. Preparation | 1-2 | repository, license, DCO, CI skeleton, ADRs, lab (real VMs for nodes plus a test panel) | empty skeleton builds, hygiene checks green, lab reachable |
| 1. Skeleton and plugin runtime | 4-5 | monorepo, API with OpenAPI pipeline, auth (password, TOTP), vault, audit chain, plugin runtime (manifest, permissions, declarative drivers, container sidecars), UI shell and theme, i18n | sealed vault unreadable; a sidecar plugin works under restrictions |
| 2. Inventory and SSH core | 3-4 | servers, host-key pinning, facts, detached steps, SFTP, ad-hoc commands, script library, artifacts | a dropped SSH session does not kill a step |
| 3. Panel integration | 3-4 | connection wizard, typed client, read-only browsers, snapshots and diff, convention linter, impact calculator, API console (read), baseline checks | dry run of a profile edit shows "restarts N nodes" |
| 4. Engine and first workflows | 4-6 | durable engine, policies, approvals, events, run UI; adopt, verify, deploy, redeploy, rollback; golden tests; fault injection | rollback restores the pre-run snapshot; killed worker resumes |
| 5. DNS, certificates, lifecycle | 3-4 | DNS plugins, certificate distribution plugins, rename with finalize, decommission, replace, change IP, profile moves | rename with a hop-profile reference and rollback on the lab |
| 6. Fleet operations | 4-5 | rolling image/OS/kernel updates, reboot cycles, drift repair, ACL rollout, firewall/SSH policies, key rotation, bulk framework, schedules, Telegram notifications, advisory feed | wave update stops on a failed gate and rolls back |
| 7. Remnawave power features | 5-7 | profile editor and linter, REALITY rotation, convention sync, templates and rules, hop chains, plugins and snippets, billing, optional users module, panel backups and upgrade planner, snapshots and GitOps export, console writes | hop chain created and removed by the wizard |
| 8. Probes and monitoring | 3-4 | probe agents, tests, availability matrix, alerts, incident log, recommendations | time-of-day matrix and a blocked-node alert |
| 9. Security hardening and terminal | 3-4 | web terminal, SSH CA, audit verifier, incident wizards, rotations, pen-test checklist, recovery drills | terminal unusable without step-up; recovery from a lost instance |
| 10. Release | 4-5 | MCP, webhooks, CLI polish, reports, localization, hosting drivers, optional ACME, multi-panel, English docs, demo mode, release pipeline | a clean clone runs from the README in 15 minutes |

Phase 8 can run in parallel with phases 5 to 7. The terminal (phase 9) starts only after the access policies of phase 6 exist.
