# 08. Workflow engine, policies and strategies

> English translation of the [Russian design document](../../ru/design/08-engine.md).

The engine defines stages, the journal, rollback, waits and the safety net, as well as durable execution, approvals, rollout strategies and policies.

## 1. Run lifecycle
`planned` (dry run, changes nothing) → `awaiting_approval` → `queued` → `running` (stages in order) → `succeeded` | `failed` | `cancelled`; after a failure: `rollback_requested` → `rolling_back` → `rolled_back` | `rollback_partial`. The states `paused` (on request or by policy) and `awaiting_input` (waiting for a human: DNS, a manual step at the hosting provider) are also possible.

## 2. Step contract
```ts
interface Step<P, R> {
  key: string;                       // for example "node.install.nginx"
  title(ctx): string;
  estimateSeconds(ctx): number;      // from history, otherwise a default
  locks(ctx): ResourceRef[];         // resources that get locked
  plan(ctx, p: P): Promise<PlanItem[]>;   // what it will change (read-only)
  apply(ctx, p: P): Promise<R>;      // execution, idempotent
  verify?(ctx, r: R): Promise<void>; // check afterwards
  undo?(ctx, r: R): Promise<UndoRecord[]>; // how to undo (data without secrets)
}
```
Requirements: idempotency, deterministic parameters, secrets only by reference to the vault, exceptions with the codes from `06-api-openapi.md`.

## 3. Workflow definition
```ts
defineWorkflow('node.deploy', {
  params: DeployParamsSchema,                    // Zod, the UI builds a form from it
  risk: 'high',
  locks: (p) => [node(p.name), server(p.serverId), dnsZone(p.zone)],
  stages: (p) => [
    stage('connect', ssh.connect(p)),
    when(p.dns === 'driver', stage('dns', dns.ensureA(p))),
    stage('snapshot', node.snapshot(p)),
    stage('preflight', installer.run('preflight', p)),
    ...installer.steps(['base','firewall','docker','node'], p),   // the node variant determines the set
    when(needsReboot, stage('reboot', ssh.rebootAndWait(p))),
    stage('panel', panel.createNodeObjects(p)),
    stage('online', panel.waitNodeOnline(p)),
    stage('verify', installer.run('verify', p)),
    stage('access', access.installAndVerify(p)),
    stage('ssh', ssh.hardening(p)),
    stage('cleanup', node.cleanup(p)),
  ],
  onFailure: 'ask',       // ask | rollback | keep
});
```
Redeploy, rename, decommission and replace use the same steps: shared "building blocks", different compositions.

## 4. Durability and resumption
- A checkpoint in the DB after every step: `RunStep` + undo records + output values (without secrets).
- Worker crash: the run moves to another worker and executes from the first unfinished step; a step already running on a node **re-attaches** to the existing process through its log and exit-code file.
- **Resumption at a human's request:** continue from the failed stage after the cause is fixed; secrets do not need to be entered again (they are in the vault).
- Cancellation: cooperative (between steps) and hard (a signal to the step on the node); cancellation before irreversible steps is safe, after them a rollback is offered.
- Step timeouts and "heartbeats" for long operations; retries with exponential backoff for network errors; steps marked non-idempotent are not retried without an explicit decision.

## 5. Journal and rollback
- `UndoRecord`: the operation type and data without secrets; rollback runs in reverse order and works against the **current** state of the world (targeted): delete what was created, restore the previous value, remove an inbound by tag, restore the cert-sync entry, restore DNS, roll the server back from the snapshot (`node-engine undo`).
- Server rollback is protected: waiting for running steps to finish, checking that the snapshot is present, a list of "what is not rolled back" shown in advance.
- Rollback verification: the differences from the snapshot are recalculated; a run counts as `rolled_back` only if there are none; otherwise it is `rollback_partial` with a list.
- The rollback is itself journaled and can be continued.

## 6. Approvals (approval gates)
- Created automatically based on risk, policy or parameters (shared profile, bulk operation, access change, deletion).
- Contain the plan, impact, rollback, locks and an expiry; approved by the `owner` role or by designated approvers; high risk requires step-up and a confirmation phrase.
- A run does not start without approval; the approval is bound to the plan hash (changing the parameters invalidates it).

## 7. Rollout strategies for multiple targets
| Strategy | Behavior |
|---|---|
| `sequential` | one target at a time, stop at the first failure |
| `canary` | one target first, pause and check, then the rest |
| `waves` | batches of N, a pause and a check between them, an error threshold |
| `parallel(N)` | at most N at once (for safe operations) |

Checks between targets (health gates): node online, Xray uptime, users online (did not drop), subscription latency, user-defined checks. Pause and auto-rollback rules (`stopOnFailure`, `maxFailures`, `autoRollbackOnGateFail`). Maintenance windows and "quiet hours".

## 8. Policies (guardrails)
Safe-operation rules are defined in code. Actions: `block`, `require-approval`, `warn`. They are edited by the `owner` role (with audit) and are enabled by default.

| Code | Rule |
|---|---|
| P-001 | read-only by default; writes require an approved plan |
| P-002 | a backup of the current state (object snapshot or dump) before a change, the rollback declared, a check afterwards |
| P-003 | editing a shared profile or any inbound that affects several nodes: show the node list and the time, require approval and a window; prefer a profile clone |
| P-004 | bulk operations (bulk, `restart-all`, reboots, SSH/UFW/sysctl/kernel) only one node at a time or in small groups, canary first |
| P-005 | tightening SSH (passwords, root) is forbidden until a verified fallback access exists |
| P-006 | fingerprint and transport: one parameter at a time, record what and when |
| P-007 | third-party code, extensions, packages: only after review and permission |
| P-008 | claims from the internet in recommendations are labeled "measured / community / assumption" |
| P-009 | node changes go only through a versioned artifact; a manual step without an artifact is forbidden |
| P-010 | Optional policy (example in `examples/policies`): the service user at the chain exit is protected; `vlessRoute` outside 0x4000-0x4FFF and not 0; Torrent Blocker on the chain exit is forbidden |
| P-011 | test objects (by tag or a mark in the name) are not changed by bulk operations |
| P-012 | Optional policy (example in `examples/policies`): the panel host is set apart if a node also runs on it: operations on it only through an explicit scenario, without touching the panel stack |
| P-013 | a verified key login on every node is required before SSH password authentication is disabled |
| P-014 | deleting a node, profile, DNS zone or user only with a confirmation phrase |
| P-015 | Optional policy (example in `examples/policies`): changing the panel's external address: node ACLs first, then everything else |
| P-016 | **lab mode:** a run is limited to objects tagged `sw-lab` (test node, profile, squad); changing objects outside that set is blocked; enabled for checks in the lab |

## 9. Step catalog (library)
- **ssh:** `connect`, `exec`, `execDetached`, `follow`, `put`, `get`, `rebootAndWait`, `acceptHostKey`, `freshLoginCheck`.
- **node:** `snapshot`, `undoPlan`, `undo`, `safety.arm`, `safety.disarm`, `cleanup`, `aptWait`, `installer.run(step)`, `installer.verify`, `facts.collect`, `engine.upload`.
- **panel:** `createProfile`, `patchProfile` (with the impact calculator), `createNode`, `patchNode`, `createHost`, `patchHost`, `squads.addInbound/removeInbound`, `billing.link`, `metadata.set`, `waitNodeOnline`, `restartNode`, `snapshot.export`, `rest.call` (a generic typed call).
- **dns:** `ensureA`, `removeA`, `wait` (authoritative NS + resolver), `restore`, `lowerTtl`.
- **certsync:** `ensure`, `replace`, `remove`, `syncNow`, `forgetHostKey`.
- **access:** `installCa`, `installKey`, `createAdmin`, `verifyLogin`, `hardenSsh`.
- **provider:** `reinstall`, `power`, `getInfo`.
- **chain:** `createHopProfile`, `allocateRoute`, `createHopHosts`, `verifyChain`.
- **probe:** `run`, `compare`.
- **control:** `approval.gate`, `wait.until`, `policy.check`, `notify.send`, `sleep`, `branch`, `forEach(strategy)`.

## 10. Typical failures that steps account for
Steps and checks account in advance for typical failures when working with nodes:
- A temporary package manager lock (`dpkg`/`apt`, for example background automatic updates): wait for the lock to be released before `apt`, plus `DPkg::Lock::Timeout`.
- An unavailable repository or repository key: fetch the key to a temporary file with verification, retries, a fallback fetch method (https and http).
- Retrying the fetch of external artifacts (packages, images, files): retry with a pause and verify the result.
- SSH loss after a firewall change: an SSH/UFW safety timer with an automatic revert, confirmation of a new login.
- A reboot in the middle of a step: wait for the node to come back and continue the step from the journal.
- `python3` on the node as a precondition; installed if absent.
- Node-side steps run as a separate process (`setsid`), the journal is read by polling, resumption.
- A snapshot before the first change and rollback from the snapshot; the files of packages that remain installed are not deleted.
- The order "DNS and certificate first, then panel objects", waiting for the certificate, waiting for online.
- Checking the authoritative NS after a DNS change and accounting for the resolver cache.
- Removing old host keys on redeploy.

## 11. Schedules and windows
Cron expressions, time zones, maintenance windows per node and group, a "quota of concurrent changes" across the fleet, holiday exceptions; schedules: baseline check (built in Phase 3 as a simple interval, `SW_CHECKS_INTERVAL_HOURS`, ADR 0045: staggered, skipped while the vault is sealed or a secret has expired), update check, panel snapshots, backups, restore verification, daily report, probes.

## 12. Engine observability
Metrics: stage durations, errors by type, number of rollbacks, lock age, queue, approval time. The run timeline is saved to compare against "as usual" and to find speed regressions.

## 13. End-to-end scenario (golden) behavior tests
End-to-end scenarios (deployment, a failure on a step with rollback, redeploy, rename and its finalization, rollback from the journal, DNS scenarios) are written as golden tests of the engine: a fixed input must produce fixed undo records and a fixed order of stages.
