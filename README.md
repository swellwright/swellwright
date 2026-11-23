<div align="center">

<img src="assets/banner.svg" alt="Swellwright: deploy and operate Remnawave fleets. Plan, approve, apply, verify, roll back." width="100%">

<br>

[![Status](https://img.shields.io/badge/status-pre--alpha-f59e0b?style=flat-square)](docs/en/roadmap.md)
[![CI](https://img.shields.io/github/actions/workflow/status/swellwright/swellwright/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/swellwright/swellwright/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0--only-3bc9db?style=flat-square)](LICENSE)
[![Remnawave](https://img.shields.io/badge/Remnawave-3.4.x-3bc9db?style=flat-square)](https://docs.rw)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-6ba539?style=flat-square&logo=openapiinitiative&logoColor=white)](docs/en/api.md)
[![Stack](https://img.shields.io/badge/NestJS%20%C2%B7%20React%20%C2%B7%20PostgreSQL-stack%20of%20the%20panel-3178c6?style=flat-square&logo=typescript&logoColor=white)](docs/en/architecture.md)
[![Docker](https://img.shields.io/badge/Docker-first-2496ed?style=flat-square&logo=docker&logoColor=white)](deploy/compose/docker-compose.yml)
[![DCO](https://img.shields.io/badge/DCO-signed--off-3bc9db?style=flat-square)](CONTRIBUTING.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-22c55e?style=flat-square)](CONTRIBUTING.md)
[![Stars](https://img.shields.io/github/stars/swellwright/swellwright?style=flat-square&logo=github&color=eab308)](https://github.com/swellwright/swellwright/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/swellwright/swellwright?style=flat-square&color=64748b)](https://github.com/swellwright/swellwright/commits/main)

<a href="docs/en/index.md"><img src="https://img.shields.io/badge/Documentation-read%20%E2%86%92-0969da?style=for-the-badge" alt="Documentation" height="34"></a>
<a href="docs/en/roadmap.md"><img src="https://img.shields.io/badge/Roadmap-phases-0e7490?style=for-the-badge" alt="Roadmap" height="34"></a>
<a href="docs/en/plugins.md"><img src="https://img.shields.io/badge/Plugins-extend-7c3aed?style=for-the-badge" alt="Plugins" height="34"></a>
<a href="docs/en/security.md"><img src="https://img.shields.io/badge/Security-model-b45309?style=for-the-badge" alt="Security" height="34"></a>
<a href="README.ru.md"><img src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-README-475569?style=for-the-badge" alt="Русский" height="34"></a>

</div>

<br>

> [!WARNING]
> **Pre-alpha, phases 1–3 implemented.** The console, security foundation, inventory/SSH and read-only panel integration are implemented. The general workflow engine and full deploy/rollback flows are still planned. See [current status](docs/en/project-status.md) and [development setup](docs/en/development.md); interfaces may change before the first release.

> [!NOTE]
> Swellwright is an independent community project. It is **not affiliated with or endorsed by Remnawave**.

## Why

Running a [Remnawave](https://docs.rw) fleet means repeating the same careful, risky procedures by hand: building a node, reinstalling one, renaming it (host, nginx, HAProxy, DNS, panel objects), rotating keys, updating images, checking drift, rolling back a change that went wrong.

Swellwright turns each of them into a **plan, approve, apply, verify, roll back** workflow, with a journal, live progress and a complete undo, from one web console and one OpenAPI.

<p align="center">
  <img src="assets/flow.svg" alt="Every change goes through five stages: plan, approve, apply, verify and roll back." width="100%"><br>
  <img src="assets/overview.svg" alt="Swellwright orchestrates the Remnawave panel, servers and nodes over SSH, DNS providers, certificates, hosting APIs, notifications and probes." width="100%">
</p>

## Highlights

<table>
<tr>
<td width="50%" valign="top">

### 🧭 Plan before touching anything
Every workflow starts with a read-only dry run: what changes, what restarts (for example "this edit restarts N nodes"), what the undo looks like. Approvals are bound to a hash of the plan.

</td>
<td width="50%" valign="top">

### ♻️ Durable runs, full undo
Run state lives in PostgreSQL. Steps on a node are detached processes that survive SSH drops; a killed worker is resumed by another one. Every change records how to reverse it.

</td>
</tr>
<tr>
<td valign="top">

### 🔌 Deep Remnawave integration
A typed client for every panel operation, a convention linter, an impact calculator, config snapshots and diff, a hop-chain builder, subscription template and rule rollouts, scoped token management.

</td>
<td valign="top">

### 🔐 Vault and honest SSH
Envelope encryption, sealed on start. SSH by password, key or certificate, your choice per server. The web terminal never injects stored secrets: **you type the real credentials for each session**.

</td>
</tr>
<tr>
<td valign="top">

### 🧩 Plugins for everything specific
DNS and hosting providers, certificate distribution, notification channels, login providers, node flavors and client compatibility packs. Declarative drivers need no code; community plugins run as isolated container sidecars.

</td>
<td valign="top">

### 📡 Probes and monitoring
Probe agents on machines in other networks, time-of-day availability matrices, alerts and an incident log. Recommendations are advisory and never applied automatically.

</td>
</tr>
</table>

<details>
<summary><b>Scenario families (87 scenarios)</b></summary>

- **Servers and nodes:** adopt, add, deploy, redeploy, rename with finalize, decommission, replace a blocked node, change IP, move between profiles, update image or Xray, OS and kernel updates, reboot cycles, hardening baseline and drift repair, API-port ACL, firewall and fail2ban, SSH access and key rotation, certificates, decoy site and proxy configs, ad-hoc commands, files, web terminal, incident playbooks.
- **Remnawave objects:** panel connection and tokens, config profiles (editor, linter, impact calculator), REALITY key rotation, hosts and convention linter, squads, subscription templates and rules, hop chains (including multi-hop), plugins and snippets, infrastructure billing, panel backups and restore tests, snapshots and GitOps export, audit, API console.
- **DNS:** provider drivers, record lifecycle with propagation checks on authoritative servers, TTL strategy, naming convention engine.
- **Security:** vault, login (password, TOTP, passkeys, OIDC), roles and tokens, optional SSH certificate authority, tamper-evident audit, output redaction, supply-chain controls, incident wizards.
- **Monitoring:** TCP, TLS with SNI, VLESS through a test user, data-freeze test, mtr; time-of-day matrix; alerts and incident log.
- **Platform:** CLI, OpenAPI SDKs, MCP server, signed webhooks, import and export, schedules and maintenance windows, reports, i18n, self-backup, plugin system.

</details>

## Design principles

1. **Read-only by default.** Every change goes plan → approve → apply → verify → roll back.
2. **Reversible or explicitly irreversible,** with an undo record and a pre-change snapshot.
3. **The fleet is autonomous.** Nodes keep working without Swellwright; a break-glass path always exists.
4. **Universal core, specific plugins.** Anything tied to one provider, vendor or naming scheme is a plugin or an example.
5. **Secrets stay secret.** Vault, redaction everywhere, nothing printed, nothing logged.
6. **Facts and hypotheses are labelled** (measured, community-reported, assumption).

The full list is in the [overview](docs/en/index.md#principles).

## Stack

The same stack as the Remnawave panel, so the UI feels familiar and contributors can work on both:

| Layer | Choice |
|---|---|
| Backend | NestJS, TypeScript, Zod, BullMQ on Valkey |
| Data | PostgreSQL with Prisma |
| SSH | `ssh2` (pooling, detached steps, sudo, PTY, SFTP, certificates) |
| Frontend | React, Vite, Mantine, TanStack Query, xterm.js |
| API | OpenAPI 3.1 generated from Zod, Scalar docs, generated SDK and CLI |
| Packaging | Docker and Compose, monorepo with pnpm and Turborepo |

Details: [architecture](docs/en/architecture.md).

## Documentation

| | |
|---|---|
| [Overview](docs/en/index.md) | goals, non-goals, principles, scenario families |
| [Architecture](docs/en/architecture.md) | components, execution model, SSH layer, topologies |
| [Remnawave integration](docs/en/remnawave-integration.md) | tokens and scopes, impact rules, conventions |
| [Plugins](docs/en/plugins.md) | extension points, manifest, trust levels |
| [Security](docs/en/security.md) | threat model, vault, access methods, terminal, audit |
| [API](docs/en/api.md) | OpenAPI conventions, resource groups, events |
| [Roadmap](docs/en/roadmap.md) | phases and acceptance criteria |
| [Design documents](docs/en/design/00-index.md) | the complete design: data model, scenario catalog, engine, testing, risks |
| [Decisions](docs/adr/) | architecture decision records |
| [Русская документация](docs/ru/README.md) | full design set in Russian |

## Repository layout

```text
apps/              api, worker, web, cli, probe-agent
packages/          contracts, engine, steps, remnawave client, ssh, vault, policy, plugin-api, ui, testing
plugins/official/  DNS, login, notification, hosting, node-flavor and client-pack plugins
examples/          conventions, policies, templates, hop-chain presets, declarative drivers
registry/          community plugin registry index
deploy/            compose and reverse-proxy examples
artifacts/         files shipped to servers and verified by hash: the node installer (script, manifest, tests)
scripts/           repository hygiene checks, the artifact manifest tool
assets/            logo, favicon and banners
docs/              en (canonical), ru, adr
```

## Contributing and security

- Contributions are welcome under the [Developer Certificate of Origin](DCO): sign off your commits with `git commit -s`. Start with [CONTRIBUTING.md](CONTRIBUTING.md).
- Questions and ideas: see [SUPPORT.md](.github/SUPPORT.md).
- Report vulnerabilities privately, see [SECURITY.md](SECURITY.md). Never put real credentials, IP addresses or domains of a real deployment in issues, pull requests or tests.

## License

[AGPL-3.0-only](LICENSE). If you run a modified version as a network service you must offer its source to your users.
