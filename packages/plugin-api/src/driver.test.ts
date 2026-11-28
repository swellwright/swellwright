import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigSchemaFileSchema } from './config-schema.js';
import {
  checkDriverAgainstPlugin,
  type Driver,
  DriverError,
  type DriverServices,
  driverHosts,
  parseDriver,
  parseTemplate,
  runOperation,
} from './driver.js';
import { PluginManifestSchema } from './manifest.js';

const DRIVER = {
  version: 1,
  kind: 'NotificationChannel',
  operations: {
    send: {
      description: 'Send a message',
      params: {
        message: { type: 'string', required: true, maxLength: 4096 },
        silent: { type: 'boolean', default: false },
      },
      steps: [
        {
          id: 'call',
          request: {
            method: 'POST',
            url: 'https://api.example.com/bot{{ secret.botToken | raw }}/sendMessage',
            headers: { Accept: 'application/json' },
            body: {
              chat_id: '{{ config.chatId }}',
              text: '{{ params.message }}',
              disable_notification: '{{ params.silent }}',
            },
          },
          expect: { status: [200], error: '{{ steps.call.json.description }}' },
        },
      ],
      result: {
        ok: '{{ steps.call.json.ok }}',
        messageId: '{{ steps.call.json.result.message_id }}',
      },
    },
  },
};

const parse = (value: unknown) => parseDriver(value);
const sound = (value: unknown): Driver => {
  const { driver, problems } = parse(value);
  assert.deepEqual(problems, []);
  assert.ok(driver);
  return driver;
};

describe('reading a driver', () => {
  it('accepts a driver that reads values only from places that exist', () => {
    const driver = sound(DRIVER);
    assert.deepEqual(Object.keys(driver.operations), ['send']);
  });

  it('refuses unknown keys, a kind that cannot be declarative, and a missing operation list', () => {
    assert.ok(parse({ ...DRIVER, extra: 1 }).problems.length > 0);
    assert.ok(parse({ ...DRIVER, kind: 'NodeFlavor' }).problems.length > 0);
    assert.ok(parse({ ...DRIVER, version: 2 }).problems.length > 0);
    assert.ok(parse({ version: 1, kind: 'DnsProvider' }).problems.length > 0);
  });

  it('says where a value cannot come from: an undeclared parameter, a later step, a secret in a result', () => {
    const op = DRIVER.operations.send;
    const bad = (change: Record<string, unknown>) =>
      parse({ ...DRIVER, operations: { send: { ...op, ...change } } }).problems.join(' | ');
    assert.match(
      bad({
        steps: [
          {
            ...op.steps[0],
            request: { ...op.steps[0]?.request, url: 'https://api.example.com/{{ params.nope }}' },
          },
        ],
      }),
      /"params.nope" is not a declared parameter/u,
    );
    assert.match(
      bad({
        steps: [
          {
            ...op.steps[0],
            request: {
              ...op.steps[0]?.request,
              url: 'https://api.example.com/{{ steps.later.json.x }}',
            },
          },
        ],
      }),
      /"steps.later" is not an earlier step/u,
    );
    assert.match(
      bad({ result: { token: '{{ secret.botToken }}' } }),
      /a secret may be used in a request only/u,
    );
    assert.match(
      bad({ result: { x: '{{ nothing.here }}' } }),
      /"nothing" is not a place a value can come from/u,
    );
    assert.match(
      bad({ result: { x: '{{ params.message | shout }}' } }),
      /"shout" is not a filter/u,
    );
    assert.match(bad({ result: { x: '{{ params.message ' } }), /is not closed/u);
    assert.match(bad({ result: { x: '{{ params..message }}' } }), /is not a path/u);
    assert.match(bad({ result: { x: 5 } }), /^$/u, 'a literal is fine');
  });

  it('checks the shape of an each, and that its variable is used only inside it', () => {
    const op = DRIVER.operations.send;
    const withResult = (result: unknown) =>
      parse({ ...DRIVER, operations: { send: { ...op, result } } });
    assert.deepEqual(
      withResult({
        items: { each: 'steps.call.json.result', as: 'item', map: { id: '{{ item.id }}' } },
      }).problems,
      [],
    );
    assert.match(
      withResult({
        items: { each: 'steps.call.json.result', as: 'item', map: { id: '{{ other.id }}' } },
      }).problems.join(),
      /"other" is not a place/u,
    );
    assert.match(
      withResult({ items: { each: 'steps.call.json.result', map: {} } }).problems.join(),
      /exactly "each"/u,
    );
    assert.match(withResult({ id: '{{ item.id }}' }).problems.join(), /"item" is not a place/u);
  });

  it('refuses a step id that is used twice and templates that are too long', () => {
    const step = DRIVER.operations.send.steps[0];
    const twice = parse({
      ...DRIVER,
      operations: { send: { ...DRIVER.operations.send, steps: [step, step] } },
    });
    assert.match(twice.problems.join(), /used twice/u);
    assert.throws(() => parseTemplate('x'.repeat(2001)), DriverError);
  });
});

describe('the hosts and settings a driver uses', () => {
  const manifest = (extra: Record<string, unknown> = {}) =>
    PluginManifestSchema.parse({
      id: 'notify-example',
      version: '1.0.0',
      name: 'Notify',
      engines: { swellwright: '>=0.0.0-0 <1' },
      provides: [{ kind: 'NotificationChannel', driver: 'driver.yaml' }],
      permissions: { network: ['api.example.com:443'], secrets: ['telegram'] },
      config: { schema: 'config.schema.json' },
      license: 'AGPL-3.0-only',
      ...extra,
    });
  const schema = ConfigSchemaFileSchema.parse({
    type: 'object',
    properties: {
      chatId: { type: 'string' },
      botToken: { type: 'string', 'x-sw-secret': 'telegram' },
    },
  });

  it('lists the host:port pairs a driver calls, and needs them literal', () => {
    assert.deepEqual(driverHosts(sound(DRIVER)), { hosts: ['api.example.com:443'], problems: [] });
    const dynamic = sound({
      ...DRIVER,
      operations: {
        send: {
          ...DRIVER.operations.send,
          steps: [{ id: 'call', request: { url: 'https://{{ config.chatId }}/x' } }],
        },
      },
    });
    assert.match(driverHosts(dynamic).problems.join(), /host written out/u);
    const port = sound({
      ...DRIVER,
      operations: {
        send: {
          ...DRIVER.operations.send,
          steps: [{ id: 'call', request: { url: 'https://Api.Example.com:8443/x' } }],
        },
      },
    });
    assert.deepEqual(driverHosts(port).hosts, ['api.example.com:8443']);
    const plain = sound({
      ...DRIVER,
      operations: {
        send: {
          ...DRIVER.operations.send,
          steps: [{ id: 'call', request: { url: 'http://api.example.com/x' } }],
        },
      },
    });
    assert.match(driverHosts(plain).problems.join(), /https:\/\//u);
  });

  it('accepts a driver that matches its plugin', () => {
    assert.deepEqual(checkDriverAgainstPlugin(sound(DRIVER), manifest(), schema), []);
  });

  it('does not treat a literal each field in a request body as a reference to a setting', () => {
    const driver = sound({
      ...DRIVER,
      operations: {
        send: {
          steps: [
            {
              id: 'call',
              request: {
                url: 'https://api.example.com/send',
                body: { each: 'config.notASetting' },
              },
            },
          ],
        },
      },
    });
    assert.deepEqual(checkDriverAgainstPlugin(driver, manifest(), schema), []);
  });

  it('finds the host the manifest does not ask for, a missing setting, a secret that is not one, a wrong kind', () => {
    const driver = sound(DRIVER);
    assert.match(
      checkDriverAgainstPlugin(
        driver,
        manifest({ permissions: { network: [], secrets: ['telegram'] } }),
        schema,
      ).join(),
      /calls api.example.com:443, which the manifest does not ask for/u,
    );
    assert.match(
      checkDriverAgainstPlugin(
        driver,
        manifest(),
        ConfigSchemaFileSchema.parse({
          type: 'object',
          properties: { botToken: { type: 'string', 'x-sw-secret': 'telegram' } },
        }),
      ).join(),
      /"config.chatId" is not a setting/u,
    );
    assert.match(
      checkDriverAgainstPlugin(
        driver,
        manifest(),
        ConfigSchemaFileSchema.parse({
          type: 'object',
          properties: { chatId: { type: 'string' }, botToken: { type: 'string' } },
        }),
      ).join(),
      /"secret.botToken" is not a setting of the plugin that holds a secret/u,
    );
    assert.match(
      checkDriverAgainstPlugin(
        driver,
        manifest({ provides: [{ kind: 'DnsProvider', driver: 'driver.yaml' }] }),
        schema,
      ).join(),
      /does not give a driver for/u,
    );
    assert.match(
      checkDriverAgainstPlugin(driver, manifest(), undefined).join(),
      /"config.chatId"/u,
    );
  });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeServices(
  answers: { status?: number; headers?: Record<string, string>; body?: unknown }[],
  options: {
    settings?: Record<string, string | number | boolean | null>;
    secrets?: Record<string, string>;
  } = {},
): { services: DriverServices; calls: Call[]; secretsAsked: string[] } {
  const calls: Call[] = [];
  const secretsAsked: string[] = [];
  let next = 0;
  return {
    calls,
    secretsAsked,
    services: {
      settings: () => Promise.resolve(options.settings ?? { chatId: '42' }),
      secret: (field) => {
        secretsAsked.push(field);
        const value = (options.secrets ?? { botToken: '123:ABC-def' })[field];
        return value === undefined
          ? Promise.reject(new Error('no secret'))
          : Promise.resolve(value);
      },
      fetch: (url, init) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body });
        const answer = answers[next++] ?? { status: 200, body: {} };
        return Promise.resolve({
          status: answer.status ?? 200,
          headers: answer.headers ?? { 'content-type': 'application/json' },
          body: typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}),
        });
      },
    },
  };
}

describe('running an operation', () => {
  const driver = sound(DRIVER);

  it('makes the request the driver describes and builds the result from the answer', async () => {
    const { services, calls, secretsAsked } = fakeServices([
      { body: { ok: true, result: { message_id: 77 } } },
    ]);
    const result = await runOperation(driver, 'send', { message: 'hello <world>' }, services);
    assert.deepEqual(result, { ok: true, messageId: 77 }, 'a whole expression keeps its type');
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, 'POST');
    assert.equal(
      call.url,
      'https://api.example.com/bot123:ABC-def/sendMessage',
      'raw leaves the token as it is',
    );
    assert.equal(call.headers['accept'], 'application/json', 'header names in lower case');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body ?? ''), {
      chat_id: '42',
      text: 'hello <world>',
      disable_notification: false,
    });
    assert.deepEqual(secretsAsked, ['botToken']);
  });

  it('checks the parameters: required, unknown, wrong type, too long, enum, defaults', async () => {
    const { services } = fakeServices([{}]);
    const refused = (given: unknown) => runOperation(driver, 'send', given, services);
    await assert.rejects(refused({}), /the parameter "message" is required/u);
    await assert.rejects(refused({ message: 'x', extra: 1 }), /"extra" is not a parameter/u);
    await assert.rejects(refused({ message: 5 }), /"message" must be text/u);
    await assert.rejects(refused({ message: 'x'.repeat(4097) }), /at most 4096 characters/u);
    await assert.rejects(refused({ message: 'x', silent: 'yes' }), /must be true or false/u);
    await assert.rejects(refused('text'), /the parameters are an object/u);
    await assert.rejects(runOperation(driver, 'nothing', {}, services), /no operation "nothing"/u);
    await assert.rejects(runOperation(driver, 'toString', {}, services), /no operation/u);
  });

  it('encodes what goes into a URL, so a value cannot add a segment or a query', async () => {
    const lookup = sound({
      version: 1,
      kind: 'DnsProvider',
      operations: {
        records: {
          params: { zone: { type: 'string', required: true }, name: { type: 'string' } },
          steps: [
            {
              id: 'list',
              request: {
                url: 'https://api.example.com/zones/{{ params.zone }}/records?name={{ params.name }}',
              },
            },
          ],
          result: { count: '{{ steps.list.status }}' },
        },
      },
    });
    const { services, calls } = fakeServices([{ body: {} }]);
    await runOperation(lookup, 'records', { zone: '../admin/x?y=1#z', name: 'a&b=c' }, services);
    assert.equal(
      calls[0]?.url,
      'https://api.example.com/zones/..%2Fadmin%2Fx%3Fy%3D1%23z/records?name=a%26b%3Dc',
    );
  });

  it('reads earlier steps in later ones and maps lists with each', async () => {
    const two = sound({
      version: 1,
      kind: 'DnsProvider',
      operations: {
        zones: {
          steps: [
            {
              id: 'login',
              request: {
                method: 'POST',
                url: 'https://api.example.com/token',
                body: 'user={{ config.user | urlencode }}',
              },
            },
            {
              id: 'list',
              request: {
                url: 'https://api.example.com/zones',
                headers: { Authorization: 'Bearer {{ steps.login.json.token }}' },
              },
            },
          ],
          result: {
            zones: {
              each: 'steps.list.json.items',
              as: 'zone',
              map: { id: '{{ zone.id }}', name: '{{ zone.name }}' },
            },
            count: '{{ steps.list.status }}',
          },
        },
      },
    });
    const { services, calls } = fakeServices(
      [
        { body: { token: 'T0K' } },
        {
          body: {
            items: [
              { id: 1, name: 'a.example', extra: 'x' },
              { id: 2, name: 'b.example' },
            ],
          },
        },
      ],
      { settings: { user: 'a b' } },
    );
    const result = await runOperation(two, 'zones', null, services);
    assert.deepEqual(result, {
      zones: [
        { id: 1, name: 'a.example' },
        { id: 2, name: 'b.example' },
      ],
      count: 200,
    });
    assert.equal(calls[0]?.body, 'user=a%20b', 'a text body is sent as it is');
    assert.equal(calls[1]?.headers['authorization'], 'Bearer T0K');
  });

  it('says what went wrong: an unexpected status with what the service said, a value that is not there', async () => {
    const { services } = fakeServices([
      { status: 401, body: { description: 'Unauthorized: bot token revoked' } },
    ]);
    await assert.rejects(
      runOperation(driver, 'send', { message: 'x' }, services),
      /The service answered 401: Unauthorized: bot token revoked/u,
    );
    const { services: second } = fakeServices([{ body: { ok: true } }]);
    await assert.rejects(
      runOperation(driver, 'send', { message: 'x' }, second),
      /"steps.call.json.result.message_id" has no value/u,
    );
    const { services: third } = fakeServices([{ status: 500, body: 'not json at all' }]);
    await assert.rejects(
      runOperation(driver, 'send', { message: 'x' }, third),
      /The service answered 500$/u,
    );
  });

  it('does not leak a secret into an error or a result, and fails when a secret is missing', async () => {
    const { services } = fakeServices([{ status: 401, body: { description: 'denied' } }]);
    try {
      await runOperation(driver, 'send', { message: 'x' }, services);
    } catch (error) {
      assert.equal((error as Error).message.includes('123:ABC'), false);
    }
    const { services: none } = fakeServices([{}], { secrets: {} });
    await assert.rejects(runOperation(driver, 'send', { message: 'x' }, none), /no secret/u);
  });

  it('returns the status when the driver gives no result, and refuses a result that is too large', async () => {
    const plain = sound({
      version: 1,
      kind: 'NotificationChannel',
      operations: {
        ping: { steps: [{ id: 'a', request: { url: 'https://api.example.com/ping' } }] },
      },
    });
    const { services } = fakeServices([{ status: 204, body: '' }]);
    assert.deepEqual(await runOperation(plain, 'ping', null, services), { status: 204 });
    const big = sound({
      version: 1,
      kind: 'NotificationChannel',
      operations: {
        all: {
          steps: [{ id: 'a', request: { url: 'https://api.example.com/all' } }],
          result: { body: '{{ steps.a.text }}' },
        },
      },
    });
    const { services: large } = fakeServices([{ body: 'x'.repeat(1024 * 1024 + 10) }]);
    await assert.rejects(runOperation(big, 'all', null, large), /too large/u);
  });

  const listing = (result: unknown): Driver =>
    sound({
      version: 1,
      kind: 'DnsProvider',
      operations: {
        all: { steps: [{ id: 'a', request: { url: 'https://api.example.com/all' } }], result },
      },
    });

  it('stops building a result that expands past its budget, before it is built', async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ id: i }));
    // Each item of a list mapped over the same list again: 90 000 parts from a small answer.
    const nested = listing({
      rows: {
        each: 'steps.a.json.items',
        as: 'row',
        map: { each: 'steps.a.json.items', as: 'col', map: '{{ col.id }}' },
      },
    });
    const { services } = fakeServices([{ body: { items } }]);
    await assert.rejects(runOperation(nested, 'all', null, services), /more than 20000 parts/u);
    // A large answer put into many places is stopped as it adds up, not after it was all made.
    const copies = listing({
      rows: { each: 'steps.a.json.items', as: 'row', map: '{{ steps.a.text }}' },
    });
    const { services: wide } = fakeServices([{ body: { items, pad: 'x'.repeat(64 * 1024) } }]);
    await assert.rejects(runOperation(copies, 'all', null, wide), /too large/u);
    // Long names of the keys of a mapped object count as well.
    const named = listing({
      rows: { each: 'steps.a.json.items', as: 'row', map: { [`k${'x'.repeat(10_000)}`]: 1 } },
    });
    const { services: keyed } = fakeServices([{ body: { items } }]);
    await assert.rejects(runOperation(named, 'all', null, keyed), /too large/u);
    // Within the budget a loop is built as before.
    const { services: small } = fakeServices([{ body: { items: items.slice(0, 3) } }]);
    assert.deepEqual(await runOperation(nested, 'all', null, small), {
      rows: [
        [0, 1, 2],
        [0, 1, 2],
        [0, 1, 2],
      ],
    });
  });

  it('treats each in a request body as a key, the way the body was checked', async () => {
    const posting = sound({
      version: 1,
      kind: 'NotificationChannel',
      operations: {
        post: {
          steps: [
            {
              id: 'a',
              request: {
                method: 'POST',
                url: 'https://api.example.com/post',
                body: { each: 'steps.x.json', as: 'item', map: 'plain' },
              },
            },
          ],
        },
      },
    });
    const { services, calls } = fakeServices([{}]);
    await runOperation(posting, 'post', null, services);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), {
      each: 'steps.x.json',
      as: 'item',
      map: 'plain',
    });
  });

  it('sends no further step once the operation is ended', async () => {
    const steps = sound({
      version: 1,
      kind: 'NotificationChannel',
      operations: {
        two: {
          steps: [
            { id: 'a', request: { url: 'https://api.example.com/a' } },
            { id: 'b', request: { method: 'POST', url: 'https://api.example.com/b' } },
          ],
        },
      },
    });
    const controller = new AbortController();
    const { services, calls } = fakeServices([{}, {}]);
    const ending: DriverServices = {
      ...services,
      fetch: async (url, init) => {
        const answer = await services.fetch(url, init);
        // The deadline passes while the first answer comes back.
        controller.abort();
        return answer;
      },
    };
    await assert.rejects(runOperation(steps, 'two', null, ending, controller.signal));
    assert.equal(calls.length, 1, 'the second request was never sent');
  });

  it('does not take what every object has for a parameter that was not given', async () => {
    const named = sound({
      version: 1,
      kind: 'NotificationChannel',
      operations: {
        send: {
          params: { constructor: { type: 'string' }, toString: { type: 'string' } },
          steps: [{ id: 'a', request: { url: 'https://api.example.com/{{ params.toString }}' } }],
        },
      },
    });
    const { services } = fakeServices([{}]);
    await assert.rejects(runOperation(named, 'send', {}, services), /has no value/u);
    const { services: given, calls } = fakeServices([{}]);
    await runOperation(named, 'send', { toString: 'x' }, given);
    assert.equal(calls[0]?.url, 'https://api.example.com/x');
  });
});
