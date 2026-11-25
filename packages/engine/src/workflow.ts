// A workflow is a name for a list of steps (ADR 0048, "The fourth slice"; design 08 section 2). A run is made from a
// workflow's key and parameters, never from a plan that a caller wrote: the plan is built here, by code that is part of the
// build, from steps that are registered, so what a person approves is what the code decided and the hash binds the approval.
//
// A workflow says which steps it wants and with which parameters (`StepCall`). It never says what a step locks or changes:
// the registry plans every step from its own definition, the one the loop runs, so the plan and the run cannot disagree.

import {
  canonicalJson,
  buildPlan,
  type JsonValue,
  type RunPlan,
  type StepPlanInput,
} from './plan.js';
import type { StepRegistry } from './registry.js';
import type { RunRisk } from './store.js';
import type { PlanContext, Schema } from './step.js';

export class UnknownWorkflowError extends Error {
  constructor(readonly workflowKey: string) {
    super(`No workflow "${workflowKey.slice(0, 80)}" is registered.`);
    this.name = 'UnknownWorkflowError';
  }
}

/** The parameters do not fit the workflow's schema. The message is the schema's own, cut short, and holds no value. */
export class InvalidWorkflowParamsError extends Error {
  constructor(
    readonly workflowKey: string,
    detail: string,
  ) {
    super(`The parameters of ${workflowKey} are not valid: ${detail.slice(0, 300)}`);
    this.name = 'InvalidWorkflowParamsError';
  }
}

/** The plan names a step that no registry holds: the build is wrong, not the caller. */
export class UnregisteredStepError extends Error {
  constructor(
    readonly workflowKey: string,
    readonly stepKey: string,
  ) {
    super(`The workflow ${workflowKey} plans the step ${stepKey}, which is not registered.`);
    this.name = 'UnregisteredStepError';
  }
}

/** One step of a run as a workflow asks for it: which step, and the parameters bound to it. */
export interface StepCall {
  readonly key: string;
  readonly params: unknown;
}

/** A step call whose parameters are the type that the step's schema gives. */
export function callStep<P>(
  step: { readonly key: string; readonly input: Schema<P> },
  params: P,
): StepCall {
  return { key: step.key, params };
}

export interface Workflow<P, Ports> {
  /** `node.install`: lower-case words separated by dots, at least two. */
  readonly key: string;
  readonly risk: RunRisk;
  /** Checks the parameters a caller gave. What it returns is what the plan stores. */
  readonly params: Schema<P>;
  /**
   * The steps of the run for these parameters, after the conditions of the workflow were decided (a step that is not needed
   * is not in the list). Read only: it may look at the world through the ports and must change nothing.
   */
  readonly steps: (ctx: PlanContext<Ports>, params: P) => Promise<readonly StepCall[]>;
}

/** A workflow as the registry holds it: over `unknown`, so the one place that meets a caller's value parses it first. */
export interface RegisteredWorkflow<Ports> {
  readonly key: string;
  readonly risk: RunRisk;
  /** Checks the parameters and lists the steps. Throws `InvalidWorkflowParamsError` when the parameters do not fit. */
  readonly plan: (
    ctx: PlanContext<Ports>,
    rawParams: unknown,
  ) => Promise<{ readonly params: unknown; readonly steps: readonly StepCall[] }>;
}

/** The workflows that this build knows, by key. */
export class WorkflowRegistry<Ports> {
  private readonly workflows = new Map<string, RegisteredWorkflow<Ports>>();

  register<P>(workflow: Workflow<P, Ports>): this {
    if (this.workflows.has(workflow.key)) {
      throw new Error(`The workflow ${workflow.key} is registered twice.`);
    }
    this.workflows.set(workflow.key, {
      key: workflow.key,
      risk: workflow.risk,
      plan: async (ctx, rawParams) => {
        let params: P;
        try {
          params = workflow.params.parse(rawParams);
        } catch (error) {
          throw new InvalidWorkflowParamsError(
            workflow.key,
            error instanceof Error ? error.message : 'the parameters do not fit',
          );
        }
        return { params, steps: await workflow.steps(ctx, params) };
      },
    });
    return this;
  }

  get(key: string): RegisteredWorkflow<Ports> | undefined {
    return this.workflows.get(key);
  }

  keys(): readonly string[] {
    return [...this.workflows.keys()].sort();
  }
}

const toJson = (value: unknown): JsonValue => JSON.parse(canonicalJson(value)) as JsonValue;

/**
 * The plan of a run of a workflow: the parameters are checked, the steps are listed, every step must be registered (a run
 * that no worker could go on with is never made) and is planned by its registered definition, and the plan is built and
 * hashed. It throws `UnknownWorkflowError`, `InvalidWorkflowParamsError`, `UnregisteredStepError`, `InvalidStepInputError` or
 * `InvalidPlanError`.
 */
export async function planRun<Ports>(input: {
  readonly workflows: WorkflowRegistry<Ports>;
  readonly steps: StepRegistry<Ports>;
  readonly workflowKey: string;
  readonly params: unknown;
  readonly ctx: PlanContext<Ports>;
}): Promise<{ readonly plan: RunPlan; readonly risk: RunRisk }> {
  const workflow = input.workflows.get(input.workflowKey);
  if (workflow === undefined) {
    throw new UnknownWorkflowError(input.workflowKey);
  }
  const { params, steps: calls } = await workflow.plan(input.ctx, input.params);
  const steps: StepPlanInput[] = [];
  for (const call of calls) {
    const registered = input.steps.get(call.key);
    if (registered === undefined) {
      throw new UnregisteredStepError(input.workflowKey, call.key);
    }
    steps.push(await registered.plan(input.ctx, call.params));
  }
  let stored: JsonValue;
  try {
    stored = toJson(params);
  } catch (error) {
    // What a schema accepted but JSON cannot hold (a NUL in a text, a value that is not JSON) is still the caller's parameters.
    throw new InvalidWorkflowParamsError(
      input.workflowKey,
      error instanceof Error ? error.message : 'the parameters are not JSON',
    );
  }
  return {
    plan: buildPlan({ workflowKey: input.workflowKey, params: stored, steps }),
    risk: workflow.risk,
  };
}
