import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildConsoleCatalogue, consoleCatalogue, groupOf, type RawSpec } from './catalogue.js';
import { must } from '../test-support/index.js';
import { BLOCKED_OPERATIONS, USER_DATA_OPERATIONS } from './policy.js';

const SPEC = JSON.parse(
  readFileSync(new URL('../../spec/remnawave-api-3.4.11.json', import.meta.url), 'utf8'),
) as RawSpec;

describe('the operation catalogue', () => {
  const catalogue = consoleCatalogue();

  it('is built from the frozen description of 3.4.11 and holds every operation of it', () => {
    assert.equal(catalogue.specVersion, '3.4.11');
    let operations = 0;
    for (const item of Object.values(SPEC.paths ?? {})) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        if (item[method] !== undefined) {
          operations += 1;
        }
      }
    }
    assert.equal(catalogue.operations.length, operations);
    assert.equal(
      catalogue.operations.length,
      new Set(catalogue.operations.map((o) => o.operationId)).size,
    );
  });

  it('has the counts this release was judged against (a new description must be judged again)', () => {
    // 218 operations: 94 reads (59 open, 28 about people, 7 blocked) and 124 that are not reads.
    assert.deepEqual(catalogue.counts, {
      total: 218,
      get: 94,
      open: 59,
      userData: 28,
      blocked: 7,
      write: 124,
    });
  });

  it('offers nothing that is not a GET as sendable', () => {
    for (const operation of catalogue.operations) {
      if (operation.method === 'get') {
        assert.notEqual(operation.availability, 'write', operation.operationId);
      } else {
        assert.equal(operation.availability, 'write', `${operation.operationId} must stay greyed`);
        assert.equal(operation.blockedReason, null);
      }
    }
    assert.equal(
      catalogue.operations
        .filter((o) => o.availability !== 'write')
        .every((o) => o.method === 'get'),
      true,
    );
  });

  it('names a real GET for every operation the policy lists, so a list cannot go stale', () => {
    const reads = new Set(
      catalogue.operations.filter((o) => o.method === 'get').map((o) => o.operationId),
    );
    for (const id of [...Object.keys(BLOCKED_OPERATIONS), ...USER_DATA_OPERATIONS]) {
      assert.ok(reads.has(id), `${id} is not a GET of the description`);
    }
    for (const id of Object.keys(BLOCKED_OPERATIONS)) {
      assert.ok(!USER_DATA_OPERATIONS.has(id), `${id} is both blocked and about people`);
    }
  });

  it('keeps keys, subscription content and challenges out of reach', () => {
    const blocked = catalogue.operations.filter((o) => o.availability === 'blocked');
    assert.deepEqual(blocked.map((o) => o.path).sort(), [
      '/api/auth/passkey/authentication/options',
      '/api/keygen',
      '/api/passkeys/registration/options',
      '/api/sub/{shortUuid}',
      '/api/sub/{shortUuid}/{clientType}',
      '/api/subscriptions/connection-keys/{userId}',
      '/api/system/tools/x25519/generate',
    ]);
    for (const operation of blocked) {
      assert.ok(
        operation.blockedReason === 'secret_material' || operation.blockedReason === 'side_effect',
      );
    }
  });

  it('leaves nothing open that asks for a person: no user, short UUID, name, mail or messenger id as a parameter', () => {
    const people = /^(userId|username|shortUuid|email|telegramId|squadUuid)$/u;
    for (const operation of catalogue.operations) {
      if (operation.availability !== 'open') {
        continue;
      }
      for (const param of operation.parameters) {
        // A squad is not a person; the one operation that reads users of a squad is in the user-data list.
        if (param.name !== 'squadUuid') {
          assert.ok(
            !people.test(param.name),
            `${operation.operationId} is open and takes ${param.name}`,
          );
        }
      }
    }
  });

  it('types the parameters from the description', () => {
    const nodeById = catalogue.find('NodesController_getNode');
    assert.ok(nodeById);
    assert.equal(nodeById.path, '/api/nodes/{uuid}');
    assert.equal(nodeById.group, 'Nodes');
    assert.deepEqual(
      nodeById.parameters.map((p) => [p.name, p.in, p.required, p.kind, p.format]),
      [['uuid', 'path', true, 'string', 'uuid']],
    );
    const users = catalogue.find('UsersController_getUsers');
    assert.ok(users);
    assert.equal(users.availability, 'user_data');
    const size = users.parameters.find((p) => p.name === 'size');
    assert.deepEqual(
      [size?.kind, size?.minimum, size?.maximum, size?.default],
      ['number', 1, 1000, 25],
    );
    // The table state of the panel's own pages is not something the console sends.
    assert.equal(users.parameters.find((p) => p.name === 'filters')?.kind, 'structured');
    assert.equal(users.parameters.find((p) => p.name === 'filterModes')?.kind, 'structured');
    const stream = catalogue.find('UsersController_getUsersStream');
    assert.deepEqual(stream?.parameters.find((p) => p.name === 'status')?.enum, [
      'ACTIVE',
      'DISABLED',
      'LIMITED',
      'EXPIRED',
    ]);
    const range = must(catalogue.find('BandwidthStatsNodesController_getStatsNodeUsersUsage'));
    const start = must(range.parameters.find((p) => p.name === 'start'));
    assert.equal(start.format, 'date');
    assert.equal(start.required, true);
  });

  it('marks what only an administrator session may call, and what the panel answers without a token', () => {
    assert.equal(catalogue.find('ApiTokensController_getApiTokens')?.adminOnly, true);
    assert.equal(catalogue.find('ApiTokensController_getScopes')?.adminOnly, true);
    assert.equal(catalogue.find('NodesController_getNodes')?.adminOnly, false);
    assert.equal(catalogue.find('AuthController_getStatus')?.publicEndpoint, true);
    assert.equal(catalogue.find('NodesController_getNodes')?.publicEndpoint, false);
    // The description names no scope today; the field is there for the release that does.
    assert.deepEqual(catalogue.find('NodesController_getNodes')?.scopes, []);
  });

  it('groups by the tag of the description without its "Controller"', () => {
    assert.equal(groupOf('Nodes Controller'), 'Nodes');
    assert.equal(groupOf('[Public] Subscription Controller'), 'Subscription (public)');
    assert.equal(groupOf('[Protected] Subscriptions Controller'), 'Subscriptions (protected)');
    assert.equal(groupOf(null), 'Other');
    const groups = new Set(catalogue.operations.map((o) => o.group));
    assert.ok(groups.has('Config Profiles') && groups.has('Hosts') && groups.has('System'));
    assert.ok(![...groups].some((g) => g.includes('Controller')));
  });

  it('writes a summary for an operation the description gives none', () => {
    for (const operation of catalogue.operations) {
      assert.ok(operation.summary.length > 0, operation.operationId);
    }
    assert.equal(
      catalogue.find('SubscriptionController_getSubscription')?.summary,
      'Get subscription',
    );
  });

  it('follows the references of the schemas in the detail, without looping on a recursive one', () => {
    const detail = catalogue.detail('NodesController_getNodes');
    assert.ok(detail);
    const text = JSON.stringify(detail.responseSchema);
    assert.ok(text.includes('"properties"'));
    assert.ok(!text.includes('"$ref":"#/'), 'a reference was left in the answer schema');
    assert.equal(detail.requestBodySchema, null);
    // A write lists the body it needs (greyed, but readable).
    const write = catalogue.operations.find((o) => o.method === 'post' && o.hasRequestBody);
    assert.ok(write);
    assert.notEqual(catalogue.detail(write.operationId)?.requestBodySchema, null);
    // Every detail serialises (no cycles) and stays a reasonable size.
    for (const operation of catalogue.operations) {
      const size = JSON.stringify(catalogue.detail(operation.operationId)).length;
      assert.ok(size < 2_500_000, `${operation.operationId} detail is ${String(size)} bytes`);
    }
    assert.equal(catalogue.detail('nope'), undefined);
  });

  it('refuses two operations with one id', () => {
    const twice = {
      paths: {
        '/api/a': { get: { operationId: 'A_get' } },
        '/api/b': { get: { operationId: 'A_get' } },
      },
    } as RawSpec;
    assert.throws(() => buildConsoleCatalogue(twice), /same id/u);
  });
});
