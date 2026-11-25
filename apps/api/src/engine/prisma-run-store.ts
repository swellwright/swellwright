// The run store over PostgreSQL (ADR 0048): the same port and the same rules as `MemoryRunStore`, held to them by the same
// suite (`runStoreContract`). Every operation is one transaction that starts by taking an advisory lock named after the run,
// so everything that is written about one run is serialised, the event numbers have no gaps, and the fence is checked on
// the row as it is after the lock, not on a copy. `claimNext` picks the oldest claimable runs and takes the first one whose
// lock it can get at once (`pg_try_advisory_xact_lock`): several loops can poll the same table without waiting for each
// other, which is what `FOR UPDATE SKIP LOCKED` gives, and it needs no SQL that names a table. The locks of a run are taken
// under advisory locks in the fixed order of the keys, so two runs cannot wait for each other.
//
// The time is always given by the caller (a clock is a port of the engine), so no column has a default of `now()`.

import {
  FINISH_EVENTS,
  FenceLostError,
  LockLostError,
  NotFoundError,
  PERSON_EVENTS,
  StateConflictError,
  isClaimable,
  parseLockKey,
  planAcquisition,
  planHash,
  remoteId,
  runMachine,
  transition,
  transitionStep,
  waitingReason,
  type Claim,
  type Claimed,
  type FinishEvent,
  type HeldLock,
  type JsonValue,
  type LockResult,
  type NewRun,
  type PersonEvent,
  type RunEventRow,
  type RunPlan,
  type RunRecord,
  type RunStore,
  type StepRecord,
  type TimelineType,
  type UndoRecordDraft,
  type UndoRecordRow,
  holdsLease,
} from '@swellwright/engine';
import { Prisma, type PrismaClient } from '@swellwright/db';

type Tx = Prisma.TransactionClient;

/** The columns of the rows as the generated client gives them. */
type RunRow = Prisma.RunGetPayload<object>;
type StepRow = Prisma.RunStepGetPayload<object>;

const MAX_ERROR_MESSAGE = 500;
/** An advisory lock is taken per resource key, in key order, before the rows of the locks are read. */
const lockOf = (key: string): string => `resource-lock:${key}`;
/** The advisory lock of a run: whoever writes about the run holds it until the end of the transaction. */
const runLockOf = (id: string): string => `run:${id}`;
/** How many claimable runs `claimNext` looks at before it gives up for this poll. */
const CLAIM_WINDOW = 20;

const at = (ms: number): Date => new Date(ms);
const ms = (date: Date | null): number | null => (date === null ? null : date.getTime());

/** A JSON value for a column: the JSON `null` has to be said so, or Prisma would store nothing. */
const toInput = (value: JsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value ?? Prisma.JsonNull;

const fromJson = (value: Prisma.JsonValue | null): JsonValue => value as JsonValue;

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    workflowKey: row.workflowKey,
    params: fromJson(row.params),
    plan: row.plan as unknown as RunPlan,
    planHash: row.planHash,
    state: row.state,
    risk: row.risk,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.getTime(),
    startedAt: ms(row.startedAt),
    finishedAt: ms(row.finishedAt),
    cancelRequestedAt: ms(row.cancelRequestedAt),
    pauseRequestedAt: ms(row.pauseRequestedAt),
    workerId: row.workerId,
    leaseExpiresAt: ms(row.leaseExpiresAt),
    fence: row.fence,
    waiting: row.waiting,
    retryAfter: ms(row.retryAfter),
  };
}

function toStep(row: StepRow): StepRecord {
  return {
    runId: row.runId,
    index: row.index,
    key: row.key,
    state: row.state,
    attempt: row.attempt,
    remoteId: row.remoteId,
    input: fromJson(row.input),
    output: row.output === null ? null : fromJson(row.output),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: ms(row.startedAt),
    finishedAt: ms(row.finishedAt),
    retryApproved: row.retryApproved,
  };
}

export class PrismaRunStore implements RunStore {
  constructor(private readonly client: PrismaClient) {}

  private transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.client.$transaction(work, { maxWait: 10_000, timeout: 30_000 });
  }

  /** The row of the run, read after the advisory lock of the run is taken (and held until the end of the transaction). */
  private async lockRun(tx: Tx, id: string): Promise<RunRow> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${runLockOf(id)}))`;
    const row = await tx.run.findUnique({ where: { id } });
    if (row === null) {
      throw new NotFoundError(`There is no run ${id}.`);
    }
    return row;
  }

  private async stepsOf(tx: Tx, runId: string): Promise<StepRow[]> {
    return tx.runStep.findMany({ where: { runId }, orderBy: { index: 'asc' } });
  }

  private async stepOf(tx: Tx, runId: string, index: number): Promise<StepRow> {
    const step = await tx.runStep.findUnique({ where: { runId_index: { runId, index } } });
    if (step === null) {
      throw new NotFoundError(`The run ${runId} has no step ${String(index)}.`);
    }
    return step;
  }

  private async emit(
    tx: Tx,
    runId: string,
    time: number,
    type: TimelineType,
    data: JsonValue,
  ): Promise<RunEventRow> {
    const last = await tx.runEvent.aggregate({ where: { runId }, _max: { seq: true } });
    const seq = (last._max.seq ?? 0) + 1;
    await tx.runEvent.create({ data: { runId, seq, at: at(time), type, data: toInput(data) } });
    return { runId, seq, at: time, type, data };
  }

  /** The write is from the worker that holds the run now: the fence, the worker and a state in which a run is held. */
  private async verifyClaim(tx: Tx, claim: Claim): Promise<RunRow> {
    const run = await this.lockRun(tx, claim.runId);
    if (run.fence !== claim.fence || run.workerId !== claim.workerId || !holdsLease(run.state)) {
      throw new FenceLostError(
        claim.runId,
        `The run ${claim.runId} is not held by ${claim.workerId} with the fence ${String(claim.fence)} (the row has ${String(run.fence)}, ${run.state}).`,
      );
    }
    return run;
  }

  /** Every lock of the plan is still a row of this run with this worker's fence. */
  private async verifyLocks(tx: Tx, run: RunRow, claim: Claim): Promise<void> {
    const keys = (run.plan as unknown as RunPlan).locks;
    if (keys.length === 0) {
      return;
    }
    const rows = await tx.resourceLock.findMany({ where: { key: { in: [...keys] } } });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    for (const key of keys) {
      const lock = byKey.get(key);
      if (lock?.runId !== claim.runId || lock.fence !== claim.fence) {
        throw new LockLostError(claim.runId, key);
      }
    }
  }

  async createRun(input: NewRun): Promise<RunRecord> {
    return this.transaction(async (tx) => {
      const existing = await tx.run.findUnique({ where: { id: input.id }, select: { id: true } });
      if (existing !== null) {
        throw new StateConflictError(`The run ${input.id} exists already.`);
      }
      const hash = planHash(input.plan);
      await tx.run.create({
        data: {
          id: input.id,
          workflowKey: input.plan.workflowKey,
          params: toInput(input.plan.params),
          plan: input.plan as unknown as Prisma.InputJsonValue,
          planHash: hash,
          state: 'planned',
          risk: input.risk,
          requestedBy: input.requestedBy,
          createdAt: at(input.now),
          steps: {
            create: input.plan.steps.map((step) => ({
              index: step.index,
              key: step.key,
              remoteId: remoteId(input.id, step.index),
              input: toInput(step.input),
            })),
          },
        },
      });
      await this.emit(tx, input.id, input.now, 'run.created', {
        workflowKey: input.plan.workflowKey,
        planHash: hash,
        steps: input.plan.steps.length,
      });
      return toRun(await tx.run.findUniqueOrThrow({ where: { id: input.id } }));
    });
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const row = await this.client.run.findUnique({ where: { id } });
    return row === null ? null : toRun(row);
  }

  async getSteps(runId: string): Promise<readonly StepRecord[]> {
    await this.requireRun(runId);
    return (
      await this.client.runStep.findMany({ where: { runId }, orderBy: { index: 'asc' } })
    ).map(toStep);
  }

  async getUndoRecords(runId: string): Promise<readonly UndoRecordRow[]> {
    await this.requireRun(runId);
    const rows = await this.client.undoRecord.findMany({
      where: { runId },
      orderBy: [{ stepIndex: 'asc' }, { seq: 'asc' }],
    });
    return rows.map((row) => ({
      runId: row.runId,
      stepIndex: row.stepIndex,
      seq: row.seq,
      kind: row.kind,
      data: fromJson(row.data),
      state: row.state,
    }));
  }

  async listEvents(runId: string, after: number, limit: number): Promise<readonly RunEventRow[]> {
    await this.requireRun(runId);
    const rows = await this.client.runEvent.findMany({
      where: { runId, seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      runId: row.runId,
      seq: row.seq,
      at: row.at.getTime(),
      type: row.type as TimelineType,
      data: fromJson(row.data),
    }));
  }

  async listLocks(): Promise<readonly HeldLock[]> {
    const rows = await this.client.resourceLock.findMany();
    return rows
      .map((row) => ({
        key: row.key,
        holder: row.runId,
        fence: row.fence,
        expiresAt: row.expiresAt.getTime(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  private async requireRun(id: string): Promise<void> {
    const found = await this.client.run.findUnique({ where: { id }, select: { id: true } });
    if (found === null) {
      throw new NotFoundError(`There is no run ${id}.`);
    }
  }

  applyEvent(
    runId: string,
    event: PersonEvent,
    input: {
      readonly now: number;
      readonly expectedState?: string;
      readonly actor?: string | null;
    },
  ): Promise<RunRecord> {
    return this.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      return this.applyEventLocked(tx, run, event, input);
    });
  }

  private async applyEventLocked(
    tx: Tx,
    run: RunRow,
    event: PersonEvent,
    input: {
      readonly now: number;
      readonly expectedState?: string;
      readonly actor?: string | null;
    },
  ): Promise<RunRecord> {
    if (!(PERSON_EVENTS as readonly string[]).includes(event)) {
      throw new StateConflictError(`"${event}" is not an event that a person applies.`);
    }
    if (input.expectedState !== undefined && run.state !== input.expectedState) {
      throw new StateConflictError(
        `The run is ${run.state}, not ${input.expectedState}: it changed since it was read.`,
      );
    }
    if (holdsLease(run.state)) {
      throw new StateConflictError(
        'A worker holds the run: ask it to cancel or pause (requestCancel, requestPause) instead.',
      );
    }
    const next = transition(run.state, event);
    const steps = await this.stepsOf(tx, run.id);
    if (event === 'retry') {
      for (const step of steps) {
        if (step.state === 'failed') {
          await tx.runStep.update({
            where: { runId_index: { runId: run.id, index: step.index } },
            data: {
              state: transitionStep(step.state, 'retry'),
              errorCode: null,
              errorMessage: null,
              finishedAt: null,
            },
          });
        } else if (step.state === 'running') {
          await tx.runStep.update({
            where: { runId_index: { runId: run.id, index: step.index } },
            data: { retryApproved: true },
          });
        }
      }
    } else if (event === 'mark_done') {
      for (const step of steps) {
        if (step.state === 'running') {
          await tx.runStep.update({
            where: { runId_index: { runId: run.id, index: step.index } },
            data: { state: transitionStep(step.state, 'mark_done'), finishedAt: at(input.now) },
          });
        }
      }
    }
    const ends = next === 'cancelled';
    await tx.run.update({
      where: { id: run.id },
      data: {
        state: next,
        waiting: null,
        retryAfter: null,
        finishedAt: ends ? at(input.now) : run.finishedAt,
        pauseRequestedAt: event === 'pause' ? null : run.pauseRequestedAt,
        cancelRequestedAt: ends ? null : run.cancelRequestedAt,
      },
    });
    await this.emit(tx, run.id, input.now, `run.${event}`, {
      from: run.state,
      to: next,
      actor: input.actor ?? null,
    });
    return toRun(await tx.run.findUniqueOrThrow({ where: { id: run.id } }));
  }

  requestCancel(runId: string, now: number): Promise<RunRecord> {
    return this.requestFlag(runId, now, 'cancel');
  }

  requestPause(runId: string, now: number): Promise<RunRecord> {
    return this.requestFlag(runId, now, 'pause');
  }

  private requestFlag(runId: string, now: number, event: 'cancel' | 'pause'): Promise<RunRecord> {
    return this.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (!holdsLease(run.state)) {
        return this.applyEventLocked(tx, run, event, { now });
      }
      if (!runMachine.canApply(run.state, event)) {
        // Says the same as every other refusal: the state does not take the event.
        transition(run.state, event);
      }
      if (event === 'cancel' && run.cancelRequestedAt === null) {
        await tx.run.update({ where: { id: runId }, data: { cancelRequestedAt: at(now) } });
        await this.emit(tx, runId, now, 'run.cancel_requested', {});
      } else if (event === 'pause' && run.pauseRequestedAt === null) {
        await tx.run.update({ where: { id: runId }, data: { pauseRequestedAt: at(now) } });
        await this.emit(tx, runId, now, 'run.pause_requested', {});
      }
      return toRun(await tx.run.findUniqueOrThrow({ where: { id: runId } }));
    });
  }

  claimNext(input: {
    readonly workerId: string;
    readonly now: number;
    readonly leaseMs: number;
  }): Promise<Claimed | null> {
    return this.transaction(async (tx) => {
      const now = at(input.now);
      // The oldest runs that can be taken, by the same rule as `isClaimable` (and a run that waited is left alone until its
      // time). The first one whose lock is free is taken; the rule is applied again to the row after the lock, because the
      // run may have changed between the look and the lock.
      const window = await tx.run.findMany({
        where: {
          AND: [
            {
              OR: [
                { state: { in: ['queued', 'rollback_requested'] } },
                {
                  state: { in: ['running', 'rolling_back'] },
                  OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
                },
              ],
            },
            { OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: CLAIM_WINDOW,
        select: { id: true },
      });
      let candidate: RunRow | null = null;
      for (const { id: candidateId } of window) {
        const got = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${runLockOf(candidateId)})) AS locked`;
        if (got[0]?.locked !== true) {
          continue;
        }
        const row = await tx.run.findUnique({ where: { id: candidateId } });
        if (
          row !== null &&
          isClaimable(row.state, ms(row.leaseExpiresAt), input.now) &&
          (row.retryAfter === null || row.retryAfter.getTime() <= input.now)
        ) {
          candidate = row;
          break;
        }
      }
      if (candidate === null) {
        return null;
      }
      const id = candidate.id;
      const next = transition(candidate.state, 'claim');
      const fence = candidate.fence + 1;
      await tx.run.update({
        where: { id },
        data: {
          state: next,
          workerId: input.workerId,
          leaseExpiresAt: at(input.now + input.leaseMs),
          fence,
          waiting: null,
          retryAfter: null,
          startedAt: candidate.startedAt ?? now,
        },
      });
      await this.emit(tx, id, input.now, 'run.claim', {
        from: candidate.state,
        to: next,
        workerId: input.workerId,
        fence,
        takeover: holdsLease(candidate.state),
      });
      return {
        claim: { runId: id, workerId: input.workerId, fence },
        run: toRun(await tx.run.findUniqueOrThrow({ where: { id } })),
        steps: (await this.stepsOf(tx, id)).map(toStep),
      };
    });
  }

  renewLease(
    claim: Claim,
    input: { readonly now: number; readonly leaseMs: number },
  ): Promise<RunRecord> {
    return this.transaction(async (tx) => {
      await this.verifyClaim(tx, claim);
      const expiresAt = at(input.now + input.leaseMs);
      await tx.run.update({ where: { id: claim.runId }, data: { leaseExpiresAt: expiresAt } });
      await tx.resourceLock.updateMany({
        where: { runId: claim.runId, fence: claim.fence },
        data: { expiresAt },
      });
      return toRun(await tx.run.findUniqueOrThrow({ where: { id: claim.runId } }));
    });
  }

  acquireLocks(
    claim: Claim,
    input: { readonly now: number; readonly ttlMs: number },
  ): Promise<LockResult> {
    return this.transaction(async (tx): Promise<LockResult> => {
      const run = await this.verifyClaim(tx, claim);
      const keys = (run.plan as unknown as RunPlan).locks;
      // The keys are already in the fixed order. Taking the advisory locks in that order, a run that wants a lock that is
      // being taken waits for the other transaction to end and then sees its rows, and two runs cannot wait for each other.
      for (const key of keys) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockOf(key)}))`;
      }
      const rows =
        keys.length === 0
          ? []
          : await tx.resourceLock.findMany({ where: { key: { in: [...keys] } } });
      const result = planAcquisition({
        run: claim.runId,
        wanted: keys.map(parseLockKey),
        held: rows.map((row) => ({
          key: row.key,
          holder: row.runId,
          fence: row.fence,
          expiresAt: row.expiresAt.getTime(),
        })),
        now: input.now,
      });
      if (!result.ok) {
        return {
          ok: false,
          blockedKey: result.blockedKey,
          heldBy: result.heldBy,
          reason: waitingReason(result),
        };
      }
      const expiresAt = at(input.now + input.ttlMs);
      for (const key of result.take) {
        await tx.resourceLock.create({
          data: { key, runId: claim.runId, fence: claim.fence, expiresAt },
        });
      }
      for (const key of [...result.renew, ...result.supersede]) {
        await tx.resourceLock.update({
          where: { key },
          data: { runId: claim.runId, fence: claim.fence, expiresAt },
        });
      }
      if (result.take.length + result.supersede.length > 0) {
        await this.emit(tx, claim.runId, input.now, 'locks.acquired', {
          keys: [...result.take, ...result.supersede],
        });
      }
      return { ok: true, keys: [...keys] };
    });
  }

  beginStep(claim: Claim, index: number, input: { readonly now: number }): Promise<StepRecord> {
    return this.transaction(async (tx) => {
      const run = await this.verifyClaim(tx, claim);
      await this.verifyLocks(tx, run, claim);
      const step = await this.stepOf(tx, claim.runId, index);
      const event = step.state === 'running' ? 'restart' : 'start';
      const state = transitionStep(step.state, event);
      const updated = await tx.runStep.update({
        where: { runId_index: { runId: claim.runId, index } },
        data: {
          state,
          attempt: step.attempt + 1,
          startedAt: step.startedAt ?? at(input.now),
          retryApproved: false,
        },
      });
      await this.emit(tx, claim.runId, input.now, `step.${event}`, {
        index,
        attempt: step.attempt + 1,
      });
      return toStep(updated);
    });
  }

  checkpointStep(
    claim: Claim,
    index: number,
    input: {
      readonly now: number;
      readonly output: JsonValue;
      readonly undo: readonly UndoRecordDraft[];
    },
  ): Promise<StepRecord> {
    return this.transaction(async (tx) => {
      const run = await this.verifyClaim(tx, claim);
      await this.verifyLocks(tx, run, claim);
      const step = await this.stepOf(tx, claim.runId, index);
      const state = transitionStep(step.state, 'succeed');
      const updated = await tx.runStep.update({
        where: { runId_index: { runId: claim.runId, index } },
        data: {
          state,
          output: toInput(input.output),
          errorCode: null,
          errorMessage: null,
          finishedAt: at(input.now),
        },
      });
      if (input.undo.length > 0) {
        await tx.undoRecord.createMany({
          data: input.undo.map((draft, seq) => ({
            runId: claim.runId,
            stepIndex: index,
            seq,
            kind: draft.kind,
            data: toInput(draft.data),
          })),
        });
      }
      await this.emit(tx, claim.runId, input.now, 'step.succeed', {
        index,
        undo: input.undo.length,
      });
      return toStep(updated);
    });
  }

  failStep(
    claim: Claim,
    index: number,
    input: { readonly now: number; readonly code: string; readonly message: string },
  ): Promise<StepRecord> {
    return this.transaction(async (tx) => {
      await this.verifyClaim(tx, claim);
      const step = await this.stepOf(tx, claim.runId, index);
      const updated = await tx.runStep.update({
        where: { runId_index: { runId: claim.runId, index } },
        data: {
          state: transitionStep(step.state, 'fail'),
          errorCode: input.code,
          errorMessage: input.message.slice(0, MAX_ERROR_MESSAGE),
          finishedAt: at(input.now),
        },
      });
      await this.emit(tx, claim.runId, input.now, 'step.fail', { index, code: input.code });
      return toStep(updated);
    });
  }

  deferStep(
    claim: Claim,
    index: number,
    input: { readonly now: number; readonly reason: string },
  ): Promise<StepRecord> {
    return this.transaction(async (tx) => {
      await this.verifyClaim(tx, claim);
      const step = await this.stepOf(tx, claim.runId, index);
      const updated = await tx.runStep.update({
        where: { runId_index: { runId: claim.runId, index } },
        data: { state: transitionStep(step.state, 'defer') },
      });
      await this.emit(tx, claim.runId, input.now, 'step.defer', { index, reason: input.reason });
      return toStep(updated);
    });
  }

  finishRun(
    claim: Claim,
    event: FinishEvent,
    input: {
      readonly now: number;
      readonly waiting?: string | null;
      readonly retryAfter?: number | null;
      readonly data?: JsonValue;
    },
  ): Promise<RunRecord> {
    return this.transaction(async (tx) => {
      if (!(FINISH_EVENTS as readonly string[]).includes(event)) {
        throw new StateConflictError(
          `"${event}" is not an event with which a worker lets go of a run.`,
        );
      }
      const run = await this.verifyClaim(tx, claim);
      if (event === 'succeed') {
        await this.verifyLocks(tx, run, claim);
      }
      const next = transition(run.state, event);
      const ends = next === 'succeeded' || next === 'failed' || next === 'cancelled';
      await tx.run.update({
        where: { id: claim.runId },
        data: {
          state: next,
          workerId: null,
          leaseExpiresAt: null,
          waiting: event === 'wait' || event === 'await_input' ? (input.waiting ?? null) : null,
          retryAfter: event === 'wait' && input.retryAfter != null ? at(input.retryAfter) : null,
          finishedAt: ends ? at(input.now) : run.finishedAt,
          pauseRequestedAt: event === 'pause' ? null : run.pauseRequestedAt,
          cancelRequestedAt: event === 'cancel' ? null : run.cancelRequestedAt,
        },
      });
      await tx.resourceLock.deleteMany({ where: { runId: claim.runId } });
      await this.emit(tx, claim.runId, input.now, `run.${event}`, {
        from: run.state,
        to: next,
        data: input.data ?? null,
        waiting: input.waiting ?? null,
      });
      return toRun(await tx.run.findUniqueOrThrow({ where: { id: claim.runId } }));
    });
  }

  appendEvent(
    claim: Claim,
    type: TimelineType,
    data: JsonValue,
    now: number,
  ): Promise<RunEventRow> {
    return this.transaction(async (tx) => {
      await this.verifyClaim(tx, claim);
      return this.emit(tx, claim.runId, now, type, data);
    });
  }
}
