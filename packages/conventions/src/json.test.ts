import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonPatchOperation } from '@swellwright/contracts';

import {
  applyJsonPatch,
  canonicalJson,
  deepEqual,
  diffPaths,
  isMask,
  JsonPatchError,
  parsePointer,
  toPointer,
} from './json.js';

const patch = (doc: unknown, ...ops: JsonPatchOperation[]): unknown => applyJsonPatch(doc, ops);

describe('canonical JSON', () => {
  it('sorts keys at every level and has no white space', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }),
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
  it('writes -0 as 0 and leaves out what JSON has no value for', () => {
    assert.equal(canonicalJson({ a: -0, b: undefined }), '{"a":0}');
    assert.equal(canonicalJson(undefined), 'null');
  });
  it('compares by content, not by order', () => {
    assert.equal(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
    assert.equal(deepEqual([1, 2], [2, 1]), false);
    assert.equal(deepEqual({ a: 1 }, { a: '1' }), false);
  });
  it('knows a mask', () => {
    assert.equal(isMask('[masked]'), true);
    assert.equal(isMask('[masked:1a2b3c4d]'), true);
    assert.equal(isMask('[masked:zz]'), false);
    // The mask of a string that could not be read as a document is a mask too.
    assert.equal(isMask('[masked: unreadable document]'), true);
    assert.equal(isMask('[masked: anything else]'), false);
    assert.equal(isMask('masked'), false);
    assert.equal(isMask(5), false);
  });
});

describe('JSON Pointer', () => {
  it('splits, unescapes and joins', () => {
    assert.deepEqual(parsePointer(''), []);
    assert.deepEqual(parsePointer('/a/b'), ['a', 'b']);
    assert.deepEqual(parsePointer('/a~1b/c~0d'), ['a/b', 'c~d']);
    assert.equal(toPointer(['a/b', 'c~d']), '/a~1b/c~0d');
    assert.deepEqual(parsePointer('/'), ['']);
  });
  it('refuses what is not a pointer', () => {
    assert.throws(() => parsePointer('a/b'), JsonPatchError);
    assert.throws(() => parsePointer('/a~2'), JsonPatchError);
    assert.throws(
      () => parsePointer(`/${Array.from({ length: 40 }, () => 'a').join('/')}`),
      /deeper/u,
    );
  });
});

describe('JSON Patch', () => {
  const doc = { name: 'n', list: [1, 2, 3], nested: { a: { b: 1 } } };

  it('adds to an object and to an array, at the end with "-"', () => {
    assert.deepEqual(patch(doc, { op: 'add', path: '/x', value: 1 }), { ...doc, x: 1 });
    assert.deepEqual(
      (patch(doc, { op: 'add', path: '/list/1', value: 9 }) as typeof doc).list,
      [1, 9, 2, 3],
    );
    assert.deepEqual(
      (patch(doc, { op: 'add', path: '/list/-', value: 4 }) as typeof doc).list,
      [1, 2, 3, 4],
    );
  });
  it('removes and replaces, an array element in place', () => {
    assert.deepEqual((patch(doc, { op: 'remove', path: '/list/0' }) as typeof doc).list, [2, 3]);
    assert.deepEqual(
      (patch(doc, { op: 'replace', path: '/list/1', value: 'x' }) as typeof doc).list,
      [1, 'x', 3],
    );
    assert.equal(
      (patch(doc, { op: 'replace', path: '/name', value: 'm' }) as typeof doc).name,
      'm',
    );
    assert.deepEqual(patch(doc, { op: 'replace', path: '', value: { whole: true } }), {
      whole: true,
    });
  });
  it('moves and copies', () => {
    const moved = patch(doc, { op: 'move', from: '/nested/a', path: '/b' }) as Record<
      string,
      unknown
    >;
    assert.deepEqual(moved['b'], { b: 1 });
    assert.deepEqual(moved['nested'], {});
    const copied = patch(doc, { op: 'copy', from: '/list/0', path: '/first' }) as Record<
      string,
      unknown
    >;
    assert.equal(copied['first'], 1);
    assert.deepEqual(copied['list'], [1, 2, 3]);
  });
  it('tests, and fails the patch when the test does not hold', () => {
    assert.deepEqual(patch(doc, { op: 'test', path: '/nested', value: { a: { b: 1 } } }), doc);
    assert.throws(
      () => patch(doc, { op: 'test', path: '/name', value: 'other' }),
      /test did not hold/u,
    );
  });
  it('applies the operations in order, and names the one that failed', () => {
    assert.deepEqual(
      patch(doc, { op: 'add', path: '/x', value: 1 }, { op: 'replace', path: '/x', value: 2 }),
      { ...doc, x: 2 },
    );
    assert.throws(
      () => patch(doc, { op: 'add', path: '/ok', value: 1 }, { op: 'remove', path: '/nothing' }),
      (error: unknown) => {
        assert.ok(error instanceof JsonPatchError);
        assert.equal(error.index, 1);
        assert.match(error.message, /Operation 2/u);
        return true;
      },
    );
  });
  it('never changes the document it was given', () => {
    const copy = structuredClone(doc);
    patch(doc, { op: 'remove', path: '/list/0' }, { op: 'add', path: '/nested/a/c', value: 1 });
    assert.deepEqual(doc, copy);
  });
  it('refuses a path that leads nowhere, an index that is wrong, and a move into itself', () => {
    for (const op of [
      { op: 'remove', path: '/nothing' },
      { op: 'remove', path: '/list/9' },
      { op: 'replace', path: '/list/9', value: 1 },
      { op: 'add', path: '/list/9', value: 1 },
      { op: 'add', path: '/list/01', value: 1 },
      { op: 'add', path: '/list/x', value: 1 },
      { op: 'add', path: '/name/deeper', value: 1 },
      { op: 'add', path: '/missing/deeper', value: 1 },
      { op: 'remove', path: '' },
      { op: 'move', from: '/nested', path: '/nested/a/b' },
      { op: 'copy', from: '/nothing', path: '/x' },
    ] as JsonPatchOperation[]) {
      assert.throws(() => patch(doc, op), JsonPatchError, JSON.stringify(op));
    }
  });
  it('does not let a patch reach or write a prototype', () => {
    for (const path of [
      '/__proto__/polluted',
      '/constructor/prototype/polluted',
      '/nested/__proto__',
      '/__proto__',
    ]) {
      assert.throws(() => patch(doc, { op: 'add', path, value: true }), JsonPatchError, path);
    }
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    assert.throws(() => patch({ ...doc }, { op: 'remove', path: '/constructor' }), JsonPatchError);
  });
  it('refuses a patch that grows the document by copying a subtree into itself, before it runs out of memory', () => {
    // Every copy doubles /a: 2^60 values after 60 operations if nothing stopped it.
    const doubling: JsonPatchOperation[] = [{ op: 'add', path: '/a', value: [1, 2, 3, 4] }];
    for (let index = 0; index < 60; index += 1) {
      doubling.push({ op: 'copy', from: '/a', path: '/a/-' });
    }
    const started = performance.now();
    assert.throws(
      () => patch({}, ...doubling),
      (error: unknown) =>
        error instanceof JsonPatchError &&
        /larger than the limit|more than the limit/u.test(error.message) &&
        error.index !== null,
    );
    assert.ok(performance.now() - started < 5000, 'the patch was refused in time');
    // Copies that do not grow without bound, and remove what they made, use the work budget: 500 of them are refused
    // when each clones a large subtree.
    const big = { a: Array.from({ length: 20_000 }, (_unused, index) => index) };
    const churn: JsonPatchOperation[] = [];
    for (let index = 0; index < 250; index += 1) {
      churn.push({ op: 'copy', from: '/a', path: '/b' }, { op: 'remove', path: '/b' });
    }
    assert.throws(() => patch(big, ...churn), /more than the limit/u);
    // And as many tests of the whole document.
    const tests: JsonPatchOperation[] = Array.from({ length: 500 }, () => ({
      op: 'test',
      path: '/a/0',
      value: 0,
    }));
    tests.push({ op: 'test', path: '', value: big }, { op: 'test', path: '', value: big });
    assert.deepEqual(patch(big, ...tests), big);
    const wholeTests: JsonPatchOperation[] = Array.from({ length: 500 }, () => ({
      op: 'test',
      path: '',
      value: big,
    }));
    assert.throws(() => patch(big, ...wholeTests), /more than the limit/u);
  });
  it('counts what a copy, an add or a move replaces, so overwriting a member does not use up the budget', () => {
    const doc = { a: Array<number>(400_000).fill(0), b: [] as number[] };
    const twice = patch(
      doc,
      { op: 'copy', from: '/a', path: '/b' },
      { op: 'copy', from: '/a', path: '/b' },
    ) as { a: number[]; b: number[] };
    assert.equal(twice.b.length, 400_000);
    const overwritten = patch(
      doc,
      { op: 'copy', from: '/a', path: '/b' },
      { op: 'add', path: '/b', value: [1] },
      { op: 'copy', from: '/a', path: '/b' },
      { op: 'move', from: '/a', path: '/b' },
      { op: 'copy', from: '/b', path: '/a' },
    ) as { a: number[]; b: number[] };
    assert.equal(overwritten.a.length, 400_000);
    // A document that really grows past the limit is still refused.
    assert.throws(
      () =>
        patch(doc, { op: 'copy', from: '/a', path: '/b' }, { op: 'copy', from: '/a', path: '/c' }),
      /larger than the limit/u,
    );
    // An array index inserts: two copies into an array are two copies.
    assert.throws(
      () =>
        patch(
          { a: doc.a, list: [] },
          { op: 'copy', from: '/a', path: '/list/-' },
          { op: 'copy', from: '/a', path: '/list/0' },
        ),
      /larger than the limit/u,
    );
  });
  it('still applies an ordinary patch to a large document', () => {
    const big = { a: Array.from({ length: 50_000 }, (_unused, index) => index), b: 1 };
    const result = patch(
      big,
      { op: 'copy', from: '/a', path: '/c' },
      { op: 'replace', path: '/b', value: 2 },
      { op: 'move', from: '/c', path: '/d' },
    ) as { b: number; d: number[] };
    assert.equal(result.b, 2);
    assert.equal(result.d.length, 50_000);
  });
});

describe('the paths at which two documents differ', () => {
  it('lists additions, removals and replacements, with no value', () => {
    const changes = diffPaths(
      { a: 1, b: { c: 2, d: 3 }, e: [1, 2] },
      { a: 2, b: { c: 2, f: 4 }, e: [1] },
    );
    assert.deepEqual(changes, [
      { op: 'replace', path: '/a' },
      { op: 'remove', path: '/b/d' },
      { op: 'add', path: '/b/f' },
      { op: 'remove', path: '/e/1' },
    ]);
    for (const change of changes) {
      assert.deepEqual(Object.keys(change).sort(), ['op', 'path']);
    }
  });
  it('is empty for equal documents, however the keys are ordered', () => {
    assert.deepEqual(diffPaths({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  });
  it('stops at the depth and the limit', () => {
    assert.deepEqual(diffPaths({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, 1), [
      { op: 'replace', path: '/a' },
    ]);
    const many = Object.fromEntries(Array.from({ length: 50 }, (_u, i) => [`k${String(i)}`, i]));
    const other = Object.fromEntries(
      Array.from({ length: 50 }, (_u, i) => [`k${String(i)}`, i + 1]),
    );
    assert.equal(diffPaths(many, other, 4, 7).length, 7);
  });
  it('escapes keys in the path', () => {
    assert.deepEqual(diffPaths({ 'a/b': 1 }, { 'a/b': 2 }), [{ op: 'replace', path: '/a~1b' }]);
  });
});
