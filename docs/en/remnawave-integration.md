# Remnawave integration

Checked against the Remnawave 3.4.x OpenAPI document (every operation of every controller group is covered by the typed client).

## Compatibility

- The panel client uses `@remnawave/backend-contract`, pinned to the panel version; version adapters isolate major changes in one package.
- Capability detection through `GET /api/system/metadata`, `/api/system/configuration` and `/api/system/health`.
- CI compares the frozen spec with new releases (`oasdiff`) and supports the current and previous minor version.

## Panel authentication

- Panel API tokens have **scopes** (catalog at `GET /api/tokens/scopes`, per resource, `read` or `write` per endpoint; `*` grants everything) and an expiry (`expiresInDays`). Tokens can be created and listed **only with an admin JWT**, not with an API token.
- The connection wizard logs in as an admin (password, OAuth2 or passkey), creates the token(s), stores them in the vault and **discards the JWT**.
- Default: **one token** (`*`) for Swellwright. A least-privilege profile is offered for those who prefer it: `core` (write for the resources the workflows need), `readonly`, `probe`.
- Reminders before expiry and rotation without downtime (issue new, switch, revoke old).

## Impact rules (observed on Remnawave 3.4.x)

These facts are encoded in the impact calculator and the policies:

- Editing an inbound of a **shared config profile restarts Xray on every node of that profile**, even if only one inbound changed (the time depends on the node and its configuration). Prefer cloning a profile per node or group.
- Changing the inbound list of an internal squad restarts only the affected node.
- A node holds one profile and one active inbound; inbound tags are globally unique.
- A host is selected by the intersection "squad and inbound"; hosts of offline nodes still appear in subscriptions.
- `vlessRouteId` overwrites characters 14 to 17 of the UUID; it is selected by the client and is not access control. Avoid 0x4000 to 0x4FFF and 0.
- Torrent Blocker inside a chain sees the previous node's IP as the traffic source; do not enable it on chain exits.
- If a node's API port is open only to the panel's address, changing that address makes the node unreachable for the panel (clients keep working); the allow-list change is rolled out before or together with the address change.
- Observed behavior: REALITY servers on recent Xray versions can drop clients that do not offer X25519MLKEM768, so prefer `chrome`, `firefox` or `safari` fingerprints; verify against the Xray release notes.

## Conventions (configurable)

Node names `CC-NN`, domain pattern `{cc}{n}.<base>`, host remark patterns, `address` = node IP with an explicit `sni`, fingerprint policy, subscription-type exclusions, `vlessRouteId` ranges, a marker for test objects. Conventions ship as an example pack and are fully replaceable; [conventions.md](conventions.md) documents the pack format, the rules, reconciliation and the impact calculator.

## What Swellwright adds on top of the panel

Convention linter and live host/node reconciliation; impact calculator and dry runs for every change; canary and wave rollouts of profiles, templates and images; snapshots, diff and restore of single objects, YAML export; hop-chain builder with topology graph; scoped token manager; API console with contract validation and journal; probes from several networks; whole-lifecycle automation of node rename, replace and decommission across panel, DNS and server.

## Panel host

Some tasks are outside the panel API (certificate distribution, backups, container updates, reverse proxy). The panel host is an ordinary inventory server with a restricted account, its own policies and no access to `docker.sock`.

Swellwright never reads the panel database, edits panel files or uses undocumented endpoints.
