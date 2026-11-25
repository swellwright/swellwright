import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InvalidPlanError, planHash, type JsonValue } from './plan.js';
import { StepRegistry } from './registry.js';
import { InvalidStepInputError, defineStep, type PlanContext, type Schema } from './step.js';
import { serverResource } from './locks.js';
import {
  InvalidWorkflowParamsError,
  UnknownWorkflowError,
  UnregisteredStepError,
  WorkflowRegistry,
  callStep,
  planRun,
} from './workflow.js';

interface Params {
  readonly server: string;
  readonly times: number;
}

const params: Schema<Params> = {
  parse(input) {
    const value = input as { server?: unknown; times?: unknown } | null;
    if (typeof value?.server !== 'string' || typeof value.times !== 'number') {
      throw new Error('server must be a string and times a number');
    }
    return { server: value.server, times: value.times };
  },
};
const anything: Schema<JsonValue> = { parse: (input) => input as JsonValue };

const ctx: PlanContext<null> = { ports: null, signal: new AbortController().signal, now: () => 1 };

const touch = defineStep<Params, JsonValue, null>({
  key: 'test.touch',
  title: (_, p) => `Touch ${p.server}`,
  estimateSeconds: (_, p) => 2 * p.times,
  locks: (_, p) => [serverResource(p.server)],
  plan: (_, p) =>
    Promise.resolve([{ kind: 'file.write', target: `${p.server}:/tmp/x`, summary: 'a file' }]),
  input: params,
  output: anything,
  apply: () => Promise.resolve(null),
});

const steps = new StepRegistry<null>().register(touch);

const touching = {
  key: 'test.touching',
  risk: 'low',
  params,
  steps: (_: PlanContext<null>, p: Params) =>
    Promise.resolve([callStep(touch, p), callStep(touch, { ...p, times: 1 })]),
} as const;

/** The step as the registry plans it: the one place that plans a step. */
const planned = (registry: StepRegistry<null>, key: string, given: unknown) => {
  const step = registry.get(key);
  assert.ok(step, `${key} is registered`);
  return step.plan(ctx, given);
};

describe('the plan of a step', () => {
  it('calls the functions of the contract with the parameters and binds them as the input', async () => {
    assert.deepEqual(await planned(steps, 'test.touch', { server: 's-1', times: 3 }), {
      key: 'test.touch',
      title: 'Touch s-1',
      estimateSeconds: 6,
      input: { server: 's-1', times: 3 },
      locks: [serverResource('s-1')],
      items: [{ kind: 'file.write', target: 's-1:/tmp/x', summary: 'a file' }],
    });
  });

  it('gives the contract the value that the step will act on, so the locks follow what the schema made of the input', async () => {
    // The schema writes a server name in lower case. The run parses the stored input with it, so the plan must lock `s-1`,
    // not `S-1`, or the step would touch a server that the plan never locked.
    const lowercasing = defineStep<Params, JsonValue, null>({
      ...touch,
      key: 'test.lowercase',
      input: {
        parse: (input) => {
          const value = params.parse(input);
          return { ...value, server: value.server.toLowerCase() };
        },
      },
      apply: () => Promise.resolve(null),
    });
    const result = await planned(new StepRegistry<null>().register(lowercasing), 'test.lowercase', {
      server: 'S-1',
      times: 1,
    });
    assert.deepEqual(result.locks, [serverResource('s-1')]);
    assert.equal(result.title, 'Touch s-1');
    assert.deepEqual(result.items, [
      { kind: 'file.write', target: 's-1:/tmp/x', summary: 'a file' },
    ]);
    // What is stored is what was given: the run parses it the same way, and gets the same value as the plan did.
    assert.deepEqual(result.input, { server: 'S-1', times: 1 });
  });

  it('plans on what is stored, so a schema that tells "not set" from "absent" locks what the run will act on', async () => {
    // `{ server: undefined }` and `{}` are two inputs for this schema, but JSON keeps only the second: the stored row holds no
    // `server`, and the worker parses the row. A plan made from the first would lock `a-1` and the run would touch `b-1`.
    interface Choice {
      readonly server?: string | undefined;
    }
    let acted: string | undefined;
    const choosing = defineStep<Choice, JsonValue, null>({
      key: 'test.choose',
      input: {
        parse: (input) => {
          const value = input as Record<string, unknown>;
          return 'server' in value && value['server'] === undefined
            ? { server: 'a-1' }
            : { server: typeof value['server'] === 'string' ? value['server'] : 'b-1' };
        },
      },
      output: anything,
      title: (_, p) => `Choose ${p.server ?? ''}`,
      estimateSeconds: () => 1,
      locks: (_, p) => [serverResource(p.server ?? 'none')],
      plan: () => Promise.resolve([]),
      apply: (_, p) => {
        acted = p.server;
        return Promise.resolve(null);
      },
    });
    const registry = new StepRegistry<null>().register(choosing);
    const result = await planned(registry, 'test.choose', { server: undefined });
    assert.deepEqual(result.input, {});
    assert.deepEqual(result.locks, [serverResource('b-1')]);
    // The step is run on the stored input, and it acts on the resource the plan locked.
    const runner = registry.get('test.choose');
    await runner?.apply(
      {
        ports: null,
        signal: new AbortController().signal,
        now: () => 1,
        runId: 'r',
        stepIndex: 0,
        attempt: 1,
        fence: 1,
        remoteId: 'r-0',
      },
      result.input,
    );
    assert.equal(acted, 'b-1');
  });

  it('refuses an input that the schema of the step refuses, naming the step', async () => {
    await assert.rejects(
      planned(steps, 'test.touch', { server: 's-1', times: 'twice' }),
      (error: unknown) =>
        error instanceof InvalidStepInputError &&
        error.stepKey === 'test.touch' &&
        error.message.includes('times a number'),
    );
  });

  it('refuses an input that JSON cannot hold, as an input of the step', async () => {
    await assert.rejects(
      planned(steps, 'test.touch', { server: 's\u0000-1', times: 1 }),
      (error: unknown) => error instanceof InvalidStepInputError && error.stepKey === 'test.touch',
    );
  });
});

describe('planRun', () => {
  const workflows = new WorkflowRegistry<null>().register(touching);
  const make = (workflowKey: string, given: unknown = { server: 's-1', times: 2 }) =>
    planRun({ workflows, steps, workflowKey, params: given, ctx });

  it('checks the parameters, lists the steps and builds the plan with its locks and estimate', async () => {
    const { plan, risk } = await make('test.touching');
    assert.equal(risk, 'low');
    assert.equal(plan.workflowKey, 'test.touching');
    assert.deepEqual(plan.params, { server: 's-1', times: 2 });
    assert.deepEqual(
      plan.steps.map((step) => [step.index, step.key, step.estimateSeconds]),
      [
        [0, 'test.touch', 4],
        [1, 'test.touch', 2],
      ],
    );
    assert.deepEqual(plan.locks, ['server:s-1']);
    assert.equal(plan.estimateSeconds, 6);
  });

  it('plans every step by the definition that the registry holds, the one the loop will run', async () => {
    // A workflow names a step and its parameters; what the step locks and changes is the registered definition's. Another build
    // of the step under the same key gives another plan, and a workflow cannot hand in a plan of its own.
    const elsewhere = defineStep<Params, JsonValue, null>({
      ...touch,
      locks: () => [serverResource('s-9')],
    });
    const { plan } = await planRun({
      workflows,
      steps: new StepRegistry<null>().register(elsewhere),
      workflowKey: 'test.touching',
      params: { server: 's-1', times: 2 },
      ctx,
    });
    assert.deepEqual(plan.locks, ['server:s-9']);
  });

  it('gives the same plan, and the same hash, for the same parameters', async () => {
    const a = await make('test.touching');
    const b = await make('test.touching');
    assert.equal(planHash(a.plan), planHash(b.plan));
    assert.notEqual(
      planHash(a.plan),
      planHash((await make('test.touching', { server: 's-2', times: 2 })).plan),
    );
  });

  it('refuses a workflow that is not registered', async () => {
    await assert.rejects(make('test.missing'), UnknownWorkflowError);
  });

  it('refuses parameters that do not fit, with the schema’s words and no value of its own', async () => {
    await assert.rejects(make('test.touching', { server: 's-1' }), (error: unknown) => {
      assert.ok(error instanceof InvalidWorkflowParamsError);
      assert.match(error.message, /test\.touching.*server must be a string/u);
      return true;
    });
  });

  it('refuses parameters that JSON cannot hold, which a store could not keep', async () => {
    const fixed = new WorkflowRegistry<null>().register({
      key: 'test.fixed',
      risk: 'low',
      params: anything,
      steps: () => Promise.resolve([callStep(touch, { server: 's-1', times: 1 })]),
    });
    await assert.rejects(
      planRun({
        workflows: fixed,
        steps,
        workflowKey: 'test.fixed',
        params: { note: 'a\u0000b' },
        ctx,
      }),
      InvalidWorkflowParamsError,
    );
    // The parameters of a step are checked the same way, as the input of that step.
    await assert.rejects(
      make('test.touching', { server: 's\u0000-1', times: 1 }),
      (error: unknown) => error instanceof InvalidStepInputError,
    );
  });

  it('refuses a plan that names a step no registry holds: such a run could not be finished', async () => {
    const lonely = new WorkflowRegistry<null>().register(touching);
    await assert.rejects(
      planRun({
        workflows: lonely,
        steps: new StepRegistry<null>(),
        workflowKey: 'test.touching',
        params: { server: 's-1', times: 1 },
        ctx,
      }),
      (error: unknown) => {
        assert.ok(error instanceof UnregisteredStepError);
        assert.equal(error.stepKey, 'test.touch');
        return true;
      },
    );
  });

  it('refuses a workflow with no steps, because a plan needs one', async () => {
    const empty = new WorkflowRegistry<null>().register({
      key: 'test.empty',
      risk: 'low',
      params: anything,
      steps: () => Promise.resolve([]),
    });
    await assert.rejects(
      planRun({ workflows: empty, steps, workflowKey: 'test.empty', params: null, ctx }),
      InvalidPlanError,
    );
  });
});

describe('WorkflowRegistry', () => {
  it('refuses a key registered twice and lists the keys in order', () => {
    const registry = new WorkflowRegistry<null>().register(touching);
    assert.throws(() => registry.register(touching), /registered twice/u);
    registry.register({ ...touching, key: 'a.first' });
    assert.deepEqual(registry.keys(), ['a.first', 'test.touching']);
    assert.equal(registry.get('nope'), undefined);
  });
});
