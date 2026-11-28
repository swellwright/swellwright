# Plugins

The core is universal. Everything that depends on a vendor, protocol, script or naming scheme is a plugin or an example, the way login providers are options in the Remnawave panel.

## What is core and what is a plugin

| Area | Core | Plugin |
|---|---|---|
| Vault, audit, roles, login | local users, password, TOTP, WebAuthn | `auth-oidc`, `auth-telegram` |
| Inventory, SSH (password, key, certificate), terminal, files | yes | external key stores, certificate authority drivers |
| Workflow engine, policies, approvals, schedules | yes | workflow packs |
| Remnawave client | yes (version adapter) | adapters for other panels (future) |
| Standard node: Docker, remnanode, UFW, fail2ban, sysctl, SSH policies, API-port ACL | yes | |
| Self-steal node (HAProxy SNI, nginx SelfSNI, decoy site, certificate receiver) | | `node-selfsteal` |
| DNS | interface, manual mode | `dns-rucenter`, `dns-cloudflare`, `dns-route53`, `dns-rfc2136`, declarative drivers |
| Certificates | checks, expiry alerts, register/sync scenarios | `certs-rsync`, `certs-cron-script`, `certs-push-ssh`, `acme-*` |
| Hosting | manual mode | `hosting-*` (by API) |
| Notifications | internal events | `notify-telegram`, `notify-email`, `notify-webhook` |
| Probes | agent framework and schedules | `probe-vless-xray`, `probe-freeze`, `probe-mtr` |
| Client compatibility | templates and rule mechanics | `client-happ` and others |
| Secrets | built-in vault | `secret-hashicorp-vault`, `secret-file` |

## Extension points

`DnsProvider`, `CertDistributor`, `CertIssuer`, `HostingProvider`, `NotificationChannel`, `AuthProvider`, `SecretBackend`, `AccessMethod`, `NodeFlavor`, `BaselinePack`, `ConventionPack`, `WorkflowPack`, `ProbeTest`, `ReportTemplate`, `ClientProfile`, `PanelAdapter`, `UiContribution`. For REST services (DNS, hosting, notifications) a **declarative driver** (YAML: authentication, requests, response mapping) avoids executing third-party code.

```ts
interface DnsProvider {
  id: string; configSchema: ZodSchema; secretKinds: string[];
  listZones(ctx): Promise<Zone[]>;
  listRecords(ctx, zone): Promise<DnsRecord[]>;
  plan(ctx, intent: DnsIntent): Promise<DnsPlan>;     // read only
  apply(ctx, plan: DnsPlan): Promise<DnsChange>;      // write, commit if needed
  undo(ctx, change: DnsChange): Promise<void>;
  authoritativeServers?(ctx, zone): Promise<string[]>;
}
```

## Manifest (`swellwright.plugin.json`)

```json
{
  "id": "dns-example", "version": "1.0.0", "name": "Example DNS",
  "engines": { "swellwright": ">=1.0 <2" },
  "provides": [{ "kind": "DnsProvider", "entry": "./dist/provider.js" }],
  "permissions": { "network": ["api.example.com:443"], "secrets": ["dns-token"], "panel": [], "ssh": false },
  "config": { "schema": "./config.schema.json" },
  "storage": { "namespace": "dns-example" },
  "license": "AGPL-3.0-only"
}
```

Permissions are requested explicitly and shown when a plugin is enabled. A plugin gets an isolated key-value and JSON store, no access to the core database, and its settings form is generated from its schema.

## Trust levels and isolation

- **Official:** can run in a separate process under Node permissions; outbound requests go through the core and are limited to approved hosts. Official signatures are not verified yet.
- **Community:** run only as **container sidecars** (OCI image and manifest) or declarative drivers. A sidecar has a dedicated internal network shared only with the core. It cannot access the database directly; the gateway handles approved outbound requests and bound secrets. Swellwright does not use `docker.sock`: the operator exports and applies the Compose fragment after enabling the plugin.
- **local:** a directory owned by the operator, at the operator's risk.
- **Implemented:** SHA-256 approvals, blocked install scripts (including `postinstall`), manual approval of updates, and audit events for lifecycle, refusals and secret use. A sidecar must be enabled before export; export a fresh fragment after reapproval. Binding secrets and exporting a fragment that authorizes secrets require `vault:reveal`.
- **Planned:** signature verification, a plugin SBOM, and a complete audit trail of plugin calls.

In-process isolation in Node is not a hard boundary and is never relied on for untrusted code.

The sidecar gateway audits every successful secret delivery, up to its rate limit of 120 requests per minute per plugin and API instance. Process plugins and declarative drivers instead use best-effort audit notes, deduplicated per plugin and secret for ten minutes. Before upgrading or changing a settings schema, an owner should review saved secret bindings and remove obsolete IDs. Approval with a saved value in a secret field requires `vault:reveal`.

Install an exported tree without `.git` where possible. Swellwright rejects links and includes repository metadata in the approval digest if it is present; a Git working copy may exceed the ordinary plugin file and size limits. An existing working copy may require reapproval after an upgrade. Plugin stdout, stderr and startup exceptions are not shown in the runtime status. See [ADR 0050](../adr/0050-plugin-boundaries-and-vault-key-generations.md).

## Lifecycle

Discover (a mounted `plugins/` directory, npm packages `@swellwright/plugin-*`, local directories) -> list in Settings -> enable after reviewing permissions -> configure -> use -> update (permission diff, no automatic download) -> disable -> remove (plugin data optional).

## Registry

`registry/index.json` in this repository lists community plugins (links, versions, hashes, trust level), added through pull requests. Swellwright never downloads anything without an explicit operator action.

## Examples shipped in this repository

`examples/conventions` (naming and remark patterns), `examples/policies` (hop service and route ranges, panel and node on one host, API-port allow-list changes), `examples/templates` (subscription templates without credentials or real domains), `examples/chains` (hop presets), declarative driver samples.
