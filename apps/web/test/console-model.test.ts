import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, it } from 'node:test';

import type { PanelConsoleOperation, PanelConsoleResult } from '@swellwright/contracts';

import {
  addHistory,
  addSample,
  canKeepSample,
  clearHistory,
  curlOf,
  forgetLegacyStorage,
  historyEntryOf,
  LEGACY_KEYS,
  readHistory,
  readSamples,
  shellQuote,
  submissionOf,
} from '../src/panel/api-console/console-model.js';

/** localStorage of a browser, in memory. */
class MemoryStorage {
  #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#items.delete(key);
  }
  setItem(key: string, value: string) {
    this.#items.set(key, value);
  }
  keys() {
    return [...this.#items.keys()];
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
  writable: true,
});

function operation(
  operationId: string,
  availability: PanelConsoleOperation['availability'],
  path = '/api/users/by-short-uuid/{shortUuid}',
): PanelConsoleOperation {
  return {
    operationId,
    method: 'get',
    path,
    group: 'Users',
    summary: operationId,
    description: null,
    availability,
    blockedReason: null,
    adminOnly: false,
    publicEndpoint: false,
    scopes: [],
    deprecated: false,
    parameters: [
      {
        name: 'shortUuid',
        in: 'path',
        required: true,
        description: null,
        kind: 'string',
        format: null,
        enum: null,
        minimum: null,
        maximum: null,
        default: null,
      },
    ],
    hasRequestBody: false,
    responseContentTypes: ['application/json'],
  };
}

function answer(
  operationId: string,
  maskProfile: PanelConsoleResult['maskProfile'] = 'standard',
): PanelConsoleResult {
  return {
    operationId,
    method: 'get',
    path: '/x',
    status: 200,
    durationMs: 12,
    attempts: 1,
    headers: {},
    contentType: 'application/json',
    bodyFormat: 'json',
    body: '{}',
    bodyBytes: 2,
    truncated: false,
    masked: false,
    maskedCount: 0,
    maskProfile,
    sentAt: '2026-11-26T10:00:00.000Z',
  };
}

const people = operation('UsersController_getUserByShortUuid', 'user_data');
const health = operation('SystemController_getRemnawaveHealth', 'open', '/api/system/health');
const CREDENTIAL = 'Ab12Cd34';

beforeEach(() => {
  storage.clear();
});

describe('a request of the API console, as it was sent', () => {
  it('keeps no values of a request about people, even if another operation is chosen before the answer', () => {
    // Sent while the people operation was chosen; the person then picked an open operation.
    const submitted = submissionOf(
      people,
      { operationId: people.operationId, pathParams: { shortUuid: CREDENTIAL } },
      1,
    );
    const chosenNow = health;
    assert.notEqual(chosenNow.availability, submitted.availability);

    for (const outcome of [
      { answer: answer(people.operationId, 'personal') },
      { errorCode: 'panel_timeout', at: '2026-11-26T10:00:00.000Z' },
    ]) {
      const entry = historyEntryOf(submitted, outcome, 'id');
      assert.equal(entry.request, null);
      assert.equal(entry.operationId, people.operationId, 'recorded as what was asked');
      addHistory('alice', entry);
    }
    assert.ok(!JSON.stringify(storage.keys().map((k) => storage.getItem(k))).includes(CREDENTIAL));
  });

  it('keeps the values of an ordinary request', () => {
    const request = { operationId: health.operationId, query: { verbose: 'true' } };
    const entry = historyEntryOf(
      submissionOf(health, request, 1),
      { answer: answer(health.operationId) },
      'id',
    );
    assert.deepEqual(entry.request, request);
    assert.equal(entry.status, 200);
  });

  it('never lets an answer about people be kept as a sample', () => {
    const peopleSubmission = submissionOf(people, { operationId: people.operationId }, 1);
    assert.equal(canKeepSample(peopleSubmission, answer(people.operationId, 'standard')), false);
    assert.equal(canKeepSample(peopleSubmission, answer(people.operationId, 'personal')), false);
    const open = submissionOf(health, { operationId: health.operationId }, 1);
    assert.equal(canKeepSample(open, answer(health.operationId, 'standard')), true);
    assert.equal(canKeepSample(open, answer(health.operationId, 'personal')), false);
  });
});

describe('what the browser keeps for the API console', () => {
  it('keeps the history and the samples of each account apart', () => {
    const entry = historyEntryOf(
      submissionOf(health, { operationId: health.operationId }, 1),
      { answer: answer(health.operationId) },
      'h1',
    );
    addHistory('alice', entry);
    addSample('alice', {
      id: 's1',
      name: 'health',
      savedAt: '2026-11-26T10:00:00.000Z',
      operationId: health.operationId,
      path: health.path,
      request: { operationId: health.operationId },
      result: {
        status: 200,
        bodyFormat: 'json',
        body: '{}',
        bodyBytes: 2,
        truncated: false,
        maskedCount: 0,
        durationMs: 1,
      },
    });
    assert.equal(readHistory('alice').length, 1);
    assert.equal(readSamples('alice').length, 1);
    assert.deepEqual(readHistory('bob'), []);
    assert.deepEqual(readSamples('bob'), []);
    clearHistory('bob');
    assert.equal(readHistory('alice').length, 1, "clearing Bob's history leaves Alice's");
  });

  it('removes what was kept before it was per account', () => {
    for (const key of LEGACY_KEYS) {
      storage.setItem(key, '[]');
    }
    forgetLegacyStorage();
    assert.deepEqual(storage.keys(), []);
  });
});

describe('Copy as curl', () => {
  it('quotes the whole URL as one literal shell word', () => {
    const base = 'https://panel.example.com/p$(touch pwned)`id`\'"$HOME';
    const command = curlOf(health, { operationId: health.operationId }, base);
    assert.ok(command.endsWith(shellQuote(`${base}/api/system/health`)));
    assert.ok(command.includes('"Authorization: Bearer $PANEL_TOKEN"'));
  });

  it(
    'gives the shell exactly the URL back',
    { skip: process.platform === 'win32' ? 'needs a POSIX sh' : false },
    () => {
      for (const value of ['plain', "it's", "a'b'c", '$(id) `id` "q" \\ $HOME', "''"]) {
        const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`], {
          encoding: 'utf8',
        });
        assert.equal(out, value);
      }
    },
  );

  it('writes a quote inside the word in the POSIX way', () => {
    assert.equal(shellQuote("a'b"), "'a'\\''b'");
    assert.equal(shellQuote(''), "''");
  });
});
