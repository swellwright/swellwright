import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { RateLimitedException } from '../http.js';

const argon2Async = promisify(argon2);

export interface PasswordParams {
  /** Memory in KiB. */
  readonly memory: number;
  /** Passes (time cost). */
  readonly passes: number;
  readonly parallelism: number;
}

/** Argon2id with 64 MiB and 3 passes: about 130 ms on a current server core. */
export const DEFAULT_PASSWORD_PARAMS: PasswordParams = { memory: 65536, passes: 3, parallelism: 1 };

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const ARGON2_VERSION = 19;
const MAX_CONCURRENT = 4;
const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,9}),t=(\d{1,4}),p=(\d{1,3})\$([A-Za-z0-9+/]{8,})\$([A-Za-z0-9+/]{16,})$/u;

const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64').replace(/=+$/u, '');
const unb64 = (text: string): Buffer => Buffer.from(text, 'base64');

interface Parsed {
  readonly params: PasswordParams;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parse(phc: string): Parsed | null {
  const match = PHC.exec(phc);
  if (!match) {
    return null;
  }
  const [, memory, passes, parallelism, salt, hash] = match;
  return {
    params: { memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism) },
    salt: unb64(salt ?? ''),
    hash: unb64(hash ?? ''),
  };
}

/** How the queue in front of the hashes is bounded (ADR 0049). */
export interface HasherLimits {
  /** Hashes computed at the same time. */
  readonly concurrent: number;
  /** Callers that may wait for a slot; one more is refused at once. */
  readonly queue: number;
  /** A caller that has not got a slot after this long is refused. */
  readonly waitMs: number;
}

export const DEFAULT_HASHER_LIMITS: HasherLimits = {
  concurrent: MAX_CONCURRENT,
  queue: 16,
  waitMs: 2_000,
};

/** What a refused caller is told: try again in this many seconds. */
export const HASHER_BUSY_RETRY_SECONDS = 2;

type Priority = 'session' | 'known' | 'dummy';
const PRIORITIES: readonly Priority[] = ['session', 'known', 'dummy'];

/**
 * Password hashing with Argon2id from `node:crypto` (no dependency). Hashes are PHC strings, so they carry
 * their own salt and parameters and old hashes keep verifying after the parameters are raised.
 * The number of hashes in flight is capped: every one needs tens of MiB, and logins are unauthenticated. So is the
 * queue in front of them: a caller who would wait behind a full queue, or who waited too long, is refused with 429
 * instead of piling up behind a flood of sign-ins.
 */
export class PasswordHasher {
  private readonly active = { session: 0, known: 0, dummy: 0 };
  private readonly waiting: { priority: Priority; resolve: () => void; timer: NodeJS.Timeout }[] =
    [];
  private readonly dummySalt = randomBytes(SALT_BYTES);

  constructor(
    private readonly params: PasswordParams = DEFAULT_PASSWORD_PARAMS,
    private readonly limits: HasherLimits = DEFAULT_HASHER_LIMITS,
  ) {}

  async hash(password: string, priority: 'session' | 'known' = 'known'): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const tag = await this.derive(password, salt, this.params, TAG_BYTES, priority);
    const { memory, passes, parallelism } = this.params;
    return `$argon2id$v=${String(ARGON2_VERSION)}$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${b64(salt)}$${b64(tag)}`;
  }

  /** False for a wrong password and for a stored value that is not an Argon2id PHC string. */
  async verify(
    phc: string,
    password: string,
    priority: 'session' | 'known' = 'known',
  ): Promise<boolean> {
    const parsed = parse(phc);
    if (!parsed) {
      return false;
    }
    const tag = await this.derive(
      password,
      parsed.salt,
      parsed.params,
      parsed.hash.length,
      priority,
    );
    return tag.length === parsed.hash.length && timingSafeEqual(tag, parsed.hash);
  }

  /** True when the stored hash was made with weaker parameters than the current ones. */
  needsRehash(phc: string): boolean {
    const parsed = parse(phc);
    return (
      !parsed ||
      parsed.params.memory < this.params.memory ||
      parsed.params.passes < this.params.passes ||
      parsed.params.parallelism !== this.params.parallelism
    );
  }

  /**
   * Spends the time of a real verification against a throwaway hash. Used for unknown users, so the answer
   * does not reveal whether a login name exists.
   */
  async verifyDummy(password: string): Promise<void> {
    // One derivation at the configured cost with a salt of this hasher; the result is thrown away. Nothing is cached,
    // so a failure (a full queue) is the caller's alone and does not poison later calls.
    await this.derive(password, this.dummySalt, this.params, TAG_BYTES, 'dummy');
  }

  /** Hashes being computed and callers waiting for a slot (tests). */
  get load(): { readonly active: number; readonly waiting: number } {
    return {
      active: this.active.session + this.active.known + this.active.dummy,
      waiting: this.waiting.length,
    };
  }

  private async derive(
    password: string,
    salt: Buffer,
    params: PasswordParams,
    length: number,
    priority: Priority,
  ): Promise<Buffer> {
    await this.acquire(priority);
    try {
      const out = await argon2Async('argon2id', {
        message: Buffer.from(password.normalize('NFKC'), 'utf8'),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength: length,
        memory: params.memory,
        passes: params.passes,
      });
      return Buffer.from(out);
    } finally {
      this.release(priority);
    }
  }

  private canRun(priority: Priority): boolean {
    const max = this.limits.concurrent;
    if (this.load.active >= max) {
      return false;
    }
    if (priority === 'dummy' && this.active.dummy >= Math.max(1, max - 2)) {
      return false;
    }
    return priority === 'session' || this.active.dummy + this.active.known < Math.max(1, max - 1);
  }

  private canQueue(priority: Priority): boolean {
    if (this.waiting.length >= this.limits.queue) {
      return false;
    }
    if (priority === 'session') {
      return true;
    }
    const dummy = this.waiting.filter((entry) => entry.priority === 'dummy').length;
    if (priority === 'dummy' && dummy >= Math.floor(this.limits.queue / 4)) {
      return false;
    }
    return (
      this.waiting.filter((entry) => entry.priority !== 'session').length < this.limits.queue - 1
    );
  }

  private async acquire(priority: Priority): Promise<void> {
    if (this.canRun(priority)) {
      this.active[priority] += 1;
      return;
    }
    if (!this.canQueue(priority)) {
      throw new HasherBusyError();
    }
    await new Promise<void>((resolve, reject) => {
      const entry = {
        priority,
        resolve: () => {
          clearTimeout(entry.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) {
            this.waiting.splice(index, 1);
          }
          reject(new HasherBusyError());
        }, this.limits.waitMs),
      };
      this.waiting.push(entry);
    });
  }

  private release(priority: Priority): void {
    this.active[priority] -= 1;
    // Admit waiting sessions first, then known accounts and dummy work, FIFO within each lane.
    for (const lane of PRIORITIES) {
      while (this.canRun(lane)) {
        const index = this.waiting.findIndex((entry) => entry.priority === lane);
        if (index < 0) {
          break;
        }
        const [next] = this.waiting.splice(index, 1);
        if (next) {
          this.active[lane] += 1;
          next.resolve();
        }
      }
    }
  }
}

/**
 * The hasher is at capacity: every slot is busy and the queue is full, or the wait for a slot ran out. Answers 429 with
 * `Retry-After: 2`. Nothing was hashed, so a sign-in refused this way counts as no attempt.
 */
export class HasherBusyError extends RateLimitedException {
  constructor() {
    super(
      HASHER_BUSY_RETRY_SECONDS,
      'The server is busy checking passwords. Try again in a moment.',
    );
  }
}
