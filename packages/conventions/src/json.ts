import { createHash } from 'node:crypto';

import type { JsonPatchOperation } from '@swellwright/contracts';

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

/** The mask that replaces a secret in a view (ADR 0041): `[masked]` or `[masked:1a2b3c4d]`. */
export const MASK = /^\[masked(?::[0-9a-f]{8})?\]$/u;
export const isMask = (value: unknown): boolean => typeof value === 'string' && MASK.test(value);

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
 * Applies RFC 6902 to a copy of the document and returns the result. The operations take effect one after another, as
 * the RFC says; the first one that cannot be applied stops the patch with a `JsonPatchError` that names it, and
 * nothing is returned. A `test` that does not hold fails the patch.
 */
export function applyJsonPatch(
  document: unknown,
  operations: readonly JsonPatchOperation[],
): unknown {
  let root: unknown = clone(document);
  operations.forEach((operation, index) => {
    try {
      const path = parsePointer(operation.path);
      switch (operation.op) {
        case 'add':
          root = addAt(root, path, clone(operation.value));
          break;
        case 'replace': {
          if (path.length === 0) {
            root = clone(operation.value);
            break;
          }
          readAt(root, path);
          removeAt(root, path);
          // Put it back where it was: an array element is replaced in place, not moved to the end.
          root = addAt(root, path, clone(operation.value));
          break;
        }
        case 'remove':
          root = removeAt(root, path);
          break;
        case 'test':
          if (!deepEqual(readAt(root, path), operation.value)) {
            throw new JsonPatchError('A test did not hold');
          }
          break;
        case 'copy':
          root = addAt(root, path, clone(readAt(root, parsePointer(operation.from))));
          break;
        case 'move': {
          const from = parsePointer(operation.from);
          if (operation.path.startsWith(`${operation.from}/`)) {
            throw new JsonPatchError('A value cannot be moved into itself');
          }
          const value = clone(readAt(root, from));
          root = removeAt(root, from);
          root = addAt(root, path, value);
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
