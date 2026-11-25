# packages/engine

The run engine (decision: [ADR 0048](../../docs/adr/0048-engine-core.md); design: `docs/en/design/08-engine.md`). Durable execution of the
plan of a run, with a checkpoint after every step, resource locks, a lease and a fence that stop a stalled worker, and the
recovery of a step that a crash interrupted.

What is here (phase 4, slices 1 to 4a):

- the state tables of a run and of a step behind one pure `transition` (`run-state.ts`, `step-state.ts`, `machine.ts`);
- the plan of a run and its hash, canonical JSON, resource locks, the lease arithmetic, recovery and undo order (pure functions:
  `plan.ts`, `locks.ts`, `lease.ts`, `recovery.ts`, `undo.ts`);
- the step contract, the registry of steps (which also plans a step) and workflows (`step.ts`, `registry.ts`, `workflow.ts`);
- the `RunStore` port and the store in memory (`store.ts`, `memory-store.ts`, `limits.ts`: what every store keeps), and the loop
  over the port (`worker.ts`: claim, locks, steps with a checkpoint each, stop, cancel and pause, a step that cannot be repeated);
- the ports a step may use (`ports.ts`: the vault) and `uuidv7` for run ids;
- `@swellwright/engine/testing`: the contract of a store (`runStoreContract`) and the scenarios of the loop
  (`runWorkerScenarios`), which the store in memory and the one over PostgreSQL (`apps/api/src/engine`) both pass.

What is not here yet: the execution of an undo (a run that asked for a rollback is left alone), the ports for SSH and the panel,
the delivery of secret values to steps, and any workflow in the catalogue of the build.

The loop runs inside the API process (`EngineRunner`, `apps/api/src/engine`), because the key of the vault lives only there.
`apps/worker` is a skeleton for a standalone process that is not used.
