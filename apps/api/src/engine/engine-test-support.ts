// What the tests of the engine inside the API run: a few steps and workflows that only exist here (the production catalogue
// is empty until the workflows are decided), and a world that records what they did.

import {
  type EnginePorts,
  type JsonValue,
  type Schema,
  ShutdownError,
  StepRegistry,
  WorkflowRegistry,
  callStep,
  defineStep,
  serverResource,
} from '@swellwright/engine';
import { z } from 'zod';

const Params = z.object({ label: z.string().min(1).max(40) }).strict();
type Params = z.infer<typeof Params>;

const json: Schema<JsonValue> = { parse: (input) => input as JsonValue };

export interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

export function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** What the steps did, in the order they did it: `<kind>:<label>@<place of the step>#<attempt>`. */
export class WiringWorld {
  readonly applied: string[] = [];
  /** Why the signal of the holding step was aborted, as the step saw it. */
  readonly reasons: unknown[] = [];
  /** Opened by the holding step when it is in hand. */
  readonly holding = gate();
}

const base = (key: string) => ({
  key,
  title: (_: unknown, params: Params) => `${key} ${params.label}`,
  estimateSeconds: () => 1,
  locks: (_: unknown, params: Params) => [serverResource(params.label)],
  plan: () => Promise.resolve([]),
  input: Params,
  output: json,
});

export function wiringCatalogue(world: WiringWorld): {
  readonly steps: StepRegistry<EnginePorts>;
  readonly workflows: WorkflowRegistry<EnginePorts>;
} {
  /** Does something, with nothing from the vault. */
  const plain = defineStep<Params, JsonValue, EnginePorts>({
    ...base('test.wiring.plain'),
    apply: (ctx, params) => {
      world.applied.push(`plain:${params.label}@${String(ctx.stepIndex)}#${String(ctx.attempt)}`);
      return Promise.resolve({ label: params.label });
    },
  });

  /** Needs the vault before it does anything: a sealed one makes the run wait. */
  const vaulted = defineStep<Params, JsonValue, EnginePorts>({
    ...base('test.wiring.vaulted'),
    apply: (ctx, params) => {
      ctx.ports.vault.requireOpen();
      world.applied.push(`vaulted:${params.label}@${String(ctx.stepIndex)}#${String(ctx.attempt)}`);
      return Promise.resolve({ label: params.label });
    },
  });

  /** The first attempt holds until it is asked to stop; the second one, after a take-over, finishes. */
  const holding = defineStep<Params, JsonValue, EnginePorts>({
    ...base('test.wiring.holding'),
    apply: async (ctx, params) => {
      world.applied.push(`holding:${params.label}@${String(ctx.stepIndex)}#${String(ctx.attempt)}`);
      if (ctx.attempt === 1) {
        world.holding.open();
        await new Promise<never>((_, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              world.reasons.push(ctx.signal.reason);
              reject(
                ctx.signal.reason instanceof ShutdownError
                  ? ctx.signal.reason
                  : new Error('aborted'),
              );
            },
            { once: true },
          );
        });
      }
      return { label: params.label, attempt: ctx.attempt };
    },
  });

  const steps = new StepRegistry<EnginePorts>().register(plain).register(vaulted).register(holding);
  const workflows = new WorkflowRegistry<EnginePorts>()
    .register({
      key: 'test.plain',
      risk: 'low',
      params: Params,
      steps: (_, params) => Promise.resolve([callStep(plain, params), callStep(plain, params)]),
    })
    .register({
      key: 'test.vaulted',
      risk: 'low',
      params: Params,
      steps: (_, params) => Promise.resolve([callStep(vaulted, params), callStep(plain, params)]),
    })
    .register({
      key: 'test.holding',
      risk: 'low',
      params: Params,
      steps: (_, params) => Promise.resolve([callStep(holding, params), callStep(plain, params)]),
    });
  return { steps, workflows };
}

/** The loop at a pace a test can wait for: a lease of 0.6 s, a look every 50 ms, a waiting run tried again after 0.1 s. */
export const FAST_ENGINE_ENV = {
  SW_ENGINE_POLL_MS: '50',
  SW_ENGINE_RENEW_MS: '200',
  SW_ENGINE_WAIT_BACKOFF_MS: '100',
  SW_ENGINE_STOP_TIMEOUT_MS: '2000',
} as const;

/** Waits for something that the loop does in the background, in real time and for no longer than `ms`. */
export async function until(condition: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > end) {
      throw new Error('The condition was not reached in time.');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
