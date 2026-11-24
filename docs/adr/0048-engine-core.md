# ADR 0048: The engine core: runs, steps, durable execution and the worker

Status: proposed

## Context
ADR 0005 chose to build the engine on PostgreSQL and a queue, with no external workflow engine, and `docs/en/design/08-engine.md` describes the lifecycle of a run, the step contract, durability, rollback, approvals, strategies and policies. Phase 4 builds it. What exists today:

- **Servers can already be driven durably.** A detached step on a server survives a dropped connection, is followed again by byte offset, and is owned by exactly one launch (ADR 0035). A step is addressed by an id, so "start it again" with the same id attaches to the step that exists instead of running it twice.
- **A runner exists, in the API process.** Commands (ADR 0038) and baseline checks (ADR 0045) run in the API: one process, a compare-and-set on the row's state, a restart picks the rows up again. That is right for a single read-only job and is not an engine: it has no lease (two processes would both take a row), no journal of what was changed, no undo, no approval and no resource lock.
- **The inputs of a plan exist.** The panel client reads (ADR 0041), snapshots and diffs exist (ADR 0043), the impact calculator says what a change restarts (ADR 0044), a vault secret can be handed to a run and is scrubbed from its output (ADR 0042).
- **`apps/worker`, `packages/engine` and `packages/policy` are empty skeletons.** There is no queue library in the repository: Valkey is used only by the readiness check.

The acceptance of the phase (`docs/en/roadmap.md`): "rollback restores the pre-run snapshot; killed worker resumes". Everything below is chosen so that this can be tested, on a real PostgreSQL and with faults injected, not argued.

This ADR decides the core only: the data model, the state machine, the lease and lock, the checkpoint protocol, what a step is, how a run is stopped and undone, the events, and how it is tested. Approvals and the enforcement of policies, the panel write client, the workflows (verify, adopt, deploy, redeploy, rollback) and the run screens each get an ADR of their own, because each has decisions that are the owner's.

## Decision

### PostgreSQL is the only truth; there is no queue library in this slice
ADR 0005 said a run is a PostgreSQL record **plus** a queue job on Valkey, with locks taken by advisory locks **and** Redlock. This ADR narrows that. A run is a PostgreSQL record, and the worker finds work by asking PostgreSQL for it (`SELECT … FOR UPDATE SKIP LOCKED` over runs that are `queued`, or `running` with an expired lease). Reasons:

- **Two truths disagree.** A job that is lost while the row says `queued`, or a job that fires for a run that was cancelled, are bugs the design would have to defend against forever. With one store a run that needs a worker is a row that says so.
- **A lock that gates changes to servers must be checked in the transaction that records the change.** A lock held in Valkey cannot be, and Redlock's safety under pauses and clock jumps is exactly what is disputed. A lock row in PostgreSQL with a **fencing token** (below) can be checked by the very `UPDATE` that writes a checkpoint.
- **No new dependency** to review for a slice whose load is a few runs at a time. Valkey stays what it is (readiness, and later rate limits and wake-ups). If the load ever outgrows polling (an interval of a second or two, plus `LISTEN/NOTIFY` as a hint), a queue library can be put in front of the same tables without changing a step.

### The tables
- `Run`: id (UUIDv7), `workflowKey`, `params` (JSON, **no secrets**: a secret is a reference to the vault), `planHash` (SHA-256 of the canonical plan; the approvals of a later ADR are bound to it), `state`, `risk`, who asked and when, `cancelRequestedAt`, `pauseRequestedAt`, and the lease: `workerId`, `leaseExpiresAt`, `fence` (an integer that only grows).
- `RunStep`: run, `index`, `key` (`node.install.nginx`), `state` (`pending`, `running`, `succeeded`, `failed`, `skipped`, `undone`, `undo_failed`), `attempt`, `remoteId` (the id on the server, below), `output` (JSON, **no secrets**), the error code and message, times.
- `UndoRecord`: run step, `seq`, `kind`, `data` (JSON, **no secrets**), `state`. Written in the same transaction as the step's success.
- `RunEvent`: run, a per-run `seq` that only grows, `kind`, `data`, time. Append-only.
- `ResourceLock`: resource (`node:<name>`, `server:<id>`, `dns-zone:<zone>`, `panel`), the run that holds it, the fence it was taken with, `expiresAt`.

`CommandRun` and `CheckRun` stay as they are. They are not migrated into the engine in this phase: they work, they are read-only, and moving them would be a change with nothing to show for it.

### The state machine is one pure function
`packages/engine` holds `transition(state, event) → state | error` as a table, with every state of design §1 (`planned`, `awaiting_approval`, `queued`, `running`, `paused`, `awaiting_input`, `succeeded`, `failed`, `cancelled`, `rollback_requested`, `rolling_back`, `rolled_back`, `rollback_partial`). An impossible transition is an error that names both states, never a silent no-op. The table is tested exhaustively (every state against every event), and the database layer applies a transition only as a compare-and-set on the state it read.

### A lease and a fence, and a worker that can be killed at any point
A worker takes a run by one statement: it sets `workerId`, `leaseExpiresAt = now() + ttl` and `fence = fence + 1` where the run is claimable, and gets the new `fence` back. It renews the lease on a timer (ttl three times the interval). Every write the worker makes about the run (a state change, a checkpoint, an event, a lock) carries the fence and fails when the row has another one. So a worker that stalled (a long GC pause, a lost network) and wakes up after another worker took the run **cannot write anything**: its next write fails, it stops, and it does not touch the run again.

What the fence cannot do is stop a stalled worker's step that is already running on a server. That is bounded by two things: the step runs on the server as a detached step with an id derived from the run and the step (`remoteId = <runId>-<index>`), so the second worker that starts the same step **attaches** to it (ADR 0035), and the lock on the resource is taken with the same fence, so the second worker's lock supersedes the first's.

### A checkpoint is one transaction
For a step the worker does, in order:
1. **Intent** (one transaction, fence-checked): the step goes `pending → running`, `attempt` grows, an event is appended.
2. **Effect**: `apply` runs.
3. **Checkpoint** (one transaction, fence-checked): the output, the undo records and `running → succeeded` are written together, then the event.

A crash between 1 and 3 leaves a step that says `running` with an expired lease. The next worker decides what to do from the step's declaration:
- **`idempotent: true` (the default)**: run `apply` again. For a step on a server that is a re-attach by `remoteId`.
- **`reconcile(ctx)` declared**: ask the step first. It looks at the world and answers `done` (with the output), `not_done` or `partial`. This is for a step whose effect is on the panel or in DNS, where "again" is not free.
- **`idempotent: false`**: the run goes to `awaiting_input` with the three choices a person has (retry, mark it done, roll back). It is never retried by itself (design §4).

### The step contract
The contract of design §2 stands (`key`, `title`, `estimateSeconds`, `locks`, `plan`, `apply`, `verify`, `undo`), with these additions that the core needs: `idempotent` and `reconcile` (above); every call gets a `StepContext` with the run id, the step index, the attempt, the fence, an `AbortSignal` (cancellation reaches the step), a clock, and **ports** for what it may touch (SSH, panel read, vault references) so that a test supplies fakes; the output and the undo data have a Zod schema each, and a step whose output holds a value that was handed to the run as a secret fails (the same scrubber as ADR 0042 checks it before the write). A step never reads the database.

### Locks
A step names the resources it changes (`locks(ctx)`), and the engine takes all of a run's locks for a stage in one statement, in a fixed order, so two runs cannot wait for each other. A lock row is held with the run's fence and a short expiry that the lease renewal extends. A run that cannot get a lock waits in `queued` with the reason on the run (`waiting: lock server:42 held by <run>`), it does not fail.

### Stopping, pausing, resuming and undoing
`cancelRequestedAt` and `pauseRequestedAt` are rows the worker reads at every renewal and between steps; for a running step the worker aborts the `AbortSignal` and, when the step runs on a server, asks it to stop (`cancelStep`). Cancelling before an irreversible step is `cancelled`; after one the engine offers an undo instead, as design §4 says. Resuming continues from the first step that is not `succeeded`; no secret is typed again, because steps hold references.

Undo runs the undo records in **reverse**, each as an idempotent, journaled step of its own, against the **current** state of the world (design §5). A run is `rolled_back` only when the check the workflow declares (for panel objects, the snapshot diff of ADR 0043 against the one taken before the first change) finds no difference; otherwise it is `rollback_partial` with the list. An undo that fails is `undo_failed`, and the rollback can be resumed.

### Events
Everything the run does is a `RunEvent` with a per-run `seq`. `GET /runs/{id}/events?after=<seq>` answers a page and the same route streams the following ones as server-sent events, so a client that reconnects asks for `after=<last seq>` and misses nothing. People's actions on a run (start, approve, cancel, resume, undo) also go to the audit chain (ADR 0015); the events of the engine itself do not, they are the run's own timeline.

### Where the code lives
`packages/engine` is the core with no I/O: the state machine, the step and workflow types, the scheduling loop over a `RunStore` **port** and the ports of a step. `apps/worker` is the process: the `RunStore` over Prisma (`packages/db`), the SSH and panel adapters, the configuration, the signals. The API creates runs and reads them through the same tables and the pure parts of the engine; it never executes a step. The compose file gets a `worker` service built from the same image with another command. The Prisma schema, the contracts of the run routes and the permissions come with the first code that uses them, not in this ADR.

### How it is tested
The golden and the fault tests of design §13 are part of the core, not a later addition:
- **Pure parts**: the transition table exhaustively; the planning of a run; the order of the undo.
- **Golden scenarios** over fakes and a fake clock: a fixed input gives fixed events, a fixed order of steps and fixed undo records.
- **Fault injection on a real PostgreSQL** (the CI service; PGlite cannot show behaviour under concurrent transactions, which is the point): a worker that is killed at each named point (before the intent, after `apply` and before the checkpoint, after the checkpoint, in the middle of an undo, while holding a lock) and restarted, ending with the same journal and each effect done once; two workers where the first one's lease has expired while it is still alive (the fence must stop it); a lock contested by two runs; a lost `LISTEN/NOTIFY` (polling alone must be enough).
- **The lab** (`P-016`, objects tagged `sw-lab`): the acceptance of the phase, with a real panel and real nodes.

## Consequences
- The run is always what PostgreSQL says. A run cannot be lost with a queue, and a restart of everything is a restart of workers that find the same rows.
- The cost is polling and the load it puts on one table; `FOR UPDATE SKIP LOCKED` and an index on the claimable states keep it small, and the interval is a setting.
- A lock and a checkpoint share a transaction, so the fence is a real guarantee; it does not make a stalled worker's step on a server disappear, and the idempotency of steps is therefore a **requirement on every step author**, tested by the fault suite for every step the engine ships.
- ADR 0005 is narrowed, not reversed: no external engine, durable checkpoints, resume, approvals bound to the plan. Valkey and BullMQ are out of this slice.
- The API process keeps its own small runners for commands and checks. There are two kinds of runner until a later phase moves them, and the documentation says which is which.

## Not built here
Approvals and the enforcement of policies P-001 to P-016; the panel write client (its own ADR, it is the first code that changes the panel); the workflows and their step catalogue; rollout strategies (canary, waves) and health gates; schedules and windows; the run screens; metrics; moving `CommandRun` and `CheckRun` into the engine.

## For the owner
1. **Narrowing ADR 0005** (PostgreSQL only, no Valkey or BullMQ in this slice): the reasoning is above. The alternative is BullMQ as the wake-up with PostgreSQL as the truth, which adds a dependency to review and a second place that can disagree.
2. **An interrupted step that is not idempotent waits for a person** (the default above). The alternative, retrying by itself, is not offered.
3. **A `worker` service in the compose file**, the same image. On the panel host this is one more container with the limits of ADR 0019; on a separate server it is no different from the API.
4. Policies P-001 to P-016 (which are on by default, which only warn) are decided in the next ADR, with a proposal for each.
