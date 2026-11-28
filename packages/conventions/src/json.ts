import { createHash } from 'node:crypto';

import { isMaskText, type JsonPatchOperation, MASK_PATTERN_SOURCE } from '@swellwright/contracts';

// JSON helpers for the impact calculator: canonical text and equality, JSON Pointer (RFC 6901), JSON Patch (RFC 6902)
// and a list of the paths at which two documents differ. The patch is applied to a copy, so the object that was read
// from the panel is never changed; the keys that could poison a prototype are refused; the sizes are bounded.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class JsonPatchError extends Error {
  constructor(
    message: string,
    /** The index of the operation that failed, when one did. */
    readonly index: number | null = null,
  ) {
    super(index === null ? message : `Operation ${String(index + 1)}: ${message}`);
    this.name = 'JsonPatchError';
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_POINTER_DEPTH = 32;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON with the keys of every object in sorted order and no white space: the same document gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // `-0` is written `0`, `undefined` as null (it cannot be in JSON).
    if (typeof value === 'number' && Object.is(value, -0)) {
      return '0';
    }
    // JSON.stringify gives undefined for a function or a symbol, which has no place in a JSON document.
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return 'null';
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export const deepEqual = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The mask that replaces a secret in a view (ADR 0041): `[masked]`, `[masked:1a2b3c4d]` or
 * `[masked: unreadable document]` (one definition, in `@swellwright/contracts`).
 */
export const MASK = new RegExp(`^${MASK_PATTERN_SOURCE}$`, 'u');
export const isMask = (value: unknown): boolean => isMaskText(value);

export function parsePointer(pointer: string): string[] {
  if (pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    throw new JsonPatchError(
      `The path "${pointer.slice(0, 60)}" is not a JSON Pointer (it must start with "/")`,
    );
  }
  const parts = pointer
    .slice(1)
    .split('/')
    .map((part) => {
      if (/~(?![01])/u.test(part)) {
        throw new JsonPatchError('A path has a "~" that is not "~0" or "~1"');
      }
      return part.replaceAll('~1', '/').replaceAll('~0', '~');
    });
  if (parts.length > MAX_POINTER_DEPTH) {
    throw new JsonPatchError(`A path is deeper than ${String(MAX_POINTER_DEPTH)} levels`);
  }
  return parts;
}

export const toPointer = (parts: readonly string[]): string =>
  parts.map((part) => `/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');

function arrayIndex(part: string, length: number, allowEnd: boolean): number {
  if (allowEnd && part === '-') {
    return length;
  }
  if (!/^(0|[1-9]\d{0,8})$/u.test(part)) {
    throw new JsonPatchError(`"${part.slice(0, 20)}" is not an array index`);
  }
  return Number(part);
}

/** The container that holds the last step of a path, and the last step. */
function parentOf(root: unknown, parts: readonly string[]): { container: unknown; key: string } {
  let current: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = arrayIndex(part, current.length, false);
      if (index >= current.length) {
        throw new JsonPatchError(
          `The path leads past the end of an array (index ${String(index)})`,
        );
      }
      current = current[index];
    } else if (isObject(current)) {
      if (FORBIDDEN_KEYS.has(part) || !Object.hasOwn(current, part)) {
        throw new JsonPatchError(`The path has no "${part.slice(0, 40)}"`);
      }
      current = current[part];
    } else {
      throw new JsonPatchError('The path goes through a value that is not an object or an array');
    }
  }
  return { container: current, key: parts[parts.length - 1] ?? '' };
}

function readAt(root: unknown, parts: readonly string[]): unknown {
  if (parts.length === 0) {
    return root;
  }
  const { container, key } = parentOf(root, parts);
  if (Array.isArray(container)) {
    const index = arrayIndex(key, container.length, false);
    if (index >= container.length) {
      throw new JsonPatchError(`There is no element ${String(index)}`);
    }
    return container[index];
  }
  if (isObject(container)) {
    if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(container, key)) {
      throw new JsonPatchError(`There is no "${key.slice(0, 40)}"`);
    }
    return container[key];
  }
  throw new JsonPatchError('The path goes through a value that is not an object or an array');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * The most a patch may build or copy, in units of one JSON value plus one per 64 characters of a text. A `copy` of a
 * subtree that an earlier `copy` doubled doubles again: 500 operations of a small request could otherwise ask for a
 * document of 2^500 values. Both the document a patch leaves and the sum of everything its operations clone are
 * bounded, and the size of a value is measured (with an early stop) before it is cloned.
 */
export const PATCH_LIMITS = {
  /** The document before and after every operation. */
  documentUnits: 1_000_000,
  /** Everything the operations of one patch clone, together. */
  workUnits: 4_000_000,
} as const;

/** The size of a value in the units of `PATCH_LIMITS`, or `Infinity` as soon as it is over `limit`. */
function sizeOf(value: unknown, limit: number): number {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    total += 1;
    if (typeof current === 'string') {
      total += Math.floor(current.length / 64);
    } else if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
    } else if (current !== null && typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        total += Math.floor(key.length / 64);
        stack.push(item);
      }
    }
    if (total > limit) {
      return Infinity;
    }
  }
  return total;
}

/** Keeps the account of one patch: the size of the document and the work done so far. */
class PatchBudget {
  private work = 0;
  private document: number;

  constructor(initial: unknown) {
    this.document = sizeOf(initial, PATCH_LIMITS.documentUnits);
    if (this.document === Infinity) {
      throw new JsonPatchError('The document is too large to be patched');
    }
    this.spend(this.document);
  }

  /** The size of a value that is about to be cloned and added; throws before the clone when it is over a limit. */
  adding(value: unknown): number {
    const size = sizeOf(value, PATCH_LIMITS.documentUnits);
    this.spend(size);
    if (this.document + size > PATCH_LIMITS.documentUnits) {
      throw new JsonPatchError(
        `The patch makes the document larger than the limit of ${String(PATCH_LIMITS.documentUnits)} values`,
      );
    }
    this.document += size;
    return size;
  }

  removing(value: unknown): void {
    if (value === undefined) {
      return;
    }
    const size = sizeOf(value, PATCH_LIMITS.documentUnits);
    this.document = size === Infinity ? 0 : Math.max(0, this.document - size);
  }

  /** A value that is read whole (compared by a `test`): its size counts as work. */
  examining(value: unknown): void {
    this.spend(sizeOf(value, PATCH_LIMITS.workUnits));
  }

  private spend(units: number): void {
    this.work += units;
    if (this.work > PATCH_LIMITS.workUnits) {
      throw new JsonPatchError(
        `The patch copies more than the limit of ${String(PATCH_LIMITS.workUnits)} values`,
      );
    }
  }
}

function addAt(root: unknown, parts: readonly string[], value: unknown): unknown {
  if (parts.length === 0) {
    return value;
  }
  const { container, key } = parentOf(root, parts);
  if (Array.isArray(container)) {
    const index = arrayIndex(key, container.length, true);
    if (index > container.length) {
      throw new JsonPatchError(`The index ${String(index)} is past the end of the array`);
    }
    container.splice(index, 0, value);
  } else if (isObject(container)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new JsonPatchError(`The key "${key}" is not allowed`);
    }
    container[key] = value;
  } else {
    throw new JsonPatchError('The path goes through a value that is not an object or an array');
  }
  return root;
}

function removeAt(root: unknown, parts: readonly string[]): unknown {
  if (parts.length === 0) {
    throw new JsonPatchError('The whole document cannot be removed');
  }
  const { container, key } = parentOf(root, parts);
  if (Array.isArray(container)) {
    const index = arrayIndex(key, container.length, false);
    if (index >= container.length) {
      throw new JsonPatchError(`There is no element ${String(index)} to remove`);
    }
    container.splice(index, 1);
  } else if (isObject(container)) {
    if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(container, key)) {
      throw new JsonPatchError(`There is no "${key.slice(0, 40)}" to remove`);
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete container[key];
  } else {
    throw new JsonPatchError('The path goes through a value that is not an object or an array');
  }
  return root;
}

/**
 * The value an `add` at `parts` would replace: the whole document, or a member of an object that exists. An array
 * index inserts, so it replaces nothing; a path that does not lead anywhere replaces nothing (`addAt` says why).
 */
function replacedAt(root: unknown, parts: readonly string[]): unknown {
  if (parts.length === 0) {
    return root;
  }
  try {
    const { container, key } = parentOf(root, parts);
    if (isObject(container) && !FORBIDDEN_KEYS.has(key) && Object.hasOwn(container, key)) {
      return container[key];
    }
  } catch {
    // Nothing is replaced; the operation itself reports the path.
  }
  return undefined;
}

/**
 * Applies RFC 6902 to a copy of the document and returns the result. The operations take effect one after another, as
 * the RFC says; the first one that cannot be applied stops the patch with a `JsonPatchError` that names it, and
 * nothing is returned. A `test` that does not hold fails the patch. A patch that would build a document or copy more
 * than `PATCH_LIMITS` allow fails the same way, before the copy that would pass the limit is made.
 */
export function applyJsonPatch(
  document: unknown,
  operations: readonly JsonPatchOperation[],
): unknown {
  const budget = new PatchBudget(document);
  let root: unknown = clone(document);
  operations.forEach((operation, index) => {
    try {
      const path = parsePointer(operation.path);
      switch (operation.op) {
        case 'add': {
          // An add onto a member that exists replaces it (an array index inserts and replaces nothing).
          budget.removing(replacedAt(root, path));
          budget.adding(operation.value);
          root = addAt(root, path, clone(operation.value));
          break;
        }
        case 'replace': {
          if (path.length === 0) {
            budget.removing(root);
            budget.adding(operation.value);
            root = clone(operation.value);
            break;
          }
          budget.removing(readAt(root, path));
          removeAt(root, path);
          budget.adding(operation.value);
          // Put it back where it was: an array element is replaced in place, not moved to the end.
          root = addAt(root, path, clone(operation.value));
          break;
        }
        case 'remove': {
          let removed: unknown;
          try {
            removed = readAt(root, path);
          } catch {
            // removeAt says what is wrong with the path.
          }
          root = removeAt(root, path);
          budget.removing(removed);
          break;
        }
        case 'test': {
          const current = readAt(root, path);
          // Comparing is work as well: a test of the whole document, 500 times, is refused like a copy would be.
          budget.examining(current);
          if (!deepEqual(current, operation.value)) {
            throw new JsonPatchError('A test did not hold');
          }
          break;
        }
        case 'copy': {
          const source = readAt(root, parsePointer(operation.from));
          budget.removing(replacedAt(root, path));
          // Measured before it is cloned: the copy that would pass the limit is never made.
          budget.adding(source);
          root = addAt(root, path, clone(source));
          break;
        }
        case 'move': {
          const from = parsePointer(operation.from);
          if (operation.path.startsWith(`${operation.from}/`)) {
            throw new JsonPatchError('A value cannot be moved into itself');
          }
          const source = readAt(root, from);
          // A move takes the value away and puts it back, over whatever was at the destination; the clone it makes is
          // work all the same.
          budget.removing(source);
          root = removeAt(root, from);
          budget.removing(replacedAt(root, path));
          budget.adding(source);
          root = addAt(root, path, clone(source));
          break;
        }
      }
    } catch (error) {
      if (error instanceof JsonPatchError) {
        throw new JsonPatchError(error.message, index);
      }
      throw error;
    }
  });
  return root;
}

export interface PathChange {
  readonly op: 'add' | 'remove' | 'replace';
  readonly path: string;
}

/**
 * The paths at which two documents differ: what was added, removed or replaced. Objects are compared key by key down
 * to `depth` levels, arrays element by element; below that a difference is reported at the level reached. No value is
 * returned, only paths, since a value may be a secret. Stops at `limit` paths.
 */
export function diffPaths(before: unknown, after: unknown, depth = 4, limit = 200): PathChange[] {
  const out: PathChange[] = [];
  const walk = (a: unknown, b: unknown, path: string[], left: number): void => {
    if (out.length >= limit || deepEqual(a, b)) {
      return;
    }
    if (left > 0 && isObject(a) && isObject(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        const inA = Object.hasOwn(a, key);
        const inB = Object.hasOwn(b, key);
        if (inA && inB) {
          walk(a[key], b[key], [...path, key], left - 1);
        } else if (out.length < limit) {
          out.push({ op: inB ? 'add' : 'remove', path: toPointer([...path, key]) });
        }
      }
      return;
    }
    if (left > 0 && Array.isArray(a) && Array.isArray(b)) {
      const length = Math.max(a.length, b.length);
      for (let i = 0; i < length; i += 1) {
        if (i >= a.length) {
          out.push({ op: 'add', path: toPointer([...path, String(i)]) });
        } else if (i >= b.length) {
          out.push({ op: 'remove', path: toPointer([...path, String(i)]) });
        } else {
          walk(a[i], b[i], [...path, String(i)], left - 1);
        }
        if (out.length >= limit) {
          return;
        }
      }
      return;
    }
    out.push({ op: 'replace', path: toPointer(path) });
  };
  walk(before, after, [], depth);
  return out.slice(0, limit);
}
