# apps/worker

A standalone process for the run engine: reserved, not used. In phase 4 the loop runs inside the API process (`EngineRunner`,
`apps/api/src/engine`, [ADR 0048](../../docs/adr/0048-engine-core.md)) because the key of the vault lives only there; a separate
process comes only with a decision on how it would get the secrets.

Status: skeleton, no code. See `docs/en/` for the design.
