import { isIP } from 'node:net';

import { addressKind, normalizeAddress } from './model.js';

// Looking names up for the reconciliation. The package does not talk to the network: it is handed a function that
// asks one question ("the A records of this name") and does the rest, which is the part worth testing: following a
// chain of CNAME records up to a limit, telling "no such name" from "no answer in time" from "the server failed",
// refusing addresses that the installation's policy does not allow, keeping answers for a short time, and never
// looking up more names than a run is allowed to.

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME';

/** What a query returns: the records as text, and the time to live when the resolver knows it. */
export interface DnsRecords {
  readonly records: readonly string[];
  readonly ttl: number | null;
}

/** One question to a resolver. It throws a `DnsQueryError` when there is no answer. */
export type DnsQuery = (name: string, type: DnsRecordType) => Promise<DnsRecords>;

export class DnsQueryError extends Error {
  constructor(
    /** `none`: the name or the record does not exist. `timeout`. `error`: the server failed or refused. */
    readonly kind: 'none' | 'timeout' | 'error',
    message?: string,
  ) {
    super(message ?? kind);
    this.name = 'DnsQueryError';
  }
}

/** The error codes of Node's resolver, as the three kinds of failure there are. */
export function queryErrorFromCode(code: string | undefined, message: string): DnsQueryError {
  if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENOENT') {
    return new DnsQueryError('none', message);
  }
  if (code === 'ETIMEOUT' || code === 'ETIMEDOUT' || code === 'ECANCELLED') {
    return new DnsQueryError('timeout', message);
  }
  return new DnsQueryError('error', message);
}

export type DnsStatus = 'ok' | 'nxdomain' | 'timeout' | 'error' | 'cname_loop' | 'invalid';

export interface DnsAnswer {
  readonly status: DnsStatus;
  /** The addresses the policy allows. */
  readonly addresses: readonly string[];
  /** Addresses that were found and are not allowed (loopback, link-local, ...): never returned as the answer. */
  readonly refused: readonly string[];
  readonly cnames: readonly string[];
  /** The smallest time to live of the records used, when known. */
  readonly ttl: number | null;
}

const NONE: Omit<DnsAnswer, 'status'> = { addresses: [], refused: [], cnames: [], ttl: null };

export const MAX_CNAME_CHAIN = 8;

export interface ResolveOptions {
  readonly query: DnsQuery;
  /** Whether an address may be reported (the address policy of the installation). */
  readonly allow: (address: string) => boolean;
  readonly timeoutMs: number;
  readonly maxChain?: number;
}

/** A promise that gives up after a time, so that one slow server cannot hold a whole run. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DnsQueryError('timeout', 'no answer in time'));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function ask(
  options: ResolveOptions,
  name: string,
  type: DnsRecordType,
): Promise<DnsRecords> {
  try {
    return await withTimeout(options.query(name, type), options.timeoutMs);
  } catch (error) {
    if (error instanceof DnsQueryError) {
      throw error;
    }
    const code = (error as { code?: unknown } | null)?.code;
    throw queryErrorFromCode(
      typeof code === 'string' ? code : undefined,
      error instanceof Error ? error.message : 'error',
    );
  }
}

/** The A and AAAA records of a name, following CNAME records. Never throws: a failure is the `status` of the answer. */
export async function resolveName(rawName: string, options: ResolveOptions): Promise<DnsAnswer> {
  const original = normalizeAddress(rawName);
  if (addressKind(original) !== 'name') {
    return { status: 'invalid', ...NONE };
  }
  const maxChain = options.maxChain ?? MAX_CNAME_CHAIN;
  const cnames: string[] = [];
  const visited = new Set<string>([original]);
  let current = original;
  for (let hop = 0; ; hop += 1) {
    if (hop > maxChain) {
      return { status: 'cname_loop', ...NONE, cnames };
    }
    let next: string | undefined;
    try {
      const found = await ask(options, current, 'CNAME');
      next = found.records[0] === undefined ? undefined : normalizeAddress(found.records[0]);
    } catch (error) {
      if (error instanceof DnsQueryError && error.kind === 'timeout') {
        return { status: 'timeout', ...NONE, cnames };
      }
      if (error instanceof DnsQueryError && error.kind === 'error') {
        return { status: 'error', ...NONE, cnames };
      }
      next = undefined; // no CNAME: this is the name that has the addresses
    }
    if (next === undefined || next === '') {
      break;
    }
    if (visited.has(next)) {
      return { status: 'cname_loop', ...NONE, cnames: [...cnames, next] };
    }
    visited.add(next);
    cnames.push(next);
    current = next;
  }
  const [a, aaaa] = await Promise.allSettled([
    ask(options, current, 'A'),
    ask(options, current, 'AAAA'),
  ]);
  const found: string[] = [];
  const ttls: number[] = [];
  const failures: DnsQueryError[] = [];
  for (const outcome of [a, aaaa]) {
    if (outcome.status === 'fulfilled') {
      found.push(
        ...outcome.value.records
          .map((record) => normalizeAddress(record))
          .filter((record) => isIP(record) !== 0),
      );
      if (outcome.value.ttl !== null) {
        ttls.push(outcome.value.ttl);
      }
    } else if (outcome.reason instanceof DnsQueryError) {
      failures.push(outcome.reason);
    } else {
      failures.push(new DnsQueryError('error'));
    }
  }
  const addresses = [...new Set(found)].filter((address) => options.allow(address));
  const refused = [...new Set(found)].filter((address) => !options.allow(address));
  const ttl = ttls.length === 0 ? null : Math.min(...ttls);
  if (found.length > 0) {
    return { status: 'ok', addresses, refused, cnames, ttl };
  }
  if (failures.some((failure) => failure.kind === 'timeout')) {
    return { status: 'timeout', ...NONE, cnames };
  }
  if (failures.some((failure) => failure.kind === 'error')) {
    return { status: 'error', ...NONE, cnames };
  }
  return { status: 'nxdomain', ...NONE, cnames };
}

export interface LookupStats {
  readonly names: number;
  readonly resolved: number;
  readonly failed: number;
  readonly skipped: number;
  readonly capped: boolean;
  readonly cached: number;
  readonly durationMs: number;
}

export interface LookupOptions extends ResolveOptions {
  readonly concurrency: number;
  /** How long an answer is kept, in milliseconds. 0: not at all. */
  readonly cacheMs: number;
  readonly maxNames: number;
  readonly now?: () => number;
}

interface CacheEntry {
  readonly answer: DnsAnswer;
  readonly at: number;
}

/** Looks names up through `resolveName`, a few at a time, under a cap, with a short memory of what it was told. */
export class DnsLookup {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: LookupOptions) {}

  forget(): void {
    this.cache.clear();
  }

  /** The answers for the names that fit under the cap (in the order given), and how it went. */
  async lookup(
    names: readonly string[],
  ): Promise<{ answers: Map<string, DnsAnswer>; stats: LookupStats }> {
    const now = this.options.now ?? Date.now;
    const started = now();
    const unique = [...new Set(names.map((name) => normalizeAddress(name)))].filter(
      (name) => addressKind(name) === 'name',
    );
    const wanted = unique.slice(0, this.options.maxNames);
    const answers = new Map<string, DnsAnswer>();
    let cached = 0;
    const toAsk: string[] = [];
    for (const name of wanted) {
      const hit = this.cache.get(name);
      if (
        hit !== undefined &&
        this.options.cacheMs > 0 &&
        started - hit.at < this.options.cacheMs
      ) {
        answers.set(name, hit.answer);
        cached += 1;
      } else {
        toAsk.push(name);
      }
    }
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const name = toAsk[cursor];
        cursor += 1;
        if (name === undefined) {
          return;
        }
        const answer = await resolveName(name, this.options);
        answers.set(name, answer);
        // A timeout or a failure is not worth remembering: asking again may work.
        if (this.options.cacheMs > 0 && (answer.status === 'ok' || answer.status === 'nxdomain')) {
          this.cache.set(name, { answer, at: now() });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(this.options.concurrency, toAsk.length)) }, () =>
        worker(),
      ),
    );
    let resolved = 0;
    let failed = 0;
    for (const answer of answers.values()) {
      if (answer.status === 'ok') {
        resolved += 1;
      } else {
        failed += 1;
      }
    }
    return {
      answers,
      stats: {
        names: unique.length,
        resolved,
        failed,
        skipped: unique.length - wanted.length,
        capped: unique.length > wanted.length,
        cached,
        durationMs: Math.max(0, now() - started),
      },
    };
  }
}
