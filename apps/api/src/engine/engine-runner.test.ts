import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Database } from '@swellwright/db';
import {
  InvalidWorkflowParamsError,
  MemoryRunStore,
  type RunStore,
  ShutdownError,
  StepRegistry,
  UnknownWorkflowError,
  WorkflowRegistry,
  type EnginePorts,
} from '@swellwright/engine';

import { createApp } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import {
  AUTH_KEY,
  CHEAP,
  CHEAP_KDF,
  databaseUrl,
  type Instance,
  restart,
  start,
  stop,
} from '../test-support.js';
import { ENGINE_CATALOGUE, RUN_STORE } from '../tokens.js';
import { VaultService } from '../vault/vault.service.js';
import { type EngineCatalogue, EngineRunner } from './engine-runner.js';
import { EngineRunsService } from './engine-runs.service.js';
import { FAST_ENGINE_ENV, WiringWorld, until, wiringCatalogue } from './engine-test-support.js';

const PASSPHRASE = 'a long passphrase for the vault, used in tests';
const actor = { id: '0193a0b0-0000-7000-8000-000000000001', name: 'owner' };
const meta = { ip: undefined, userAgent: undefined, requestId: undefined };

const store = (instance: Instance): RunStore => instance.app.get<RunStore>(RUN_STORE);

const eventTypes = async (instance: Instance, runId: string): Promise<string[]> =>
  (await store(instance).listEvents(runId, 0, 200)).map((event) => event.type);

const stateOf = async (instance: Instance, runId: string): Promise<string | undefined> =>
  (await store(instance).getRun(runId))?.state;

/** Several connections are what two processes on one database need; a stand with one connection skips the tests. */
const oneConnection = process.env['SW_TEST_DATABASE_POOL'] === '1';

describe('the run engine inside the API', { skip: !databaseUrl }, () => {
  const instances: Instance[] = [];
  const extras: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const extra of extras.splice(0)) {
      await extra.close();
    }
    for (const instance of instances.splice(0)) {
      await stop(instance);
    }
  });

  async function boot(
    world: WiringWorld,
    env: Record<string, string> = {},
    incarnation = 'a',
  ): Promise<Instance> {
    const instance = await start(
      { ...FAST_ENGINE_ENV, ...env },
      { engine: { ...wiringCatalogue(world), tuning: { autostart: true, incarnation } } },
    );
    instances.push(instance);
    return instance;
  }

  describe('a run from its creation to its end', () => {
    it('is taken by the loop that started with the application, steps and locks and all, and the events say how', async () => {
      const world = new WiringWorld();
      const instance = await boot(world);
      assert.equal(instance.app.get(EngineRunner).running, true);

      const run = await instance.app
        .get(EngineRunsService)
        .create('test.plain', { label: 's-1' }, 'person-1');
      assert.equal(run.state, 'queued');
      assert.equal(run.requestedBy, 'person-1');
      assert.equal(run.workflowKey, 'test.plain');
      await until(async () => (await stateOf(instance, run.id)) === 'succeeded');

      assert.deepEqual(await eventTypes(instance, run.id), [
        'run.created',
        'run.queue',
        'run.claim',
        'locks.acquired',
        'step.start',
        'step.succeed',
        'step.start',
        'step.succeed',
        'run.succeed',
      ]);
      assert.deepEqual(world.applied, ['plain:s-1@0#1', 'plain:s-1@1#1']);
      assert.deepEqual(await store(instance).listLocks(), []);
    });

    it('is refused for a workflow that is not known and for parameters that do not fit, and leaves no row', async () => {
      const world = new WiringWorld();
      const instance = await boot(world, { SW_ENGINE_ENABLED: 'false' });
      const runs = instance.app.get(EngineRunsService);
      await assert.rejects(runs.create('test.nothing', {}, null), UnknownWorkflowError);
      await assert.rejects(
        runs.create('test.plain', { label: '' }, null),
        InvalidWorkflowParamsError,
      );
      await assert.rejects(
        runs.create('test.plain', { label: 's-1', extra: true }, null),
        InvalidWorkflowParamsError,
      );
      assert.equal(await instance.isolated.database.client.run.count(), 0);
    });

    it('is left queued when the loop is switched off, and nothing else changes', async () => {
      const world = new WiringWorld();
      const instance = await boot(world, { SW_ENGINE_ENABLED: 'false' });
      assert.equal(instance.app.get(EngineRunner).running, false);
      const run = await instance.app
        .get(EngineRunsService)
        .create('test.plain', { label: 's-1' }, null);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(await stateOf(instance, run.id), 'queued');
      assert.deepEqual(world.applied, []);
    });
  });

  describe('a sealed vault', () => {
    it('makes the run wait with the reason, does nothing in the step, and lets it go on after the unseal', async () => {
      const world = new WiringWorld();
      const instance = await boot(world);
      const vault = instance.app.get(VaultService);
      await vault.initialize(actor, PASSPHRASE, meta);
      await vault.seal(actor, meta);

      const run = await instance.app
        .get(EngineRunsService)
        .create('test.vaulted', { label: 's-2' }, 'person-1');
      await until(async () => {
        const row = await store(instance).getRun(run.id);
        return row?.waiting === 'vault_sealed';
      });
      // The step was asked before it did anything, so nothing of it happened, and it is `pending` again.
      assert.deepEqual(world.applied, []);
      assert.deepEqual(
        (await store(instance).getSteps(run.id)).map((s) => s.state),
        ['pending', 'pending'],
      );
      assert.deepEqual(await store(instance).listLocks(), [], 'a run that waits holds no lock');
      assert.ok((await eventTypes(instance, run.id)).includes('step.defer'));

      await vault.unseal(actor, { passphrase: PASSPHRASE }, meta);
      await until(async () => (await stateOf(instance, run.id)) === 'succeeded');
      // Every start of the step counted as an attempt, the deferred ones too, so the one that did the work is not the first.
      assert.equal(world.applied.length, 2);
      assert.match(String(world.applied[0]), /^vaulted:s-2@0#([2-9]|\d{2,})$/u);
      assert.equal(world.applied[1], 'plain:s-2@1#1');
      const row = await store(instance).getRun(run.id);
      assert.equal(row?.waiting, null);
    });

    it('does not fail a run that waits for a vault that does not exist yet', async () => {
      const world = new WiringWorld();
      const instance = await boot(world);
      const run = await instance.app
        .get(EngineRunsService)
        .create('test.vaulted', { label: 's-3' }, null);
      await until(async () => (await store(instance).getRun(run.id))?.waiting === 'vault_sealed');
      assert.equal(await stateOf(instance, run.id), 'queued');
    });
  });

  describe('the application closing and starting again', () => {
    it('asks the step in hand to give up, closes without waiting for it, and the next process takes the run over', async () => {
      const world = new WiringWorld();
      const first = await boot(world, {}, 'first');
      const run = await first.app
        .get(EngineRunsService)
        .create('test.holding', { label: 's-4' }, 'person-1');
      await world.holding.promise;

      const closing = Date.now();
      const second = await restart(
        first,
        { ...FAST_ENGINE_ENV },
        {
          engine: { ...wiringCatalogue(world), tuning: { autostart: true, incarnation: 'second' } },
        },
      );
      instances.splice(instances.indexOf(first), 1, second);
      assert.ok(
        Date.now() - closing < 1800,
        'closing did not wait for the step to the end of the timeout',
      );
      assert.ok(world.reasons[0] instanceof ShutdownError, 'the step was told why');

      // The lease of the first process runs out (0.6 s), the second one takes the run and starts the step again.
      await until(async () => (await stateOf(second, run.id)) === 'succeeded');
      assert.deepEqual(world.applied, ['holding:s-4@0#1', 'holding:s-4@0#2', 'plain:s-4@1#1']);
      const seen = await eventTypes(second, run.id);
      assert.ok(!seen.includes('step.fail') && !seen.includes('run.fail'));
      assert.equal(seen.filter((type) => type === 'run.claim').length, 2);
      assert.deepEqual(await store(second).listLocks(), []);
    });
  });

  describe(
    'two processes on one database',
    { skip: oneConnection ? 'the stand has one connection' : false },
    () => {
      it('do every run once between them, and each step once', async () => {
        const world = new WiringWorld();
        // A lease of 1.5 s: a busy server must not make a step look abandoned in a test about who does which run.
        const slow = { SW_ENGINE_RENEW_MS: '500' };
        const first = await boot(world, slow, 'first');
        const joined = await createApp(
          loadConfig(
            {
              SW_LOG_LEVEL: 'silent',
              NODE_ENV: 'test',
              SW_AUTH_KEY: AUTH_KEY,
              ...FAST_ENGINE_ENV,
              ...slow,
            },
            '0.0.0-test',
          ),
          {
            readinessChecks: [],
            passwordParams: CHEAP,
            vaultKdf: CHEAP_KDF,
            database: new Database({
              url: databaseUrl ?? '',
              schema: first.isolated.schema,
              poolSize: 3,
            }),
            engine: {
              ...wiringCatalogue(world),
              tuning: { autostart: true, incarnation: 'second' },
            },
          },
        );
        await joined.init();
        extras.push({ close: () => joined.close() });

        const runs = first.app.get(EngineRunsService);
        const ids: string[] = [];
        for (let n = 0; n < 8; n += 1) {
          ids.push((await runs.create('test.plain', { label: `s-${String(n)}` }, null)).id);
        }
        await until(async () => {
          for (const id of ids) {
            if ((await stateOf(first, id)) !== 'succeeded') {
              return false;
            }
          }
          return true;
        });
        assert.equal(world.applied.length, 16, 'two steps for each of the eight runs');
        assert.equal(new Set(world.applied).size, 16, 'each step ran once, as its first attempt');
        assert.deepEqual(await store(first).listLocks(), []);
      });
    },
  );
});

describe('the run engine without a database', () => {
  it('has no loop and refuses to make a run, instead of keeping runs in memory', async () => {
    const world = new WiringWorld();
    const app = await createApp(
      loadConfig({ SW_LOG_LEVEL: 'silent', NODE_ENV: 'test' }, '0.0.0-test'),
      {
        readinessChecks: [],
        engine: { ...wiringCatalogue(world), tuning: { autostart: true } },
      },
    );
    try {
      await app.init();
      assert.equal(app.get(EngineRunner).running, false);
      await assert.rejects(
        app.get(EngineRunsService).create('test.plain', { label: 's-1' }, null),
        ServiceUnavailableException,
      );
    } finally {
      await app.close();
    }
  });

  it('starts with an empty catalogue: no workflow is known until one is written', async () => {
    const app = await createApp(loadConfig({ SW_LOG_LEVEL: 'silent', NODE_ENV: 'test' }, 'v'), {
      readinessChecks: [],
    });
    try {
      await app.init();
      const catalogue = app.get<EngineCatalogue>(ENGINE_CATALOGUE);
      assert.deepEqual(catalogue.steps.keys(), []);
      assert.deepEqual(catalogue.workflows.keys(), []);
    } finally {
      await app.close();
    }
  });
});

describe('the errors of the loop in the log', () => {
  it('says the same trouble once a minute, short and without a stack, and says a new one at once', async () => {
    const errors: string[] = [];
    const spy = mock.method(Logger.prototype, 'error', (message: unknown) => {
      errors.push(String(message));
    });
    let down: Error = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    let time = 1_000_000;
    const memory = new MemoryRunStore();
    const flaky = new Proxy(memory, {
      get(target, property, receiver) {
        if (property === 'claimNext') {
          return () => Promise.reject(down);
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const runner = new EngineRunner(
      loadConfig({ SW_LOG_LEVEL: 'silent', SW_ENGINE_POLL_MS: '50' }, 'v'),
      flaky,
      () => time,
      { steps: new StepRegistry<EnginePorts>(), workflows: new WorkflowRegistry<EnginePorts>() },
      { vault: { requireOpen: () => undefined, isOpen: () => true } },
      { incarnation: 'log' },
    );
    try {
      runner.start();
      await until(() => Promise.resolve(errors.length >= 1), 2000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(errors.length, 1, 'six polls, one line');
      assert.match(errors[0] ?? '', /Error: connect ECONNREFUSED/u);
      assert.ok((errors[0] ?? '').length < 400);

      time += 61_000;
      await until(() => Promise.resolve(errors.length >= 2), 2000);
      down = new Error('something else');
      await until(
        () => Promise.resolve(errors.some((line) => line.includes('something else'))),
        2000,
      );
    } finally {
      await runner.stop();
      spy.mock.restore();
    }
  });
});
