# 04. Remnawave integration

> English translation of the [Russian design document](../../ru/design/04-remnawave-integration.md).

Sources: the Remnawave OpenAPI specification (218 operations, 28 groups; checked against Remnawave 3.4.x), the `remnawave/backend` and `remnawave/frontend` repositories (3.4.x).

## 1. Compatibility and versions
- The client is built on `@remnawave/backend-contract`, with the version pinned to the panel version (Remnawave 3.4.x). An adapter layer per major version: when the contract changes, only one package changes, `packages/remnawave`.
- Capability detection: `GET /api/system/metadata` (version), `GET /api/system/configuration`, `GET /api/system/health`.
- **Contract tests:** the frozen spec is kept in the repository; a CI job compares it with the new release (`oasdiff`) and reports incompatibilities. Support window: "current and previous minor version".
- Writes go only through the contract, with Zod validation before sending.
- **Built in Phase 3 (ADR 0041):** the typed client of `packages/remnawave` is read-only by construction (every endpoint is declared with the method `GET`, there is no write method in its type) and sits on `node:https` with its own limits: a deadline per request, a cap on the answer, retries only for GET and only for failures that may pass, `Retry-After` obeyed, a bounded number of requests at once, no redirect off the panel's origin, TLS verified (an authority of its own for one connection, never a global switch by default), the address checked at connect time with the policy of SSH targets. Its schemas are tolerant and its own, taken from the frozen API description of 3.4.11 (`packages/remnawave/spec/`); the panel's `@remnawave/backend-contract` 3.4.11 is a development dependency used as a cross-check, not at run time (it pins a second Zod and is exact for every field). An unknown shape is a `PanelContractError` naming the endpoint and the field; a version outside the window (`3.4.x`) is `unsupported` with the reason. The adapters turn the panel's objects into normalised views, mask every secret in them with one function (a deny-list with a keyed fingerprint, so a rotation is visible and the value is not) and give each object a hash of its masked configuration, which the snapshots of ADR 0043 keep and compare.

## 2. Authentication and panel permissions
- **By default, one panel token** for Swellwright with `*` permissions. The token is created by the connection wizard (P01) through an admin JWT (API tokens cannot be created or listed with a token), after which the JWT is discarded. The token has a lifetime (`expiresInDays`): a reminder 14 days before expiry, rotation without downtime (issue a new one, switch, revoke the old one).
- **"Least-privilege profile" option** (recommended where access must be restricted): tokens with scopes. Panel tokens have scopes (catalog `GET /api/tokens/scopes`, admin JWT, per resource and a `read`/`write` flag per endpoint; `*` grants everything); the exact strings are determined at run time.
  | Profile | Scopes | Purpose |
  |---|---|---|
  | `full` (default) | `*` | everything |
  | `core` | write: Nodes, Config Profiles, Hosts, Internal/External Squads, Subscription Templates/Settings/Page Configs, Infra Billing, Node Plugins, Snippets, Node Integrations, Metadata, Keygen, System (tools), Users and Bulk and HWID (if the module is enabled); read: everything else | deployment and maintenance without access to panel settings |
  | `readonly` | read of all resources | probes, reports, snapshots, monitoring |
  | `probe` | read of nodes and hosts; Users for test users if needed | probe agents |
- The token is not sent to nodes and does not leave the worker; the orchestrator performs all panel operations.
- Expiry control: reminders, token usage audit, a warning for `*` in public mode ("full access granted").

## 3. Matrix: Swellwright module -> panel resources
| Module | Panel resources (R read, W write) |
|---|---|
| Adoption, drift, reports | Nodes R, Hosts R, Config Profiles R (including computed-config), Internal/External Squads R, Subscription Templates R, Subscription Settings R, Infra Billing R, System R, Metadata R, Node Plugins R |
| Deploy, redeploy, decommission | Nodes W, Config Profiles W, Hosts W, Internal Squads W, Infra Billing W, Metadata W, Keygen R, System R (x25519) |
| Rename | Nodes W, Config Profiles W, Hosts W, Metadata W, Infra Billing W, Subscription Templates R (reference lookup), Subscription Settings R |
| Hops | Config Profiles W, Hosts W, Internal Squads W, Users R/W (service user), Node Plugins R, Nodes R |
| Profiles and REALITY keys | Config Profiles W, System R (x25519), Nodes R, Hosts R |
| Templates, SRR, subscription pages | Subscription Templates W, Subscription Settings W, Subscription Page Configs W, External Squads W, System (srr-matcher) |
| Users (optional) | Users W, Users Bulk W, HWID W, Subscriptions R, Subscription Request History R, Connections W (jobs), Bandwidth R |
| Plugins, snippets | Node Plugins W, Snippets W, Node Integrations W |
| Billing | Infra Billing W |
| Monitor, probes | System R, Nodes R, Bandwidth R, Connections W (geocheck), Users W (test users) |
| Tokens and settings | API Tokens, Remnawave Settings, Passkeys, Auth: admin flow only (P01, P14, P15), not from ordinary tokens |
| API console | depends on the selected token; writes require approval |

## 4. The "panel as source of truth" model
- Panel objects are read on a schedule and on run events; a full snapshot once a day (`PanelSnapshot`), partial ones before every change (for rollback and diff).
- **Built in Phase 3 (ADR 0043):** `POST /panel/snapshots` and the background job (`SW_PANEL_SNAPSHOT_INTERVAL_HOURS`, 24) keep the masked, normalised configuration of every object the token may read; a snapshot is skipped when nothing changed. `GET /panel/snapshots/{id}/diff?against=live|<id>` compares a snapshot with the panel now or another snapshot, object by object (matched by uuid) and field by field (arrays matched by their natural key, sets without regard to order, lists of clients only counted, a rotated secret shown as changed and masked, never as a value). Snapshots hold masked values only: restoring a secret-bearing object (phase 7) needs a live secret source, not the snapshot. The partial snapshot before a change (`before_change`) is reserved for the change flow.
- Swellwright's intents (desired states) are stored separately (`Convention`, `Blueprint`, `DnsIntent`); a divergence from the panel is shown as drift and is not silently overwritten.
- A write follows the scheme "read, check the hash, change, write, verify"; a conflict (someone changed the object in the panel between the read and the write) aborts the operation.
- Identifiers: `uuid` of nodes, hosts, profiles and squads; numeric `userId` for users (since 3.x).
- Node metadata (`PUT /api/metadata/node/{uuid}`): link to the Swellwright server, baseline version, maintenance window.

## 5. Impact rules (observed behavior of Remnawave 3.4.x)
These facts are built into the impact calculator and the policies:
- Editing an inbound of a **shared config profile** restarts Xray on **all** nodes of the profile (the restart time depends on the node and the configuration).
- Changing the inbound list of an internal squad restarts only the affected node.
- A node holds one profile and one active inbound; inbound tags are globally unique.
- A host is selected by the intersection "squad ∩ inbound"; hosts of offline nodes end up in the subscription.
- `vlessRouteId` overwrites characters 14-17 of the UUID; the chain route number (for example `<N>`) is reserved for the hop; the range 0x4000-0x4FFF (16384-20479) and the value 0 are avoided (observed behavior of Remnawave 3.4.x; the convention's default value, configurable); the client selects the route, it is not access control.
- Torrent Blocker in a chain sees the IP of the previous node: by default, do not enable it at the chain exit (configurable).
- By default, do not delete or disable the service user of a hop chain exit (policy, configurable).
- If a node's API port is open only to the panel's address, changing that address makes the nodes unreachable for the panel (clients keep working).
- In recent Xray versions, the REALITY server sends clients without X25519MLKEM768 to the target: `chrome`, `firefox` and `safari` are acceptable (observed behavior; check against Xray releases).

## 6. Naming conventions (defaults, configurable)
- By default: node names `CC-NN`; domain `{cc}{n}.<base>`; host remark `🇳🇱 🎯 XX-01 - selective routing` and `🌐 ... - global mode`; hop hosts of the form `🇦🇦 🠢 🇧🇧 ...`.
- Hosts: `address` = node IP, `sni` = node domain (explicit), port 443, `fingerprint` per policy, subscription types and templates copied from a sample.
- Squad and profile names: letters, digits, space, `_`, `-`.
- By default, test objects are marked with 🧪 (the marker is configurable) and protected from bulk edits.

## 7. Extending Remnawave's capabilities (what the administrator gets beyond automation)
1. A convention linter and real-time reconciliation of hosts with nodes.
2. An impact calculator and a "dry run" for any edit.
3. Canary and wave rollouts of profiles, templates and images.
4. Snapshots, diff and restore of individual objects, export to YAML (GitOps).
5. A builder for hops and multi-hop chains, a topology graph.
6. A scope catalog and issuing of least-privilege tokens, reminders.
7. An API console with contract validation and a journal.
8. Monitoring with probes from different networks and daily availability profiles.
9. Automation of whole-node rename, replace and decommission (panel, DNS, server).
10. Reports on cost and payment due date (billing).

These capabilities stay external (Swellwright does not patch the panel). Upstream improvement requests (for example template operations, events) can be filed separately once experience accumulates.

## 8. Interaction with the panel server over SSH
Some scenarios are not covered by the panel API: certificate distribution (cron scripts), panel backups, container updates, nginx. Swellwright can run on a separate host (the main option) or on the same host as the panel (a possible option). In both cases a "panel host" is introduced for such scenarios as an ordinary inventory server with its own access profile, restricted sudo and separate policies: any change on it only with approval, without deleting data; no access to the Docker socket is granted, and commands go through `docker compose` in the panel directory.

## 9. What Swellwright does not do with the panel
It does not read the panel database directly, edit its files, interfere with its update without an explicit scenario, or use undocumented endpoints.
