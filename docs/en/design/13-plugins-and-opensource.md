# 13. Plugins and the open project (universal core)

> English translation of the [Russian design document](../../ru/design/13-plugins-and-opensource.md).

The project is published on GitHub for everyone. The core is universal; everything that belongs to a specific infrastructure (RU-CENTER, naming conventions, a particular node scheme) is a **pluggable component**, like the login options in Remnawave (OAuth2, passkey, Telegram). License: AGPL-3.0-only.

## 1. Principles
1. **The core knows about Remnawave and SSH, but does not know about a specific DNS provider, hoster, carrier, naming scheme or a custom node scheme.**
2. **Anything individual can be removed without changing the core:** disable a plugin or package and the core keeps working.
3. **Configuration instead of code:** domains, IPs, names, tokens, passwords, keys and node lists live in instance data (the Swellwright database), not in the repository; the code is public and parameterized.
4. **Safe defaults are the same for everyone;** additional policies are optional.
5. **The project's own first providers are built as plugins** (RU-CENTER, Cloudflare, etc.): this tests the extension interface in practice from day one.
6. **Universality without losing features:** the "selfsteal" node scheme (HAProxy SNI → Xray → nginx SelfSNI, decoy, registration in certificate distribution) ships as an official "node package" for everyone who needs it.

## 2. Core and plugins

| Area | Core | Plugin or package |
|---|---|---|
| Vault, audit, roles, login | local users, password, TOTP, WebAuthn | `auth-oidc`, `auth-telegram` (external login providers) |
| Inventory, SSH (password, key, certificate), terminal, files | yes | certificate authority drivers, external key stores |
| Workflow engine, policies, approvals, schedules | yes | workflow packs |
| Remnawave panel client (all objects, scopes, tokens) | yes (version adapter) | other panels in the future (adapters) |
| "Standard" node: Docker, remnanode, UFW, fail2ban, sysctl, SSH policies, verification | yes | |
| "Selfsteal" node (HAProxy, nginx SelfSNI, decoy, registration in certificate distribution) | | official node package `node-selfsteal` |
| DNS | interface, manual mode | `dns-rucenter`, `dns-cloudflare`, `dns-route53`, `dns-rfc2136`, declarative drivers |
| Hosters | manual mode | `hosting-hetzner` and others via API |
| Notifications | internal events | `notify-telegram`, `notify-email`, `notify-webhook` |
| Probes | agent and schedule framework | test types (`probe-vless-xray`, `probe-freeze`, `probe-mtr`) |
| Baselines, conventions | formats and check engine | "basic" baseline, convention pack (remark template, route ranges) |
| Reports | generator | report templates |
| Secrets outside the database | built-in vault | `secret-hashicorp-vault`, `secret-file` |
| UI | shell, core pages | plugin contributions (settings pages, widgets) from a declarative description |
| Node certificates | node certificate check (issuer, expiry, key permissions), expiry dates and alerts, registration and sync scenarios | distribution: `certs-rsync`, `certs-push-ssh`; issuance: `acme-*`; adapter for the external sync script `certs-cron-script` |
| Subscription clients (Happ and others) | mechanics of templates, SRR, subscription pages | client compatibility packs: `client-happ` (headers, checks), others on request |

## 2a. How we decide: core or plugin (everything is public)
- **Core** if every Remnawave administrator needs it or it is a common OS security mechanism (inventory, SSH, vault, engine, panel client, node API port open only to the panel, fail2ban, sysctl, certificate checks, hop chains as a capability).
- **Official plugin** if it is a specific service, protocol or ready-made scheme (DNS providers, notifications, the `node-selfsteal` node package, certificate distribution, the Happ client, adapters for external sync scripts).
- **Example** (`examples/`) if it is a set of conventions and templates that everyone tailors to their own needs (naming conventions, subscription templates, hop presets, policy sets).
- **Instance data** (not code, not published): domains, IPs, node names, tokens, passwords, keys, node lists, results. Entered into Swellwright and stored in its database.

Edge cases:

| What | Decision | Why |
|---|---|---|
| **cert-sync** (external certificate sync script) | **plugin**: the core knows the `CertDistributor` interface; the generic scheme `certs-rsync`; an adapter for the external certificate sync script `certs-cron-script` (command, node list and user are set in settings) | delivering a certificate to nodes is a universal task, and the method is set by settings |
| Wildcard issuance (an external issuance tool, DNS-01 through a DNS plugin, for example RU-CENTER) | the universal `CertIssuer` interface, `acme-*` plugins, `dns-rucenter` | the external source is described by plugin settings |
| HAProxy SNI → Xray → nginx SelfSNI scheme, decoy | `node-selfsteal` plugin | depends on the chosen masking |
| Node API port open only to the panel (DOCKER-USER, UFW) | core ("standard" node) | every Remnawave node needs it |
| Happ headers (`providerid`, `socks-auth-mode`, ...) | `client-happ` plugin | depends on the client |
| Hops | core (mechanics); the route number, the service user and the chain preset are instance data | the capability is universal |
| Node on the same host as the panel | supported by a policy, example in `examples/policies` (parameters in settings) | depends on the installation topology |
| Naming conventions (`🇳🇱 🎯 XX-01 ...`) | example `examples/conventions` | everyone tailors them to their own needs |
| Subscription templates (selective routing and "global mode") | examples in `examples/templates/` without credentials and real domains | useful to others |

## 3. Extension points (contracts in `packages/plugin-api`)
```ts
interface DnsProvider {
  id: string; configSchema: ZodSchema; secretKinds: string[];
  listZones(ctx): Promise<Zone[]>;
  listRecords(ctx, zone): Promise<DnsRecord[]>;
  plan(ctx, intent: DnsIntent): Promise<DnsPlan>;           // read only
  apply(ctx, plan: DnsPlan): Promise<DnsChange>;            // write, with commit if needed
  undo(ctx, change: DnsChange): Promise<void>;
  authoritativeServers?(ctx, zone): Promise<string[]>;      // for visibility checks
}
interface NodeFlavor {                      // "how a node is built and verified"
  id: string; params: ZodSchema; supportedOs: string[];
  artifacts: Artifact[];                    // sh, python, config templates, hashes
  steps(ctx): StepDef[];                    // installation
  checks(ctx): CheckDef[];                  // baseline node checks
  rename?(ctx): StepDef[];                  // rename
  facts?(ctx): FactCollector[];             // what to collect
}
```
```ts
interface CertDistributor {                 // how a certificate reaches nodes
  id: string; configSchema: ZodSchema;
  registerNode(ctx, node): Promise<UndoRecord[]>;      // add a node to the distribution scheme
  unregisterNode(ctx, node): Promise<UndoRecord[]>;
  syncNow(ctx, nodes: Node[]): Promise<SyncResult[]>;
  forgetHostKey?(ctx, node): Promise<void>;             // on redeploy
  status(ctx, node): Promise<CertStatus>;
}
```
Other extension points: `CertDistributor`, `CertIssuer` (ACME), `ClientProfile` (client compatibility packs), `AuthProvider`, `HostingProvider`, `NotificationChannel`, `SecretBackend`, `AccessMethod`, `BaselinePack`, `ConventionPack`, `WorkflowPack`, `ProbeTest`, `ReportTemplate`, `PanelAdapter`, `UiContribution`. For REST services (DNS, hosting, notifications) **declarative drivers** are allowed (YAML: authentication, requests, response mapping), so that providers can be added without executing third-party code.

## 4. Plugin manifest (`swellwright.plugin.json`)
```json
{
  "id": "dns-rucenter", "version": "1.0.0", "name": "RU-CENTER (NIC.RU) DNS",
  "engines": { "swellwright": ">=1.0 <2" },
  "provides": [{ "kind": "DnsProvider", "entry": "./dist/provider.js" }],
  "permissions": {
    "network": ["api.nic.ru:443"],
    "secrets": ["dns-oauth"],
    "panel": [], "ssh": false
  },
  "config": { "schema": "./config.schema.json" },
  "ui": { "settings": "./ui/settings.json" },
  "storage": { "namespace": "dns-rucenter" },
  "license": "AGPL-3.0-only", "signature": "..."
}
```
- **Permissions are requested explicitly** and shown when the plugin is enabled ("the plugin wants to access `api.nic.ru` and read secrets of type `dns-oauth`").
- **Plugin storage:** an isolated namespace (key-value and JSON tables), with no database migrations of its own and no access to the core schema.
- **Settings:** the schema from the manifest builds the form in the UI; secrets are saved in the vault, not in the plugin settings.
- **Compatibility:** a core version range; incompatible plugins are not loaded and are shown in the UI with the reason.
- **Rules the schema enforces** (`packages/plugin-api`, ADR 0021): unknown keys are refused; paths are relative and stay inside the plugin; network permissions are public `host:port` names (no wildcard, address or local name); a declarative driver only for REST kinds; the storage namespace equals the id; the directory is named after the id; a `package.json` may not have install scripts; links are not followed. Discovery only describes plugins (`available`, `incompatible`, `invalid` with every reason) and never loads or runs one.

## 5. Lifecycle
Discovery (the `plugins/` directory mounted into the container, npm packages `@swellwright/plugin-*` and `swellwright-plugin-*`, local directories) → listing in the UI ("Settings → Plugins") → enabling after approving the permissions → configuration → use → update (no automatic download from the network; permission diff first) → disable → removal (plugin data optional). Plugin events go to the audit log.

**Built in Phase 1 (ADR 0027):** enabling. The approval is of content: a SHA-256 over every file of the plugin (links inside are refused), shown to the administrator and sent back with the request, so only files that were seen can be approved. The approval, its permissions and who gave it are kept; a plugin that is gone, unusable or has other files is switched off on the next read and at start, with a record, and enabling it again is a new approval that shows what changed. `plugins:read` and `plugins:manage` (step-up) gate the routes; Settings → Plugins is the page. Directories: `SW_PLUGINS_OFFICIAL_DIR`, `SW_PLUGINS_LOCAL_DIR`. 

**Built in Phase 1 (ADR 0028):** the host. Each approved plugin runs on first use in a process of its own under the Node permission model, loads the modules its manifest names and answers method calls over an IPC channel. A module is `export default definePlugin({ methods: { name(params, context) { ... } } })` (from `@swellwright/plugin-api`); `context.fetch(url, init)` is the only way out and reaches only the approved `host:port` pairs, over https, at public addresses, through the core (at most 1 MiB out and 4 MiB back, no redirects). Limits: a heap limit (`SW_PLUGIN_MEMORY_MIB`), a deadline per call (`SW_PLUGIN_CALL_TIMEOUT_SECONDS`), an idle stop (`SW_PLUGIN_IDLE_MINUTES`), a pause after repeated failures. `POST /plugins/{id}/check` loads a plugin and lists what it offers; the Plugins page shows the runtime. Declarative plugins have no process. Secrets are provided (below); panel and SSH are approvable but not provided yet.

**Built in Phase 1 (ADR 0031):** sidecar containers, the way plugins by others run code. The manifest names the sidecar and describes the container (`image` pinned by digest, `port`, memory, cpus); trust `community` (`SW_PLUGINS_COMMUNITY_DIR`) may be a sidecar or a driver, never code in the Swellwright process. Swellwright never starts a container: `GET /plugins/{id}/sidecar` returns a compose fragment (an `internal` network with no way out, read-only, no capabilities or privileges, not root, memory/cpu/process limits, nothing published) that the administrator applies. The core and the container prove themselves with a token derived from the plugin id and the digest of its files; the container reaches the network, a secret and its storage only through `POST /plugins/{id}/gateway`, which answers 401 to anything but the token of the plugin as approved, enabled and unchanged. The protocol is two HTTP calls (`/describe`, `/call`); `examples/sidecar-node` is a reference.

**Hardened after the 2026-11 review ([ADR 0050](../../adr/0050-plugin-boundaries-and-vault-key-generations.md)):** the approval digest includes `.git` if present, but manifest entries must be in the working tree. A plugin may contain neither symbolic links nor multiply linked files. The core checks the type and size of files before reading. It validates IPC messages and serves at most 8 plugin requests at once and 256 per call. A malformed message ends only the plugin process. Runtime status shows no plugin output or startup exception text. Disabling or reapproving a plugin ends the old process. Declarative operations have deadlines and bounded evaluation; IPv6 address checks account for translation and tunnelling prefixes. The sidecar gateway verifies the token before discovering plugins, and each generated sidecar has a separate internal network. For key rotation and recovery see [Security](05-security.md).

**Built in Phase 1 (ADR 0030):** declarative drivers. `provides[].driver` is a YAML file the core reads and interprets: operations with declared parameters, up to eight steps of `https` requests (a later step may read an earlier one) and a result shape, with values taken only from `params`, `config`, `secret` (requests only), earlier `steps` and the variable of an `each`; values placed in a URL are encoded; every request goes through the same gateway and the stored approval as a plugin's code. A driver is checked when the plugin is found: the hosts it calls must be in `permissions.network`, the settings and secrets it reads must be declared. The first official plugin, `plugins/official/notify-telegram`, is one.

**Built in Phase 1 (ADRs 0029 and 0031):** validated settings, bound vault secrets, per-plugin storage, and container sidecars. The Node process is not a sandbox for hostile code. Sidecars use an authenticated HTTP gateway; approve the plugin before exporting a fragment, and export it again after reapproval.

## 6. Plugin security
A plugin is third-party code with access to secrets, therefore:
- **Trust levels:** `official`, `community`, and `local` come from the configured discovery roots. A local code plugin is the administrator's responsibility.
- **Isolation:** a plugin runs in a separate worker process with restrictions (the Node permission model where available: restrictions on the file system, child processes and network); network access only through a core proxy limited to the list from the manifest; a plugin does not see the database, Redis, or any secrets and keys that are not its own, receives a secret only for the duration of a call and only of the declared type; limits on CPU, memory and call time.
- **Container plugins.** Community plugins may be sidecars (OCI image and manifest) or declarative drivers. A sidecar uses an authenticated HTTP gateway on an internal network and has no direct database access. The core has no `docker.sock`: the administrator applies the generated Compose fragment. Official and local code can run in restricted child processes; do not rely on Node permissions for hostile code.
- **Implemented:** install scripts including `postinstall` are prohibited, SHA-256 binds approvals to plugin files, sidecar images are pinned by digest, and updates require manual approval. Lifecycle events, refusals and secret use are audited; secret values are not.
- **Planned:** signature verification, a plugin SBOM, and an audit record for every plugin call.

Discovery and digesting check path containment before accessing the filesystem. Use relative names with forward slashes, without parent segments, backslashes, NUL, or drive and stream syntax.

The sidecar gateway reserves approval-check capacity for matched tokens and checks the current approval before serving a request. It audits each successful secret delivery and is limited to 120 authenticated requests per minute per plugin and API instance. Process plugins and declarative drivers use best-effort audit notes deduplicated per plugin and per secret for ten minutes. Review saved bindings before upgrading or changing the settings schema; approval with saved values in secret fields requires `vault:reveal`. An unverifiable plugin cannot be called: three consecutive verification strikes, counted at most once per second, or a file with more than one hard link stop the local process and record `plugin.unverifiable` without revoking approval. See [ADR 0050](../../adr/0050-plugin-boundaries-and-vault-key-generations.md) for capacity limits and Linux filesystem guidance.

## 7. Official plugins and packages (first batch)
The plugins below are planned; the repository so far contains skeletons for some of them (`plugins/official/*`).

| Plugin | What it does |
|---|---|
| `dns-rucenter` | RU-CENTER (NIC.RU) API: OAuth password grant, XML, commit/rollback, waiting on authoritative NS |
| `dns-cloudflare`, `dns-route53`, `dns-rfc2136` | main DNS providers |
| `dns-declarative` | YAML drivers for simple REST APIs |
| `certs-cron-script` | adapter for an external certificate sync script (command, node list and user are set in settings): editing the node list, `known_hosts`, running it |
| `certs-rsync`, `certs-push-ssh` | certificate distribution to nodes (generic cert-sync: source, receiver with `rrsync`, reload, node list in the configuration) or delivery over SFTP |
| `acme-dns01`, `acme-http01` | certificate issuance on top of DNS plugins |
| `client-happ` | Happ client compatibility pack: SRR headers, checks, version matrix |
| `notify-telegram` | notifications and (optionally) approvals through bot buttons: low and medium risk; high risk only in the UI with elevated authentication |
| `auth-oidc`, `auth-telegram` | external login (like the Remnawave login methods) |
| `notify-email`, `notify-webhook` | notifications |
| `hosting-hetzner` and others | create, reinstall, power control via API |
| `secret-hashicorp-vault`, `secret-file` | external secret stores |
| `node-selfsteal` | node package: HAProxy by SNI → Xray → nginx (self-steal), decoy, registration in certificate distribution, baseline checks |
| `probe-vless-xray`, `probe-freeze`, `probe-mtr` | probe tests |
| `pack-conventions-example` | example convention pack (remark template, route range) |
| `baseline-standard` | common node security baseline |
| `report-html` | report templates |

## 8. Specific components: public plugins and examples
**Everything that is code is public**, including the RU-CENTER integration and the `selfsteal` node scheme; the specific components are packaged as plugins and examples that anyone can use:

| Component | Where in the public repository |
|---|---|
| RU-CENTER (NIC.RU) integration | `plugins/official/dns-rucenter` |
| cert-sync (external certificate sync script) | `plugins/official/certs-cron-script`, `certs-rsync` |
| HAProxy SNI → Xray → nginx SelfSNI scheme, decoy | `plugins/official/node-selfsteal` |
| Happ client (SRR headers, checks) | `plugins/official/client-happ` |
| Naming and remark conventions | `examples/conventions` |
| Policies for the hop service, the `vlessRoute` range, "panel and node on one host", the order of changing the panel address | `examples/policies/` (parameters in settings) |
| Subscription templates and hop presets | `examples/templates/`, `examples/chains/` (without credentials and real domains) |

**Instance data is not published:** domains, IP addresses, node names and their list, tokens, passwords, keys, `.env`, backups, results of checks and probes, audit logs, user data. They are entered into Swellwright and stored in its database (YAML export and backups) and never reach the repository.

**Data of real installations** (domains, IPs, topology, audit results) never reaches the repository: it exposes nodes.

## 9. Core universality: checks
- The core code has no mentions of a specific DNS provider, nor of domains and IPs of specific installations (checked in CI).
- All names, templates and defaults are generic (`{cc}{n}.{base}`, example `example.com`).
- It works without plugins: manual DNS, manual hoster, standard node, local login.
- Demo mode: `docker compose` with a fake panel and fake nodes for a 5-minute introduction.
- The documentation targets any Remnawave administrator, and the examples are neutral.

## 10. Open project: repository organization
```
swellwright/                     (GitHub, AGPL-3.0-only)
  apps/ api, worker, web, cli, probe-agent
  packages/ contracts, engine, steps, remnawave, ssh, vault, policy, plugin-api, ui, testing ...
  plugins/official/ dns-rucenter, dns-cloudflare, node-selfsteal, ...
  docs/ en/ (canonical), ru/
  deploy/ compose, nginx, systemd, kubernetes (later)
  examples/ convention packs, declarative drivers, demo
  registry/ index.json of the plugin registry
  .github/ workflows, issue and PR templates, CODEOWNERS
  LICENSE  THIRD_PARTY_NOTICES  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  CHANGELOG.md  README.md
```
- **License:** AGPL-3.0-only (compatible with the Remnawave code, which is also `AGPL-3.0-only`, so moving parts over is allowed when needed); SPDX headers in files; `THIRD_PARTY_NOTICES`; a dependency license compatibility check in CI (MIT, Apache-2.0, BSD are acceptable; commercial licenses, such as Highcharts, are not).
- **Contributing:** DCO (`Signed-off-by`), style rules, issue and PR templates, a checklist for plugins, `CODEOWNERS`.
- **Project security:** `SECURITY.md` (responsible disclosure, contacts, timelines), a public threat model, a sample hardened configuration, a hardening guide.
- **Releases:** semantic versions, CHANGELOG, images in GHCR (pinned by digest), SBOM (CycloneDX), cosign signatures, a support policy (which Remnawave and OS versions).
- **CI on GitHub Actions:** linters, types, tests (unit, contract), image builds, Trivy, gitleaks, OpenAPI check (`oasdiff`), license check, a check that no instance data is present.
- **Documentation:** English is canonical, Russian is a full copy, a documentation site later; OpenAPI is published as a release artifact; a "How to write a plugin" guide.
- **The plugin registry** lives in the same repository (`registry/index.json`: links, versions, hashes, trust level); third-party plugins get into it through PRs. Swellwright **downloads nothing by itself** without an explicit action by the administrator.
- **Marks and name:** "Swellwright" is an unofficial project for Remnawave; the README and the UI state "not affiliated with Remnawave".
- **AGPL and public instances:** network use requires offering users the source code; the UI links to the source and shows the version.

## 11. Public repository hygiene (checklist)
1. The repository starts with a clean history, with no secrets, IPs, domains or keys of real installations in any commit.
2. Pre-commit and CI: gitleaks, a forbidden-string check (real domains, IPs and names of installations); the list of forbidden strings itself is not put in the repository, it is kept in the CI settings as a secret.
3. Test data is only synthetic or anonymized.
4. `.env.example` (planned) without real values; examples use `example.com` and documentation addresses (203.0.113.x).
5. **There is one public repository (`swellwright`)**; there is no separate registry repository. Data of real installations never reaches the repository (section 8).
6. Instance data lives in Swellwright (section 8), not in the repository.

## 12. Impact on the roadmap
- Phase 0 gets: the public repository structure, license, DCO, CI, history cleanliness, the documentation language convention.
- Phase 1 gets: **the plugin runtime and the `plugin-api` contracts** (the core is built on extension points from the start; built-in drivers are written as plugins).
- Phase 5: DNS drivers as plugins (`dns-rucenter` first).
- Phase 7: the `node-selfsteal` package, conventions, policies and templates ship as public plugins and examples (without instance data).
- Phase 10: preparation for publication (cleanup, English documentation, demo, release pipeline).
- Details in `11-roadmap.md`.
