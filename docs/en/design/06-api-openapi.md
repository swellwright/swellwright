# 06. API and OpenAPI

> English translation of the [Russian design document](../../ru/design/06-api-openapi.md).

OpenAPI 3.1 is a first-class artifact: documentation, SDKs, the CLI, MCP and contract tests are built from it. An OpenAPI specification is mandatory for every API version.

## 1. Principles
- Base path `/api/v1`; JSON; Zod schemas in `packages/contracts` define validation, types and OpenAPI at the same time (`nestjs-zod` + `@nestjs/swagger`).
- The spec is generated at build time, stored in the repository (`openapi/swellwright.json`), served at `/api/v1/openapi.json`, with Scalar documentation at `/docs` (as in the panel).
- Errors follow RFC 9457 (`application/problem+json`): `type`, `title`, `status`, `detail`, `instance`, `code`, `errors[]`. The set of codes is limited (see section 6).
- Cursor pagination (`limit`, `cursor`), uniform filters and sorting (`filter[...]`, `sort`), `ETag` and `If-Match` for optimistic updates.
- Long operations: `202 Accepted` plus a run resource `runs/{id}`; a repeated `POST` with the same `Idempotency-Key` returns the same run.
- OpenAPI extensions: `x-sw-risk` (`low|medium|high`), `x-sw-approval` (approval required), `x-sw-scopes`, `x-sw-locks` (which resources are locked), `x-sw-permission` (the permission a signed-in caller's role must hold; built, ADR 0015), `x-sw-step-up` (the session must be elevated, otherwise 403 `step_up_required`; built, ADR 0017).
- Versioning: the major version is in the path; breaking changes only with a new major version; deprecation policy (`Deprecation`, `Sunset`).

## 2. Authentication
| Method | Who | Notes |
|---|---|---|
| Cookie session | UI | TOTP/passkey, CSRF, step-up |
| Swellwright bearer token | CLI, automation, MCP | scopes `sw:<resource>:<action>`, expiry, IP |
| Agent token | probe-agent | only writes results and reads its own configuration |
| Signed webhooks (outgoing) | external systems | HMAC-SHA256 in a header |

## 3. Resource groups and endpoints (main)
| Group | Endpoints (in brief) |
|---|---|
| setup | `GET /setup/status`, `POST /setup/owner` (first run only, needs the setup token) |
| auth | `POST /auth/login`, `/auth/logout`, `/auth/totp`, `/auth/totp/enrollment`, `/auth/totp/confirm`, `/auth/passkeys/*`, `POST /auth/step-up` (built, ADR 0017: an authenticator or recovery code elevates the session for a few minutes), `GET /auth/me`; built with ADR 0016: `POST /auth/invitations/accept` (choose a password with an invitation token), `POST /auth/password` (change your own) |
| users, roles | CRUD for Swellwright users and roles. Built (ADR 0015, 0016): `GET /roles` (the built-in roles with their permission sets, and the permission catalogue, in one document); `GET /users`, `POST /users` (invite: no password, a one-time invitation), `PATCH /users/{id}` (role, status, display name, e-mail), `POST /users/{id}/reset-credentials`; no delete yet |
| tokens | `POST/GET/DELETE /tokens` (Swellwright tokens), `GET /tokens/scopes` |
| vault | `GET /vault/status`, `POST /vault/unseal`, `/vault/seal`, `/vault/rotate-kek`; `POST/GET/DELETE /secrets` (values are write-only), `POST /secrets/{id}/reveal` (step-up), `GET /secrets/{id}/usage`. Built (ADR 0018): `GET /vault/status`, `POST /vault/initialize` (once; returns the recovery key), `POST /vault/unseal` (passphrase or recovery key), `POST /vault/seal`, `GET/POST /secrets`, `PATCH /secrets/{id}` (details or a new value), `DELETE /secrets/{id}`, `POST /secrets/{id}/reveal`; a sealed vault answers 423 `vault_sealed`; an expired secret is refused by everything that would use it with 409 `secret_expired` (ADR 0042: `SecretView.expired`/`expiresInDays`, `expired` in the reveal answer); a run may be handed secrets with `POST /command-runs` `secrets` (needs `vault:reveal`; ADR 0042); rotation and usage not yet |
| servers | CRUD, `POST /servers/{id}/facts/refresh`, `GET /servers/{id}/facts`, `/events`, `/snapshots`, `/baseline-results`. Built (ADR 0034): `GET/POST /servers` (filters `state`, `tag`, `q`), `GET/PATCH/DELETE /servers/{id}` (only a draft or retired server is deleted), `POST /servers/{id}/host-keys` (pin by hand, idempotent: 200 when it is pinned already, 201 when new), `DELETE /servers/{id}/host-keys/{keyId}`, `POST /servers/{id}/access`, `PATCH` and `DELETE /servers/{id}/access/{accessId}`; permissions `servers:read` and `servers:write`, no step-up; events, snapshots and baseline results not yet. Built (ADR 0037): `POST /servers/{id}/host-keys/scan` and `.../accept` (`replace` revokes the pinned keys), `POST /servers/{id}/access/{accessId}/verify` (a login that does not work is a result, 200 with `ok: false`), `POST /servers/{id}/facts/refresh` (one at a time per server, a second request joins) and `GET /servers/{id}/facts` (`servers:read`, never connects); everything that connects needs `servers:write`, no step-up, and is rate limited per user; errors `host_key_not_pinned`, `host_key_mismatch` (with `expected` and `actual`), `host_key_replace_required`, `address_not_allowed`, `no_access_entry`, `ssh_connect_failed`, `ssh_auth_failed`, `ssh_key_invalid`, `ssh_timeout`, `ssh_failed`, `facts_unreadable` |
| commands | Built (ADR 0038): `GET/POST /scripts`, `GET/PATCH/DELETE /scripts/{id}` (a built-in script is read-only: 409), `POST /command-runs` (201, queues a run of a script with parameters or an inline command on one to fifty servers; `confirmedLevel` is required for a level other than `read`: 409 `confirmation_required` with `details.level`), `GET /command-runs` (newest first, filters `state` and `serverId`), `GET /command-runs/{id}` (the text that ran, the parameters, every server with its state, exit status, error code and the end of its output), `GET /command-runs/{id}/targets/{targetId}/output` (a page by byte offset, never inside a UTF-8 character, up to 256 KiB) and `POST /command-runs/{id}/cancel` (asking twice is harmless, a finished run is 409); reading is `servers:read` and accepts API tokens, everything that writes, starts or stops needs `servers:exec` and a fresh code and is session-only |
| access | `POST /servers/{id}/access/verify`, `/access/rotate`, `/host-keys/accept` |
| terminal | `POST /servers/{id}/terminal/sessions` (step-up), `WS /ws/terminal/{sessionId}`, `GET /terminal/sessions`, `DELETE ...`, recordings: `GET /terminal/recordings/{id}` |
| commands, scripts | `POST /commands` (server selection, strategy), `GET/POST /scripts`, `GET /commands/{id}` |
| files | `GET /servers/{id}/files?path=`, `PUT`, `DELETE`, `POST /files/distribute` |
| panels | `POST /panels` (connection wizard), `GET /panels/{id}`, `/health`, `/compatibility`, `/tokens` |
| panel-objects | cache reads and a write proxy: `/panels/{id}/nodes`, `/hosts`, `/profiles`, `/squads`, `/templates`, `/subscription-settings`, `/page-configs`, `/plugins`, `/snippets`, `/billing`, `/users` (optional) |
| panel-console | planned for writes: `POST /panels/{id}/console/plan`, `POST /panels/{id}/console/execute` (approval). Built (ADR 0046), read only: `GET /panel/api-console/operations` (`panel:read`: the catalogue of 218 operations with `settings` and `counts`), `GET /panel/api-console/operations/{operationId}` (`panel:read`: one operation with the schemas of its body and its answer) and `POST /panel/api-console/requests` (`panel:console`, session only: `{ operationId, pathParams, query }`, answers `{ status, durationMs, attempts, headers, contentType, bodyFormat, body, bodyBytes, truncated, masked, maskedCount, maskProfile, sentAt }`; a 404 or 403 of the panel is a result); codes `console_operation_unknown` 404, `console_operation_blocked` 403 (`details.reason`: `write_operation`, `secret_material`, `side_effect`), `console_user_data_disabled` 403, `console_response_too_large` 502, `console_response_unsupported` 502, `validation_failed` 400 with `details.issues`, and the codes of the panel reads |
| snapshots | Built (ADR 0043): `GET /panel/snapshots` (`panel:read`, `limit`, `offset`, newest first, with the settings of the job), `POST /panel/snapshots` (`panel:write`, session only, `{ label? }`, 201; reads the panel itself), `GET /panel/snapshots/{id}`, `DELETE /panel/snapshots/{id}` (`panel:write`, step-up, 204), `GET /panel/snapshots/{id}/diff?against=live\|<id>` (`refresh`, `includeUnchanged`) and `GET /panel/snapshots/{id}/export` (a masked JSON file); codes `snapshot_other_panel` 409, `snapshot_too_large` 413, `snapshot_corrupt` 409 and the panel codes of ADR 0041; planned: `POST /snapshots/{id}/restore` (object, phase 7) |
| conventions | CRUD, `POST /conventions/check` (drift), `POST /conventions/fix` (plan) |
| chains | CRUD for hop chains, `POST /chains/{id}/verify`, `GET /chains/{id}/topology` |
| dns | `/dns/providers`, `/dns/zones`, `/dns/records`, `POST /dns/plan`, `/dns/apply`, `/dns/propagation`, `/dns/changes` |
| certs | `/certsync/entries`, `POST /certsync/sync`, `/certs/status`, ACME: `/acme/orders` (optional) |
| blueprints | CRUD for deployment templates, `POST /blueprints/{id}/preview` |
| baselines | CRUD for baselines, `POST /baselines/{id}/run`, `GET /baseline-results`, `POST /baselines/fix` (plan) |
| workflows | `GET /workflows` (catalog with parameter schemas), `POST /workflows/{code}/plan` (dry run), `POST /workflows/{code}/runs` |
| runs | `GET /runs`, `/runs/{id}`, `/stages`, `/steps`, `/events`, `/logs`, `POST /runs/{id}/approve\|reject\|cancel\|pause\|resume\|retry\|rollback`, `GET /runs/{id}/undo-plan` |
| approvals | `GET /approvals`, `POST /approvals/{id}/decision` |
| policies | CRUD for rules, `GET /policies/violations`, `POST /policies/evaluate` |
| schedules | CRUD for schedules, `POST /schedules/{id}/run-now` |
| probes | `/probes/agents`, `/targets`, `/results`, `POST /probes/run`, `GET /probes/matrix` |
| alerts, notifications | `/alerts`, `/alert-rules`, `/notification-channels`, `POST /notifications/test` |
| reports | `POST /reports`, `GET /reports/{id}` (HTML, Markdown, PDF) |
| audit | `GET /audit` (newest first, `cursor`, filters by action, outcome and actor), `POST /audit/verify-chain` (both built, ADR 0015); export |
| artifacts | `/artifacts` (installer, node-engine, baselines), `POST /artifacts/{id}/promote` | Built (ADR 0039): `GET /artifacts`, `GET /artifacts/{name}`, `GET /artifacts/{name}/versions/{version}`, `GET /artifacts/{name}/content` and `.../versions/{version}/content` (the file, streamed, with `X-Content-SHA256`), and on servers `GET/POST /servers/{id}/artifacts`, `POST /servers/{id}/artifacts/{name}/verify`, `DELETE /servers/{id}/artifacts/{name}/{version}` (`servers:read` to read, `servers:write` to push, check and remove). Promotion is not built.
| advisories | `/advisories`, `POST /advisories/{id}/ack` |
| system | `GET /system/health\|ready\|version\|metrics`, `/settings`, `/backups`, `/updates` |
| webhooks | `/webhooks` (subscriptions), `POST /webhooks/{id}/test` |
| plugins | `GET /plugins`, `POST /plugins/{id}/enable\|disable`, `GET/PUT /plugins/{id}/config` (schema from the manifest), `GET /plugins/{id}/permissions`, `POST /plugins/{id}/test`; plugin endpoints with the `/ext/{pluginId}/...` prefix are included in the common OpenAPI |
| import-export | `POST /export`, `POST /import` |

## 4. Events and real-time channels
- WebSocket `/ws`: channels `runs/{id}`, `fleet`, `alerts`, `terminal/{id}`, `servers/{id}`; SSE `/events` as a fallback.
- Event schema: `{id, type, time, runId?, stage?, step?, severity, data}`; types: `run.created`, `run.awaiting_approval`, `run.started`, `stage.started`, `stage.progress`, `stage.finished`, `step.log`, `run.finished`, `run.rolled_back`, `alert.fired`, `alert.resolved`, `server.drift_detected`, `panel.object_changed`, `probe.result`, `vault.sealed`.
- Acknowledgements and redelivery: `id` is monotonic, and the client requests missed events with `Last-Event-ID`.

## 5. SDK, CLI, MCP
- **TypeScript SDK** is generated from the spec (`openapi-typescript` + a thin client); a Python client if needed (generator).
- **CLI `sw`:** `sw runs start deploy --server ... --blueprint ...`, `sw runs watch`, `sw plan`, `sw approve`, `sw rollback`, `sw servers`, `sw dns`, `sw vault status`, `sw status`; output copies as plain text, with `--ascii` and `--json` modes.
- **MCP server** (optional): read tools, writes through drafts and approval; data masking by default (stable pseudonyms).
- **Outgoing webhooks:** subscriptions by event type, retries with exponential backoff, HMAC signature, delivery log.

## 6. Error codes (list)
`validation_failed`, `unauthenticated`, `forbidden`, `step_up_required`, `vault_sealed`, `not_found`, `conflict`, `lock_held`, `precondition_failed`, `policy_blocked`, `approval_required`, `rate_limited`, `panel_unavailable`, `panel_contract_mismatch`, `ssh_unreachable`, `ssh_host_key_changed`, `dns_conflict`, `remote_step_failed`, `rollback_failed`, `internal_error`.

## 7. Spec management (in CI)
Spectral linter (naming rules, mandatory `x-sw-*`, descriptions, examples), `oasdiff` (forbids breaking changes in `v1`), contract tests (Schemathesis against a running API), a check that every endpoint has a test and an example, SDK generation and a check that the client compiles, publishing the spec artifact with the release.

## 8. Compatibility with Remnawave idioms
For familiarity, the same conventions are used where they do not make the design worse: UUIDs for objects, flat camelCase field names, `Authorization: Bearer`, Scalar documentation. The panel's response envelope `{response: ...}` is **not copied** (plain JSON) so as not to complicate clients; the generated SDK hides the differences.

## 9. Plugins in the API
Plugins can add their own routes only in the `/api/v1/ext/{pluginId}/...` namespace. The routes are described with Zod schemas and appear in the common spec marked with their source (`x-sw-plugin`). Plugin permissions are checked on every call, and responses go through secret redaction. The spec without plugins (core only) is published separately as the canonical one.
