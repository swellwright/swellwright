# Swellwright: overview

Swellwright is a self-hosted service for deploying and operating Remnawave fleets. It is **in the design phase**; these documents describe what will be built.

## Goals

- Cover every operational scenario of a fleet (87 scenarios) without manual gaps, each as a workflow with plan, approval, verification and rollback.
- Integrate fully with Remnawave (3.4.x and later): all panel operations through a typed client, plus higher-level scenarios and checks the panel does not provide.
- Keep an interface that looks and behaves like the Remnawave panel (same stack, same conventions).
- Treat OpenAPI as a first-class artifact: documentation, SDK, CLI and contract tests are generated from it.
- Store secrets and recurring settings in an encrypted vault, so an operator only enters what actually changes.
- Be universal: the core knows nothing about a specific DNS provider, hosting company, operator or naming scheme. Everything specific is a plugin or an example.

## Non-goals

- Replacing the panel, or acting as a billing system for end users.
- A hosted multi-tenant SaaS.
- A VPN client or a store of user traffic.
- Requiring an agent on nodes (agentless over SSH by default; an agent is optional and later).

## Principles

1. Read-only by default. Every change goes plan, approve, apply, verify, roll back.
2. Every change is reversible, or explicitly marked irreversible, with an undo record and a pre-change snapshot.
3. Steps are idempotent; running again is safe.
4. Durable execution: run state lives in the database; steps on a node run as detached processes and survive SSH drops.
5. Least privilege and minimal exposure of secrets; never print or log a secret value.
6. The fleet is autonomous: nodes keep working without Swellwright; a break-glass path always exists.
7. Observability by default: stages, timings, estimates, event stream and logs.
8. Versions are pinned and updates are deliberate; third-party code is reviewed.
9. Facts and hypotheses are labelled (measured, community-reported, assumption).
10. Changes to nodes go through versioned artifacts (installer and node engine).
11. Treat node output as untrusted: sanitized, never executed, never rendered as HTML.
12. The panel is the source of truth for panel objects; Swellwright keeps snapshots, intents and a journal.
13. A universal core and plugins: anything infrastructure-specific can be removed without touching the core.

## Scenario families

- **Servers and nodes:** adopt, add, deploy, redeploy, rename (with finalize), decommission, replace a blocked node, change IP, move between profiles, update image or Xray, OS and kernel updates, reboot cycles, hardening baseline and drift repair, API-port ACL, firewall and fail2ban, SSH access and key rotation, certificates, decoy site and proxy configs, system tuning, power, backups, health timeline, bulk operations, ad-hoc commands, files, web terminal, incident playbooks.
- **Remnawave objects:** panel connection and tokens, config profiles (editor, linter, impact calculator), REALITY key rotation, hosts and convention linter, squads, subscription templates and rules, subscription pages, users (optional), hop chains (including multi-hop), plugins and snippets, infrastructure billing, panel settings and tokens, version and upgrade planning, panel backups and restore tests, snapshots and GitOps export, statistics and reports, audit, API console.
- **DNS:** provider drivers, record lifecycle with propagation checks on authoritative servers, TTL strategy, naming convention engine.
- **Security:** vault, login (password, TOTP, passkeys, OIDC), roles and tokens, optional SSH certificate authority, tamper-evident audit, output redaction, supply-chain controls, vulnerability feeds, incident wizards.
- **Monitoring:** probe agents on machines in different networks (TCP, TLS with SNI, VLESS through a test user, data-freeze test, mtr), time-of-day availability matrix, alerts, incident log, recommendations (never automatic).
- **Platform:** CLI, OpenAPI SDKs, MCP server, signed webhooks, import and export, schedules and maintenance windows, reports, i18n, self-backup, plugin system.

## Documents

| Document | Contents |
|---|---|
| [architecture.md](architecture.md) | components, stack, execution model, SSH layer, topologies |
| [remnawave-integration.md](remnawave-integration.md) | panel tokens and scopes, impact rules, conventions |
| [conventions.md](conventions.md) | writing a convention pack: the format, every rule, the pattern language, what reconciliation and the impact calculator mean |
| [plugins.md](plugins.md) | extension points, manifest, trust levels, official plugins |
| [security.md](security.md) | threat model, vault, access methods, terminal, audit |
| [api.md](api.md) | OpenAPI conventions, resource groups, events |
| [roadmap.md](roadmap.md) | phases and acceptance criteria |

The complete design (data model, scenario catalog, engine, testing, risks) is in [`design/`](design/00-index.md); annotated screens are in [`design/wireframes/`](design/wireframes/README.md). The documents were written in Russian first and are kept in sync with the originals in [`../ru/design/`](../ru/design/00-index.md).
