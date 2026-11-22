# packages/contracts

For the full implemented scope through API 0.31.0, see [current project status](../../docs/en/project-status.md).
The introductory list below covers the foundation; the route registry is authoritative for current endpoints.

Zod schemas shared by API, UI, CLI and SDK; the source of the OpenAPI document.

Status: error envelope, system, sign-in, user, role and audit schemas, the permission catalogue and the five built-in roles ([ADR 0015](../../docs/adr/0015-permissions-and-the-audit-chain.md)), the route registry (each route states who may call it, which permission it needs and whether it needs a step-up, [ADR 0017](../../docs/adr/0017-step-up-authentication.md)) and the OpenAPI 3.1 generator ([ADR 0012](../../docs/adr/0012-contract-first-api-with-a-route-registry.md)). `pnpm run openapi` rewrites `docs/api/openapi.json`.
