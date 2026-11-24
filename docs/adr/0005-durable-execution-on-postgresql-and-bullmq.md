# ADR 0005: Durable execution on PostgreSQL and BullMQ

Status: accepted

## Context
Workflows change servers and the panel. A run must survive a worker crash, a dropped SSH session and a restart, and an operator must be able to see, approve, pause and undo it. The Remnawave stack already uses PostgreSQL and BullMQ.

## Decision
A run is a PostgreSQL record plus a queue job on a Redis-compatible store (Valkey). A worker takes locks on resources (node, server, DNS zone, panel, panel host) with PostgreSQL advisory locks and Redlock and executes stages. After every step it writes a checkpoint: step state, undo records and outputs without secrets. If a worker dies, another one resumes from the last unfinished step; a step that is already running on a node is re-attached by reading its log and exit-code file. Approvals pause a run and are bound to a hash of the plan. No external workflow engine is used.

## Consequences
Fewer moving parts and the same stack as the panel. The engine (checkpoints, resume, locks, approvals, undo, policies) is project code and must be covered by golden scenario tests and fault injection. If scale ever outgrows this design, the step contract allows moving to another engine without rewriting the steps.

Narrowed by ADR 0048 (the engine core): a run is a PostgreSQL record and a worker finds work by asking PostgreSQL for it; locks are rows with a fence token that the transaction recording a checkpoint checks, and Valkey, BullMQ and Redlock are not used in the first slice. Everything else decided here stands: no external workflow engine, durable checkpoints, resume, approvals bound to the plan.
