# 02. Data model

> English translation of the [Russian design document](../../ru/design/02-data-model.md).

The Prisma schema ([`packages/db`](../../../packages/db/README.md), ADR 0013) is built from this description, entity by entity; so far `User`, `Credential`, `RecoveryCode`, `Session`, `Invitation` and `AuditEvent` are implemented. Sensitive fields are encrypted at the application level (the `vault`), not only at the disk level. Data classes: **S** secret (vault only), **P** personal or sensitive (masked by default), **N** normal.

## 1. Access and audit
| Entity | Fields | Class |
|---|---|---|
| `User` | id, name, email (optional), role, status, language, theme, last login | P |
| `Credential` | password (Argon2id), TOTP secret (S; sealed with the instance authentication key, not the vault, so sign-in works while the vault is sealed, ADR 0014), WebAuthn keys (public), recovery codes (hashes; own table `RecoveryCode`) | S |
| `Session` | id, user, token hash, stage (`password_verified`, `active`), IP, UA, created, last seen, idle and absolute expiry, elevated until (built, ADR 0017) | N |
| `Invitation` | user (one open invitation per user), token hash (the token is shown once), purpose (`invite`, `reset`), expiry (72 hours), who issued it (null for the server command; no foreign key). Deleted when used (ADR 0016) | S (hash) |
| `Role` / `RolePermission` | name, permission set (`servers:write`, `runs:execute:deploy`, `terminal:use`, `vault:reveal` …). The five built-in roles are fixed sets in `packages/contracts` (ADR 0015); the tables come with custom roles | N |
| `ApiToken` (Swellwright) | name, hash, scopes, expiry, last use, IP restrictions | S (hash) |
| `AuditEvent` (`audit_events`) | seq, time, actor (id and the name at that moment, no foreign key), action, outcome (`success`, `failure`, `denied`), object, IP, request id, details (flat, canonical text), hash of the previous entry, own hash (chain). Append-only: database triggers refuse update, delete and truncate (ADR 0015) | N |

## 2. Secrets vault
| Entity | Fields |
|---|---|
| `VaultMeta` | KEK version, Argon2id parameters and salt, the KEK wrapped under the passphrase key, the KEK wrapped under the recovery key (one row; the state sealed/unsealed lives in process memory; there is no verification block, the wrap itself proves the passphrase). Built, ADR 0018 |
| `Secret` (built, ADR 0018; metadata only in the list) | id, name, type (`panel-token`, `ssh-key`, `ssh-password`, `ssh-ca`, `dns-oauth`, `provider-token`, `telegram`, `generic`), ciphertext (AES-256-GCM), wrapped DEK, version, metadata (expiry, scope of use), secret owner, reveal policy |
| `SecretUse` | which run or step used which secret (without values) |
| `SecretRotation` | rotation history, next scheduled date |

## 3. Inventory
| Entity | Fields |
|---|---|
| `Provider` | name, driver type (`manual`, `hetzner` …), account secret, link to the panel's `infra-billing` |
| `Server` | id, name, provider, IPv4/IPv6, country, OS, lifecycle state (`draft`, `provisioning`, `active`, `draining`, `retired`), tags, notes, link to the panel node (uuid), host keys (fingerprints), access method (link to a secret), maintenance window |
| `ServerAccess` | method (`password`, `key`, `cert`), user, port, priority, source restriction |
| `ServerFact` | JSON of facts (OS, kernel, packages, services, ports, versions, disk, time), timestamp, source |
| `ServerSnapshot` | run, directory on the server, manifest hash, size, status (created, used for rollback, deleted) |
| `ServerEvent` | lifecycle and drift events |
| `NodeLink` | link between `Server` and a Remnawave node (node uuid, profile, inbounds, hosts) |

**Built in Phase 2 (ADR 0034):** `Server`, `ServerHostKey` (the pinned SHA-256 fingerprints), `ServerAccess` and `ServerFact`. A server has a unique name, an address, an SSH port, a country, a provider as text, a state, tags and notes. An access entry (`password` or `key`) names a vault secret of the matching kind and optionally a second secret for `sudo`; both references restrict on delete, so a secret in use cannot be removed, and a server has at most five entries. Facts are collected over SSH (ADR 0037): `ServerFact` holds a typed document (`schemaVersion` 1, every field nullable, warnings for what could not be read), when and by which access, and the SHA-256 of the read-only script that produced it; an access entry remembers when it was last tried and whether it logged in. The provider as an object, the maintenance window, the link to a panel node, certificates as a method and the other entities of this section are not built yet.

**Built in Phase 2 (ADR 0038):** `Script` (name, description, text, danger level `read`/`change`/`destructive`, whether it runs as root, typed parameters as JSON, built-in or not, a version that rises with every change of the text, the SHA-256 of the text; the built-in ones are made and kept current by name at start), `CommandRun` (the mode `script` or `inline`, the state, the exact text that ran with its hash, the script name and version, the parameter values, the level and the confirmed level, the time limit, who started it, `cancel_requested_at`; it keeps its text when the script is edited or deleted), `CommandRunTarget` (one server of a run: its state `pending`, `running`, `succeeded`, `failed`, `lost`, `cancelled` or `skipped`, the access entry that worked, the step id derived from its id, exit status, error code and message, `waiting`, times, and per stream the bytes kept, the size seen on the server, a `truncated` flag and the last 16 KiB) and `CommandOutputChunk` (the output as raw bytes, one chunk per read, keyed by target, stream and offset). The design table row for `Script` below is the library of this slice; permissions per script are not built (`servers:exec` covers them all).

**Built in Phase 3 (ADR 0041):** `PanelConnection` (one row for now, nothing prevents several): `baseUrl`, `tokenSecretId` (a vault secret of kind `panel_token`; restricts on delete, so a token in use cannot be removed and the vault names the connection), `state` (`connected`, `degraded`, `unreachable`, `unauthorized`, `unsupported`; `unconfigured` is a missing row), `panelVersion`, `capabilities` (what the token can read, per resource), `trustedCa` (public PEM of an authority for this panel), `tokenExpiresAt` (read from the token's expiry claim), `lastCheckedAt`, `lastErrorCode` and `lastErrorMessage`, `createdById`. The token is never in the row. `PanelSnapshot` and the diff are built in the next slice (below).

**Built in Phase 3 (ADR 0043):** `PanelSnapshot` and `PanelSnapshotContent`. `PanelSnapshot` is the summary: the address of the panel it was taken from (not a foreign key to the connection, which is replaced when a token is rotated), an optional label, the kind (`manual`, `scheduled`, `before_change` and `imported`, the last two reserved), the time, who took it (id and the login name at the time, no foreign key; none for the background job), the panel version, counts and coverage (`ok`, `denied`, `failed`) per kind of object, the object count, `overallHash` and a hash per kind, `maskKeyId` (a public identifier of the key behind the fingerprints of the masks), the sizes, and `checkedAt` with `changesSince` (when the panel was last compared with it, and how many objects differed). `PanelSnapshotContent` is one row per snapshot: the JSON of the objects of every covered kind (`{ id, name, hash, config }`, the masked configuration that the hash covers and no runtime state) gzipped, with the SHA-256 of the stored bytes, cascade on delete. **The content is masked, not encrypted:** no unmasked value is ever read into a snapshot, which is what the retention line below says (restore of a secret-bearing object is phase 7 and needs a live secret source; ADR 0043). `PanelDiff` is not a table: a diff is computed when asked.

## 4. Configuration and baselines
| Entity | Fields |
|---|---|
| `Blueprint` | deployment template: profile sample, profile mode, squads, host sample, limits, provider, hardening profile, installer version, DNS policy |
| `Baseline` | node baseline: list of checks, expected values, version |
| `BaselineResult` | server, check, outcome, details, time |
| `Convention` | rules for names and fields: remark template, address=IP, explicit sni, fingerprint policy, `vlessRoute` range, test-object marker (🧪) |
| `PanelConnection` | panel (URL, version, capabilities), tokens (links to secrets), expiry, state |
| `PanelSnapshot` | object types (nodes, hosts, profiles, squads, templates, settings, snippets, plugins, billing), masked JSON, hashes, time (built, ADR 0043) |
| `PanelDiff` | not stored: the differences between two snapshots, or a snapshot and the live panel, computed on request |
| `HopChain` | entry, exit, `vlessRoute`, hop profile, hosts, mode (`always`, `direct-first`), state |

## 5. DNS and certificates
| Entity | Fields |
|---|---|
| `DnsProviderAccount` | driver, secret, zones |
| `DnsZone` | name, service, provider, NS |
| `DnsIntent` | desired record (name, type, value, TTL), owner (server or run) |
| `DnsChange` | before, after, run, approval, visibility on NS |
| `CertSyncEntry` | node, domain, status, last sync, certificate expiry |
| `CertIssuer` (optional) | ACME module: account, domains, expiry |

## 6. Execution
| Entity | Fields |
|---|---|
| `WorkflowDefinition` | code, version, parameter schema (Zod → JSON Schema), time estimate |
| `WorkflowRun` | id, definition, parameters (without secrets), initiator, state (`planned`, `awaiting_approval`, `queued`, `running`, `paused`, `awaiting_input`, `succeeded`, `failed`, `cancelled`, `rollback_requested`, `rolling_back`, `rolled_back`, `rollback_partial`), time, link to the parent |
| `RunStage` / `RunStep` | order, key, state, start and end, attempts, error |
| `RunEvent` | run, stage, status, payload (JSONB), time |
| `RunLogChunk` | run, step, offset, text (sanitized, secrets hidden) |
| `UndoRecord` | run, number, operation (`panel.delete_node`, `dns.restore`, `node.undo`, `file.restore` …), data without secrets, outcome |
| `Approval` | request, risk, impact, who approved and when, comment |
| `Lock` | resource, owner (run), expiry |
| `Schedule` | cron, scenario, parameters, window, enabled |
| `PolicyRule` / `PolicyViolation` | rule, scope, action (`block`, `warn`, `require-approval`) |

## 7. Observability
| Entity | Fields |
|---|---|
| `ProbeAgent` | name, network/carrier, version, token, last response |
| `ProbeTarget` | node, port, test type, schedule |
| `ProbeResult` | target, agent, time, outcome, metrics (RTT, bytes before the freeze, rcode …); monthly partitions |
| `AlertRule` / `Alert` | condition, severity, state, suppression |
| `NotificationChannel` / `NotificationLog` | Telegram, webhook, email |
| `Report` | type, period, data, format |

## 8. Artifacts and library
| Entity | Fields |
|---|---|
| `Artifact` | type (`installer`, `node-engine`, `baseline`, `script`, `template`), version, SHA256 hash, content, signature, note |
| `ServerArtifact` | Built (ADR 0039): server (cascade), name and version of the catalogue artifact, SHA-256 and size that were pushed, destination (`user` or `system`), remote path, when and by whom it was pushed, the last check (`ok`, `differs`, `missing`, when, the hash seen). One row per server, name and version. The catalogue itself is the `artifacts/` directory of the image, verified against its manifests, not a table |
| `Script` | script library (audit, diagnostics): body, parameters, permissions, danger level |
| `ChangeAdvisory` | vulnerability and release records (CVE, USN, GitHub), affected versions, recommendation, "fact/hypothesis" label |

## 9. Retention and lifetime
- Events and run journals: 12 months (configurable); output chunks: 6 months, then compression.
- Probe results: raw for 90 days, aggregates for 2 years.
- Panel snapshots: the newest `SW_PANEL_SNAPSHOT_KEEP` (50) and the newest of each of the last 14 days (built, ADR 0043; the earlier plan of daily for 90 days and weekly for 2 years is not built).
- Audit: no deletion (export and archive).
- Secrets: versions are kept until revoked; values are never written to logs, events, or snapshots (checked on write).

## 10. Migrations and initial data
Prisma migrate; migrations are rolled back through backups. Initialization: `bootstrap` creates the instance owner (role `owner`) and the vault, then the panel connection wizard loads the fleet (import of nodes, hosts, and profiles), collects facts over SSH, and builds the first drift report without making changes (adoption of existing nodes, scenario N01).
