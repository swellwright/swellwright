import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consoleCatalogue } from './catalogue.js';
import { ConsoleRequestError, prepareConsoleRequest } from './request.js';

const catalogue = consoleCatalogue();
const operation = (id: string) => {
  const found = catalogue.find(id);
  assert.ok(found, id);
  return found;
};
const UUID = '00000000-0000-4000-8000-000000000101';
/** The character a URL with credentials has before its host; kept out of the literals. */
const AT = '@';

/** The messages of the issues a bad request is refused with, by field. */
function refused(id: string, input: Parameters<typeof prepareConsoleRequest>[1]): string {
  try {
    prepareConsoleRequest(operation(id), input);
  } catch (error) {
    assert.ok(error instanceof ConsoleRequestError, String(error));
    return error.issues.map((i) => `${i.path} ${i.message}`).join(' | ');
  }
  assert.fail(`${id} accepted ${JSON.stringify(input)}`);
}

describe('preparing a request of the console', () => {
  it('fills a path from a checked value and keeps the origin of the panel out of it', () => {
    const prepared = prepareConsoleRequest(operation('NodesController_getNode'), {
      pathParams: { uuid: UUID },
    });
    assert.equal(prepared.pathAndQuery, `/api/nodes/${UUID}`);
    assert.deepEqual(prepared.queryKeys, []);
    assert.equal(
      prepareConsoleRequest(operation('NodesController_getNodes'), {}).pathAndQuery,
      '/api/nodes',
    );
  });

  it('writes the query from the parameters of the description, in their order, encoded', () => {
    const prepared = prepareConsoleRequest(operation('UsersController_getUsers'), {
      query: { size: 10, start: '5' },
    });
    assert.equal(prepared.pathAndQuery, '/api/users?start=5&size=10');
    assert.deepEqual(prepared.queryKeys, ['start', 'size']);
    const search = prepareConsoleRequest(operation('UsersController_getUsersStream'), {
      query: { email: 'a+b@example.com', tag: 'x y&z=1' },
    });
    assert.equal(
      search.pathAndQuery,
      '/api/users/stream?email=a%2Bb%40example.com&tag=x+y%26z%3D1',
    );
  });

  it('treats an empty or missing optional parameter as not sent', () => {
    const prepared = prepareConsoleRequest(operation('UsersController_getUsers'), {
      query: { start: '', size: null },
    });
    assert.equal(prepared.pathAndQuery, '/api/users');
  });

  it('asks for what is required, and says so for every missing field at once', () => {
    assert.match(refused('NodesController_getNode', {}), /pathParams\.uuid is required/u);
    const range = refused('BandwidthStatsNodesController_getStatsNodeUsersUsage', {});
    assert.match(range, /pathParams\.uuid is required/u);
    assert.match(range, /query\.start is required/u);
    assert.match(range, /query\.end is required/u);
  });

  it('refuses a parameter the operation does not have, in the path or the query', () => {
    assert.match(
      refused('NodesController_getNodes', { query: { refresh: 'true' } }),
      /query\.refresh is not a parameter/u,
    );
    assert.match(
      refused('NodesController_getNode', { pathParams: { uuid: UUID, extra: '1' } }),
      /pathParams\.extra is not a parameter/u,
    );
    // A key that is a prototype name is an unknown parameter like any other.
    const hostile = JSON.parse('{"__proto__":"x","constructor":"y"}') as Record<string, unknown>;
    assert.match(refused('NodesController_getNodes', { query: hostile }), /not a parameter/u);
  });

  it('refuses a UUID that is not one, whatever it carries', () => {
    for (const bad of [
      'not-a-uuid',
      `${UUID}/../x`,
      `${UUID}?x=1`,
      `../${UUID}`,
      '00000000-0000-4000-8000-00000000010',
      `${UUID} `,
      '',
    ]) {
      assert.match(
        refused('NodesController_getNode', { pathParams: { uuid: bad } }),
        /pathParams\.uuid/u,
        JSON.stringify(bad),
      );
    }
  });

  it('refuses a path segment that could name another path, a host or an escape', () => {
    for (const bad of [
      '..',
      '.',
      'a..b',
      'a/b',
      'a\\b',
      '%2e%2e',
      '%2e%2e%2f',
      'a%2fb',
      'a%00',
      'a b',
      'a?x=1',
      'a#x',
      `user${AT}evil.example.com`,
      'evil.example.com:443',
      '//evil.example.com',
      'https://evil.example.com',
      'a;b',
      '',
      'x'.repeat(257),
    ]) {
      assert.match(
        refused('UsersController_getUserByUsername', { pathParams: { username: bad } }),
        /pathParams\.username/u,
        JSON.stringify(bad),
      );
    }
    const fine = prepareConsoleRequest(operation('UsersController_getUserByUsername'), {
      pathParams: { username: 'fake-user_1.test' },
    });
    assert.equal(fine.pathAndQuery, '/api/users/by-username/fake-user_1.test');
  });

  it('refuses a number that is not a plain number, and one outside what the description allows', () => {
    for (const bad of [
      '1e3',
      '0x10',
      'NaN',
      'Infinity',
      '12345678901234567890',
      '1,5',
      ' 5',
      '-',
      '5.',
    ]) {
      assert.match(
        refused('UsersController_getUsers', { query: { start: bad } }),
        /query\.start/u,
        bad,
      );
    }
    assert.match(refused('UsersController_getUsers', { query: { size: 0 } }), /at least 1/u);
    assert.match(refused('UsersController_getUsers', { query: { size: 5000 } }), /at most 1000/u);
    assert.match(
      refused('UsersController_getUsers', { query: { size: Number.POSITIVE_INFINITY } }),
      /query\.size/u,
    );
    assert.match(
      refused('UsersController_getUsers', { query: { size: Number.NaN } }),
      /query\.size/u,
    );
    // An identifier in a path is a whole positive number.
    for (const bad of ['-1', '1.5', '1e2', '0x1']) {
      assert.match(
        refused('UsersController_getUserById', { pathParams: { userId: bad } }),
        /pathParams\.userId/u,
        bad,
      );
    }
    assert.equal(
      prepareConsoleRequest(operation('UsersController_getUserById'), {
        pathParams: { userId: 42 },
      }).pathAndQuery,
      '/api/users/42',
    );
  });

  it('refuses a value of the wrong type, or one that is not a plain value', () => {
    for (const bad of [{}, [], ['1'], { a: 1 }]) {
      assert.match(
        refused('UsersController_getUsers', { query: { size: bad } }),
        /must be a string, a number or a boolean/u,
      );
    }
    assert.match(
      refused('UsersController_getUsersStream', { query: { status: 'ROOT' } }),
      /must be one of ACTIVE/u,
    );
  });

  it('checks dates, date-times and emails', () => {
    const base = { pathParams: { uuid: UUID } };
    const ok = prepareConsoleRequest(
      operation('BandwidthStatsNodesController_getStatsNodeUsersUsage'),
      {
        ...base,
        query: { start: '2026-01-31', end: '2026-02-28' },
      },
    );
    assert.equal(
      ok.pathAndQuery,
      `/api/bandwidth-stats/nodes/${UUID}/users?start=2026-01-31&end=2026-02-28`,
    );
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '26-01-01',
      '2026-01-01T00:00:00Z',
      'yesterday',
      '2026-1-1',
    ]) {
      assert.match(
        refused('BandwidthStatsNodesController_getStatsNodeUsersUsage', {
          ...base,
          query: { start: bad, end: '2026-02-28' },
        }),
        /query\.start must be a date/u,
        bad,
      );
    }
    const digest = 'SystemController_getStatsDigest';
    assert.equal(
      prepareConsoleRequest(operation(digest), {
        query: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00.500+02:00' },
      }).queryKeys.length,
      2,
    );
    for (const bad of ['2026-01-01', '2026-01-01T25:00:00Z', '2026-01-01T00:00:00', 'now']) {
      assert.match(
        refused(digest, { query: { start: bad, end: '2026-01-02T00:00:00Z' } }),
        /query\.start/u,
        bad,
      );
    }
    for (const bad of ['no-at-sign', 'a@b c', '@x.example.com', 'a@']) {
      assert.match(
        refused('UsersController_getUsersStream', { query: { email: bad } }),
        /query\.email must be an email/u,
        bad,
      );
    }
  });

  it('refuses a value with a control character, which is how a header or a line is injected', () => {
    for (const bad of [
      'a\r\nX-Injected: 1',
      'a\nb',
      'a\u0000b',
      'a\u0085b',
      `a${String.fromCharCode(0x2028)}b`,
      'tab\there'.replace('\t', '\u0009'),
    ]) {
      assert.match(
        refused('UsersController_getUsersStream', { query: { tag: bad } }),
        /control character/u,
        JSON.stringify(bad),
      );
    }
    assert.match(
      refused('UsersController_getUsersStream', { query: { tag: 'x'.repeat(300) } }),
      /longer than 256/u,
    );
  });

  it('keeps a host smuggled through a parameter in the query, where it is only text', () => {
    const prepared = prepareConsoleRequest(operation('UsersController_getUsersStream'), {
      query: { tag: 'https://evil.example.com/x?y=1', telegramId: '@evil.example.com' },
    });
    assert.equal(
      new URL(`https://panel.example.com${prepared.pathAndQuery}`).host,
      'panel.example.com',
    );
    assert.ok(prepared.pathAndQuery.startsWith('/api/users/stream?'));
  });

  it('refuses a parameter the console does not send: the table state of the panel pages', () => {
    assert.match(
      refused('UsersController_getUsers', { query: { filters: [{ id: 'a', value: 'b' }] } }),
      /query\.filters must be a string, a number or a boolean/u,
    );
    assert.match(
      refused('UsersController_getUsers', { query: { filters: '[{"id":"a","value":"b"}]' } }),
      /structured parameter/u,
    );
  });

  it('never prepares an operation that is not a read', () => {
    const write = catalogue.operations.find((o) => o.method === 'post');
    assert.ok(write);
    assert.throws(() => prepareConsoleRequest(write, {}), ConsoleRequestError);
    for (const operation of catalogue.operations.filter((o) => o.method !== 'get')) {
      assert.throws(
        () => prepareConsoleRequest(operation, {}),
        ConsoleRequestError,
        operation.operationId,
      );
    }
  });

  it('prepares every read of the catalogue that needs nothing from a person, to a path under /api/', () => {
    const samples: Record<string, unknown> = {
      uuid: UUID,
      squadUuid: UUID,
      userId: 7,
      username: 'fake-user',
      shortUuid: 'FAKE-SHORT',
      jobId: 'job-1',
      clientType: 'json',
      start: '2026-01-01',
      end: '2026-01-02',
    };
    let prepared = 0;
    for (const op of catalogue.operations.filter((o) => o.method === 'get')) {
      const pathParams: Record<string, unknown> = {};
      const query: Record<string, unknown> = {};
      for (const param of op.parameters) {
        if (param.required) {
          const value =
            param.name === 'start' && param.format === 'date-time'
              ? '2026-01-01T00:00:00Z'
              : param.name === 'end' && param.format === 'date-time'
                ? '2026-01-02T00:00:00Z'
                : param.name === 'name' || param.name === 'tz'
                  ? 'x'
                  : samples[param.name];
          (param.in === 'path' ? pathParams : query)[param.name] = value;
        }
      }
      const result = prepareConsoleRequest(op, { pathParams, query });
      assert.ok(result.pathAndQuery.startsWith('/api/'), op.operationId);
      assert.ok(!result.pathAndQuery.includes('{'), op.operationId);
      prepared += 1;
    }
    assert.equal(prepared, 94);
  });
});
