# Architecture

This page includes the target architecture. See [project status](project-status.md) for implemented features; the general worker/engine and full workflow lifecycle remain planned.

## Stack (aligned with Remnawave 3.4.x)

| Layer | Choice |
|---|---|
| Backend | NestJS 12 (the panel uses 11), TypeScript 6.0 (the panel uses 5.9, see ADR 0009), Zod 4 (route registry, ADR 0012), CQRS, `@nestjs/schedule`, Terminus, Prometheus |
| Database | PostgreSQL with Prisma 7 (ADR 0013) and Kysely for heavy queries |
| Runs and locks | PostgreSQL only: workers claim runs with `FOR UPDATE SKIP LOCKED`, locks are rows with a fence token (ADR 0048, which narrows ADR 0005). Valkey is used for readiness; no queue library in the first engine slice |
| SSH | `ssh2`: pooling, detached steps, sudo, PTY terminal, SFTP, certificates |
| Panel client | `@remnawave/backend-contract` pinned per panel version |
| Frontend | React 19, Vite, Mantine 9, TanStack Query 5, Zustand 5, React Router 7, Zod 4, i18next, Tabler icons, Monaco, xterm.js |
| API docs | OpenAPI 3.1 generated from the route registry (ADR 0012), Scalar UI |
| Monorepo | pnpm workspaces, Turborepo, strict TypeScript and ESLint, `--frozen-lockfile --ignore-scripts` |

## Components

```mermaid
flowchart LR
    B[Browser] -- HTTPS --> RP[Reverse proxy]
    RP --> API[swellwright-api<br/>REST, OpenAPI, WS/SSE]
    API --- PG[(PostgreSQL)]
    API --- VK[(Valkey<br/>readiness)]
    API -. runs are rows in PostgreSQL .-> W[swellwright-worker<br/>planned]
    W -- SSH --> N[Servers and nodes]
    W -- HTTPS --> EXT[Remnawave API<br/>DNS and hosting APIs<br/>release feeds]
    PA[probe-agent<br/>optional, other networks] -- HTTPS --> API
    B -. events, terminal .- API
```

- **api**: REST and OpenAPI, WebSocket/SSE, serves the UI, authentication and authorization, creates runs. In the first engine slice it also hosts the loop that executes them, because the vault key lives in its memory only (ADR 0048).
- **worker** (planned): the same loop in a process of its own (SSH, panel and DNS calls, probes); stateless, can be scaled out once the question of how it gets secrets is decided.
- **web**: static UI bundled into the api image.
- **probe-agent** (optional): outbound HTTPS only, write-only token.
- **cli** and **mcp** (optional) on top of the same API.

## Execution model

A run is a database record (ADR 0048): a worker claims it from PostgreSQL with a lease and a fence token, takes locks on resources (node, server, DNS zone, panel, panel host) and executes stages. After every step a checkpoint (step state, undo records, outputs without secrets) is written in one transaction that checks the fence. If a worker dies, another one resumes from the last unfinished step; a step already running on a node is **re-attached** by reading its log and exit-code file.

Approval gates pause a run until a human decides; the decision is bound to a hash of the plan.

The states of a run and the events that move it are one table in `packages/engine` (`run-state.ts`); the diagram below is that table, edge by edge, with the events as labels. A test reads this diagram and fails when it and the table differ, so neither can change alone. `claim` moves `queued` to `running` and takes a run over from a worker whose lease expired (`running` to `running`); a paused run goes back through `queued`, because it has let go of its lease and a worker must claim it again; `succeeded` and `rolled_back` are final.

```mermaid
stateDiagram-v2
    [*] --> planned: dry run, changes nothing
    planned --> awaiting_approval: request_approval
    planned --> queued: queue
    planned --> cancelled: cancel
    awaiting_approval --> queued: approve
    awaiting_approval --> cancelled: reject, cancel
    queued --> running: claim
    queued --> paused: pause
    queued --> cancelled: cancel
    running --> running: claim
    running --> queued: wait
    running --> paused: pause
    running --> awaiting_input: await_input
    running --> succeeded: succeed
    running --> failed: fail
    running --> cancelled: cancel
    paused --> queued: resume
    paused --> cancelled: cancel
    awaiting_input --> queued: retry, mark_done
    awaiting_input --> rollback_requested: request_rollback
    awaiting_input --> cancelled: cancel
    failed --> queued: retry
    failed --> rollback_requested: request_rollback
    cancelled --> rollback_requested: request_rollback
    rollback_requested --> rolling_back: claim
    rolling_back --> rolling_back: claim
    rolling_back --> rolled_back: rollback_done
    rolling_back --> rollback_partial: rollback_partial
    rollback_partial --> rollback_requested: request_rollback
    succeeded --> [*]
    rolled_back --> [*]
```

## SSH layer

- Host keys are pinned (explicit confirmation on first use, alert on change).
- Access methods are configurable per server or group: password, key or certificate.
- Node-side steps run with `setsid`, writing a log and an exit-code file under `<baseDir>/<id>/` (ADR 0035); the screen follows the log by polling, so a dropped session does not kill `apt` or `docker`.
- `sudo` passwords go through stdin, never through command lines.
- Terminal: PTY sessions with credentials typed by the user for that session only.

## Node-side artifacts

A POSIX `sh` installer (versioned, in `artifacts/node-installer/`, ADR 0036) and a small Python engine for snapshot, undo plan, undo and a safety timer for SSH and firewall changes. They are uploaded as versioned artifacts with hash verification; nothing is installed permanently on the node except what the workflow installs.

## Deployment topologies

1. **A separate small VM** (recommended): the compose stack from `deploy/compose`.
2. **On the panel server** in an isolated Docker network: own PostgreSQL and Valkey, unprivileged user, resource limits, egress firewall, no `docker.sock`, no direct access to the panel database.
3. A runner in another network for tasks that need a specific network path (optional).
4. An outbound-only node agent for servers without reachable SSH (optional, later).

## Why TypeScript

One stack with the panel (typed contracts, shared Zod schemas across API, UI and CLI), durable execution and events in one runtime, and end-to-end golden scenario tests that pin the observable behavior of every workflow. The node-side parts stay `sh` and Python because nodes need POSIX `sh` and minimal dependencies.
