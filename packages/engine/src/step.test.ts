import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dnsZoneResource, serverResource } from './locks.js';
import {
  InvalidStepError,
  defineStep,
  remoteId,
  StepDeferredError,
  StepFailure,
  type PlanContext,
  type Schema,
  type Step,
  type StepContext,
} from './step.js';

interface Ports {
  readonly ssh: { readonly run: (command: string) => Promise<string> };
}

const numberSchema: Schema<{ readonly written: number }> = {
  parse(input) {
    if (
      typeof input === 'object' &&
      input !== null &&
      'written' in input &&
      typeof input.written === 'number'
    ) {
      return { written: input.written };
    }
    throw new TypeError('The output is not {written: number}.');
  },
};

const base = (): Step<{ readonly server: string }, { readonly written: number }, Ports> => ({
  key: 'file.write',
  title: (_ctx, params) => `Write a file on ${params.server}`,
  estimateSeconds: () => 2,
  locks: (_ctx, params) => [serverResource(params.server)],
  plan: (_ctx, params) =>
    Promise.resolve([{ kind: 'file.write', target: params.server, summary: 'Write a file' }]),
  input: {
    parse(input) {
      if (
        typeof input === 'object' &&
        input !== null &&
        'server' in input &&
        typeof input.server === 'string'
      ) {
        return { server: input.server };
      }
      throw new TypeError('The input is not {server: string}.');
    },
  },
  apply: async (ctx) => {
    await ctx.ports.ssh.run('true');
    return { written: 1 };
  },
  output: numberSchema,
});

const planContext = (ports: Ports): PlanContext<Ports> => ({
  ports,
  signal: new AbortController().signal,
  now: () => 0,
});

describe('defining a step', () => {
  it('fills in the default: a step is idempotent unless it says it is not', () => {
    assert.equal(defineStep(base()).idempotent, true);
    assert.equal(defineStep({ ...base(), idempotent: false }).idempotent, false);
    assert.equal(defineStep({ ...base(), idempotent: true }).idempotent, true);
  });

  it('refuses a key that is not lower-case words separated by dots', () => {
    for (const key of ['', 'file', 'File.write', 'file write', 'file.', '../x.y']) {
      assert.throws(() => defineStep({ ...base(), key }), InvalidStepError, JSON.stringify(key));
    }
  });

  it('cannot be changed once defined', () => {
    assert.ok(Object.isFrozen(defineStep(base())));
  });

  it('keeps what the step declared, so recovery can read it', () => {
    const reconcile = () => Promise.resolve({ status: 'not_done' } as const);
    const defined = defineStep({ ...base(), idempotent: false, reconcile });
    assert.equal(defined.reconcile, reconcile);
    assert.equal(defined.key, 'file.write');
  });
});

describe('a step over fake ports', () => {
  it('plans, locks and runs with nothing but what its context gives it', async () => {
    const calls: string[] = [];
    const ports: Ports = {
      ssh: {
        run: (command) => {
          calls.push(command);
          return Promise.resolve('');
        },
      },
    };
    const step = defineStep(base());
    const ctx = planContext(ports);
    assert.equal(step.title(ctx, { server: 's-1' }), 'Write a file on s-1');
    assert.deepEqual(
      step.locks(ctx, { server: 's-1' }).map((l) => l.id),
      ['s-1'],
    );
    assert.deepEqual(await step.plan(ctx, { server: 's-1' }), [
      { kind: 'file.write', target: 's-1', summary: 'Write a file' },
    ]);
    assert.deepEqual(calls, [], 'planning changes nothing');
    const run: StepContext<Ports> = {
      ...ctx,
      runId: 'r-1',
      stepIndex: 0,
      attempt: 1,
      fence: 1,
      remoteId: remoteId('r-1', 0),
    };
    const output = step.output.parse(await step.apply(run, { server: 's-1' }));
    assert.deepEqual(output, { written: 1 });
    assert.deepEqual(calls, ['true']);
  });

  it('has an output that is checked before it is written', () => {
    assert.throws(() => numberSchema.parse({ written: 'x' }), TypeError);
    assert.deepEqual(numberSchema.parse({ written: 3, secret: 'dropped' }), { written: 3 });
  });

  it('can name a resource of any kind', () => {
    assert.equal(dnsZoneResource('a.test').kind, 'dns-zone');
  });
});

describe('the id of a step on a server', () => {
  it('is made from the run and the place of the step, so two workers make the same one', () => {
    const runId = '018f6b1e-7d3a-7c3a-9a55-3f2b1c0d9e8f';
    assert.equal(remoteId(runId, 0), `${runId}-0`);
    assert.equal(remoteId(runId, 12), `${runId}-12`);
    assert.equal(remoteId(runId, 3), remoteId(runId, 3));
    assert.notEqual(remoteId(runId, 3), remoteId(runId, 4));
  });

  it('has the shape that the detached steps of the ssh package accept: lower-case letters, digits and dashes, at most 64', () => {
    const accepted = /^[a-z0-9-]{1,64}$/u;
    assert.match(remoteId('018f6b1e-7d3a-7c3a-9a55-3f2b1c0d9e8f', 255), accepted);
    assert.throws(() => remoteId('Upper', 0), RangeError);
    assert.throws(() => remoteId('with space', 0), RangeError);
    assert.throws(() => remoteId('a'.repeat(64), 0), RangeError);
    assert.throws(() => remoteId('', -1), RangeError);
    assert.throws(() => remoteId('r', 1.5), RangeError);
  });
});

describe('what a step throws to say how it ended', () => {
  it('fails with a code that people can rely on', () => {
    const failure = new StepFailure('host_unreachable', 'The host did not answer.');
    assert.ok(failure instanceof Error);
    assert.equal(failure.name, 'StepFailure');
    assert.equal(failure.code, 'host_unreachable');
    assert.equal(failure.message, 'The host did not answer.');
  });

  it('defers with a reason, before it has done anything', () => {
    const deferred = new StepDeferredError('vault_sealed');
    assert.ok(deferred instanceof Error);
    assert.equal(deferred.name, 'StepDeferredError');
    assert.equal(deferred.reason, 'vault_sealed');
    assert.match(deferred.message, /vault_sealed/u);
  });
});
