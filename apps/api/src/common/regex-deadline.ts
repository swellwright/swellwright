import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from 'node:worker_threads';

// A baseline's `matches` expression runs under a
// deadline. The engine of the language backtracks, and an estimate of a pattern's cost (`regexBudgetIssue`) is a first
// filter, not a guarantee: a pattern it misjudges must not hold the API's event loop. A match in the engine cannot be
// interrupted from the same thread, so it runs on one worker thread, and the API waits for the answer synchronously
// (`Atomics.wait`) for at most the deadline. A match that is not done by then is a `timeout`: the worker is terminated
// (which stops the engine in the middle of the match) and a new one is started for the next call.
//
// Deadlines must not add up into a long stall either (300 checks with 300 slow patterns): a pattern that was stopped is
// remembered and not run again, one piece of work (a check run) has a budget of blocking time for all its matches, and
// the process has one for stopped matches (a second within a minute); past it, nothing new is run until the window
// moves on, and only an answer already known for the same pattern on the same text is given (the cost of a match
// depends on the text, so a pattern that was fast once proves nothing). Every refusal is a `timeout`, which the
// callers report as an error, never as a pass.
//
// `node:vm` with its `timeout` option stops a match as well, but it starts a watchdog thread for every call (about
// 0.14 ms each on Windows, ten times the cost of the worker round trip); each check run makes few calls,
// but a fleet run makes many.

/** The deadline of one match. */
export const REGEX_DEADLINE_MS = 50;
/** The longest a new worker may take to start; the remaining budget can make it shorter. */
const START_MS = 5_000;
/** After a worker failed to start, no new start is tried for this long: calls answer `timeout` meanwhile. */
const START_BACKOFF_MS = 1_000;

// The worker answers each request with its id, then counts the answers in `cell[0]` and wakes the waiter. The waiter
// looks for the answer with its own id, so an answer or a wake-up that belongs to an earlier request is never taken
// for this one.
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const { port, flag } = workerData;
const cell = new Int32Array(flag);
const cache = new Map();
port.on('message', ({ id, source, flags, text }) => {
  let result = 2;
  try {
    const key = flags + '/' + source;
    let regex = cache.get(key);
    if (regex === undefined) {
      if (cache.size > 200) cache.clear();
      regex = new RegExp(source, flags);
      cache.set(key, regex);
    }
    regex.lastIndex = 0;
    result = regex.test(text) ? 1 : 0;
  } catch {
    result = 2;
  }
  port.postMessage({ id, result });
  Atomics.add(cell, 0, 1);
  Atomics.notify(cell, 0);
});
Atomics.store(cell, 1, 1);
Atomics.notify(cell, 1);
`;

interface Runner {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly cell: Int32Array;
}

let runner: Runner | undefined;
let nextId = 1;
/** When the last start failed (`performance.now()`), or undefined. */
let startFailedAt: number | undefined;
/** Replaces the worker's program (tests: a program that never says it is ready). */
let workerSource = WORKER_SOURCE;

function start(limitMs: number): Runner | undefined {
  const flag = new SharedArrayBuffer(8);
  const cell = new Int32Array(flag);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { port: port2, flag },
    transferList: [port2],
  });
  // The worker never keeps the process alive, and an error of its own is the next call's timeout, not a crash.
  worker.unref();
  worker.on('error', () => {
    if (runner?.worker === worker) {
      runner = undefined;
    }
  });
  if (Atomics.wait(cell, 1, 0, Math.max(1, limitMs)) === 'timed-out') {
    void worker.terminate();
    port1.close();
    return undefined;
  }
  return { worker, port: port1, cell };
}

function stop(current: Runner): void {
  if (runner === current) {
    runner = undefined;
  }
  current.port.close();
  void current.worker.terminate();
}

/**
 * Waits for the answer to request `id` until `deadline` (`performance.now()` time). Answers to other requests are
 * dropped; a wake-up without this answer waits again for what is left of the time.
 */
function answerOf(current: Runner, id: number, deadline: number): 0 | 1 | undefined {
  for (;;) {
    const seen = Atomics.load(current.cell, 0);
    for (let message = receiveMessageOnPort(current.port); message !== undefined;) {
      const answer = message.message as { id?: unknown; result?: unknown } | null;
      if (answer?.id === id) {
        return answer.result === 0 || answer.result === 1 ? answer.result : undefined;
      }
      message = receiveMessageOnPort(current.port);
    }
    const left = deadline - performance.now();
    if (left <= 0) {
      return undefined;
    }
    Atomics.wait(current.cell, 0, seen, left);
  }
}

/** What is left of the process's budget of blocking, in milliseconds. */
function processAllowance(): number {
  processBudgetSpent();
  return PROCESS_BUDGET_MS - stalls.reduce((sum, stall) => sum + stall.ms, 0);
}

/**
 * Whether `regex` matches `text`, decided within `ms` milliseconds, or `timeout` when it could not be decided in time
 * (the match was stopped, the worker failed or could not start, or a budget is spent). `lastIndex` of a global pattern
 * does not carry over between calls.
 */
export function testWithDeadline(
  regex: RegExp,
  text: string,
  ms: number = REGEX_DEADLINE_MS,
  budget?: DeadlineBudget,
): boolean | 'timeout' {
  const key = `${regex.flags}/${regex.source}`;
  // A pattern that was stopped once is not run again: it would only cost another deadline.
  if (slow.has(key)) {
    touch(slow, key, true);
    return 'timeout';
  }
  // The answer for this very pattern on this very text, when it was decided before, costs nothing.
  const pair = `${key}\u0000${text}`;
  const known = answered.get(pair);
  if (known !== undefined) {
    touch(answered, pair, known);
    return known;
  }
  // With a budget spent (this run's, or the process's), nothing more is run: what a match costs depends on the text,
  // so a pattern that finished on one text earns nothing on another.
  if (budget !== undefined && budget.remainingMs <= 0) {
    return 'timeout';
  }
  if (processBudgetSpent()) {
    return 'timeout';
  }
  if (runner === undefined) {
    const starting = performance.now();
    // A start that failed a moment ago is not tried again at once: every call would block for the start time.
    if (startFailedAt !== undefined && starting - startFailedAt < START_BACKOFF_MS) {
      return 'timeout';
    }
    // Starting blocks too: it is bounded by what the budgets allow and charged to them when it fails.
    const allowance = Math.min(START_MS, processAllowance(), budget?.remainingMs ?? START_MS);
    runner = start(allowance);
    if (runner === undefined) {
      startFailedAt = performance.now();
      const spent = startFailedAt - starting;
      if (budget !== undefined) {
        budget.remainingMs -= spent;
      }
      stalls.push({ at: Date.now(), ms: spent });
      return 'timeout';
    }
    startFailedAt = undefined;
  }
  const current = runner;
  const started = performance.now();
  const limit = budget === undefined ? ms : Math.max(1, Math.min(ms, budget.remainingMs));
  const id = nextId;
  nextId = nextId >= 0x3fffffff ? 1 : nextId + 1;
  current.port.postMessage({ id, source: regex.source, flags: regex.flags, text });
  const answer = answerOf(current, id, started + limit);
  const spent = performance.now() - started;
  if (budget !== undefined) {
    budget.remainingMs -= spent;
  }
  if (answer === undefined) {
    stop(current);
    remember(slow, key, true, MAX_SLOW);
    stalls.push({ at: Date.now(), ms: spent });
    return 'timeout';
  }
  const result = answer === 1;
  remember(answered, pair, result, MAX_ANSWERED);
  return result;
}

/** Lets deadline tests control whether a worker acknowledges startup and answers requests. */
export function useWorkerModeForTests(mode: 'normal' | 'never-ready' | 'never-answers'): void {
  workerSource =
    mode === 'normal'
      ? WORKER_SOURCE
      : mode === 'never-ready'
        ? 'setInterval(() => {}, 1000);'
        : `
          const { workerData } = require('node:worker_threads');
          const cell = new Int32Array(workerData.flag);
          workerData.port.on('message', () => {});
          Atomics.store(cell, 1, 1);
          Atomics.notify(cell, 1);
        `;
  if (runner !== undefined) {
    stop(runner);
  }
  startFailedAt = undefined;
}

/**
 * How much one piece of work (the evaluation of one check run, one request) may block in matches together. Pass the
 * same object to every call of that work; when it is spent, the rest of its calls answer `timeout` at once.
 */
export interface DeadlineBudget {
  remainingMs: number;
}

/** The blocking time one check run may spend in matches together. */
export const RUN_BUDGET_MS = 300;

export function deadlineBudget(ms: number = RUN_BUDGET_MS): DeadlineBudget {
  return { remainingMs: ms };
}

/** Patterns (flags and source) that were stopped at a deadline, most recent last. */
const slow = new Map<string, boolean>();
const MAX_SLOW = 256;
/** Answers for a pattern on one text (flags, source and the text), most recent last. */
const answered = new Map<string, boolean>();
const MAX_ANSWERED = 1024;

function touch(map: Map<string, boolean>, key: string, value: boolean): void {
  map.delete(key);
  map.set(key, value);
}

function remember(map: Map<string, boolean>, key: string, value: boolean, max: number): void {
  touch(map, key, value);
  if (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done !== true) {
      map.delete(oldest.value);
    }
  }
}

/** The process's budget: at most this much blocking in stopped matches within the window. */
const PROCESS_BUDGET_MS = 1_000;
const PROCESS_WINDOW_MS = 60_000;
const stalls: { at: number; ms: number }[] = [];

function processBudgetSpent(): boolean {
  const since = Date.now() - PROCESS_WINDOW_MS;
  while (stalls.length > 0 && (stalls[0]?.at ?? 0) < since) {
    stalls.shift();
  }
  return stalls.reduce((sum, stall) => sum + stall.ms, 0) >= PROCESS_BUDGET_MS;
}

/** Forgets the patterns and the stalls seen so far (tests). */
export function resetDeadlineMemory(): void {
  slow.clear();
  answered.clear();
  stalls.length = 0;
  startFailedAt = undefined;
}
