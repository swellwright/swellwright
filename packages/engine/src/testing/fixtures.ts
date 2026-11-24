// Small things that the tests of the engine and of every store build their runs from.

import { buildPlan, type JsonValue, type RunPlan } from '../plan.js';
import { nodeResource, serverResource, type ResourceRef } from '../locks.js';

/** A UUIDv7-shaped id that is the same for the same number, so a test can name its runs. */
export const runId = (n: number): string =>
  `018f6b1e-0000-7000-8000-${String(n).padStart(12, '0')}`;

export interface PlanStep {
  readonly key?: string;
  readonly input?: JsonValue;
  readonly locks?: readonly ResourceRef[];
  readonly irreversible?: boolean;
}

/** A plan of the given steps; a step without a key is called `test.step-<its place>`. */
export function plan(steps: readonly PlanStep[], params: JsonValue = null): RunPlan {
  return buildPlan({
    workflowKey: 'test.workflow',
    params,
    steps: steps.map((step, index) => ({
      key: step.key ?? `test.step-${String(index)}`,
      title: `Step ${String(index)}`,
      estimateSeconds: 1,
      input: step.input ?? null,
      locks: step.locks ?? [],
      items:
        step.irreversible === true
          ? [{ kind: 'test.change', target: 'x', summary: 'a change', irreversible: true }]
          : [],
    })),
  });
}

export const server = (id: string): ResourceRef => serverResource(id);
export const node = (id: string): ResourceRef => nodeResource(id);

/** A clock that only moves when the test says so. */
export class FakeClock {
  constructor(public time = 1_000_000) {}

  readonly now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}
