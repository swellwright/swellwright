import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The read-only script that makes the observations of a baseline check, and the hash that is stored with every run. */
export interface ObserveScript {
  readonly text: string;
  /** SHA-256 of `text`, in lower-case hex. */
  readonly sha256: string;
}

let loaded: ObserveScript | undefined;

/**
 * Reads `observe.sh` (it sits next to this file, in `src` and, copied by the build, in `dist`). Line endings are made LF
 * first, so a checkout with Windows line endings runs and hashes the same script. A missing file is an error at start,
 * not at the first run.
 */
export function loadObserveScript(): ObserveScript {
  if (loaded) {
    return loaded;
  }
  const text = readFileSync(new URL('./observe.sh', import.meta.url), 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  loaded = { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
  return loaded;
}
