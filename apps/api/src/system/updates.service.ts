import type { ReadableStreamDefaultReader } from 'node:stream/web';

import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { UpdatesResponse } from '@swellwright/contracts';

import type { AppConfig } from '../config.js';
import { CONFIG, CLOCK } from '../tokens.js';

/** How long an answer from GitHub is used before the next question. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 3_600_000;
/** After a failed attempt the next one comes sooner, but not at once. */
export const UPDATE_RETRY_MS = 3_600_000;
/** A request to GitHub that takes longer is given up. */
const REQUEST_TIMEOUT_MS = 5_000;
/** The caller that starts a check waits this long for it, then gets what is cached (nulls at first). */
export const FIRST_ANSWER_WAIT_MS = 1_500;
/** What GitHub answers is a few kilobytes; a larger body is not the answer. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** A release tag that is shown to people: letters, digits and the usual version punctuation. */
const VERSION_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;

type Fetched =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly why: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Waits for the promise, but not longer than `ms`. Never rejects; leaves no timer behind. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

/** The body as text, or an error when it is larger than `MAX_BODY_BYTES`. */
async function readLimited(res: Response): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('the answer is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Asks GitHub for the newest release and the star count of the project, at most once a day, and keeps the
 * answer in memory (ADR 0019). The browser never calls GitHub; it asks this service through `GET /updates`.
 *
 * - Nothing happens at start. The first call that finds nothing fresh starts the check and waits for it for a
 *   moment only; whatever is known by then (nothing, at first) is the answer, and the check goes on.
 * - One check at a time: calls that arrive meanwhile share it.
 * - After a failure the previous answer stays and the next attempt comes in an hour.
 * - With `SW_UPDATE_CHECK=off` there is no request, ever.
 * - A request is a plain GET without cookies or credentials. The `User-Agent` names the project and its
 *   version, as GitHub asks; nothing identifies this installation, a user or a browser.
 */
@Injectable()
export class UpdatesService implements OnApplicationShutdown {
  private readonly logger = new Logger('Updates');
  private readonly shutdown = new AbortController();
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private stars: number | null = null;
  private checkedAt: number | null = null;
  private nextAttemptAt = 0;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly now: () => number,
  ) {}

  /** What is known now; starts a check first when the answer is older than a day (or an hour after a failure). */
  async current(): Promise<UpdatesResponse> {
    if (!this.config.updateCheck.enabled) {
      return this.view(false);
    }
    if (this.running === null && this.now() >= this.nextAttemptAt) {
      this.running = this.check().finally(() => {
        this.running = null;
      });
    }
    if (this.running !== null) {
      await settledWithin(this.running, FIRST_ANSWER_WAIT_MS);
    }
    return this.view(true);
  }

  /**
   * What is known now, without starting a check and without waiting: the dashboard reads only what this server already
   * holds (ADR 0047). Nothing is known until some caller of `current()` has had the first check done.
   */
  peek(): UpdatesResponse {
    return this.view(this.config.updateCheck.enabled);
  }

  onApplicationShutdown(): void {
    this.shutdown.abort();
  }

  private view(enabled: boolean): UpdatesResponse {
    return {
      enabled,
      latestVersion: this.latestVersion,
      releaseUrl: this.releaseUrl,
      stars: this.stars,
      repositoryUrl: this.config.repositoryUrl,
      checkedAt: this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(),
    };
  }

  /** The repository first, then its latest release. Never throws: a problem is logged and kept to itself. */
  private async check(): Promise<void> {
    let failure: string | undefined;
    let learned = false;
    try {
      const repository = await this.get(`/repos/${this.config.repository}`);
      if (repository.kind === 'ok') {
        const stars = record(repository.body)?.['stargazers_count'];
        if (typeof stars === 'number' && Number.isSafeInteger(stars) && stars >= 0) {
          this.stars = stars;
          learned = true;
        } else {
          failure = 'the repository answer has no star count';
        }
      } else {
        failure = repository.kind === 'missing' ? 'the repository was not found' : repository.why;
      }
      // Without a repository there is nothing to say about releases; a 404 below then means "none yet".
      if (failure === undefined) {
        const release = await this.get(`/repos/${this.config.repository}/releases/latest`);
        if (release.kind === 'ok') {
          const found = this.readRelease(release.body);
          if (found) {
            this.latestVersion = found.version;
            this.releaseUrl = found.url;
            learned = true;
          } else {
            failure = 'the release answer has no usable tag';
          }
        } else if (release.kind === 'missing') {
          this.latestVersion = null;
          this.releaseUrl = null;
          learned = true;
        } else {
          failure = release.why;
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.name : 'unknown error';
    }
    const now = this.now();
    if (learned) {
      this.checkedAt = now;
    }
    if (failure === undefined) {
      this.nextAttemptAt = now + UPDATE_CHECK_INTERVAL_MS;
    } else {
      this.nextAttemptAt = now + UPDATE_RETRY_MS;
      this.logger.warn(
        `The check for a newer release failed (${failure}); trying again in an hour.`,
      );
    }
  }

  /** The version without a leading "v" and the page of the release; undefined when the tag is unusable. */
  private readRelease(body: unknown): { version: string; url: string } | undefined {
    const data = record(body);
    const tag = data?.['tag_name'];
    if (typeof tag !== 'string') {
      return undefined;
    }
    const version = tag.replace(/^v/u, '');
    if (!VERSION_TEXT.test(version)) {
      return undefined;
    }
    const given = data?.['html_url'];
    // The link goes into the console: only an https URL is taken from the answer, else the usual place.
    let url = `${this.config.repositoryUrl}/releases/tag/${encodeURIComponent(tag)}`;
    if (typeof given === 'string' && given.length <= 500) {
      try {
        if (new URL(given).protocol === 'https:') {
          url = given;
        }
      } catch {
        // not a URL: the usual place stands
      }
    }
    return { version, url };
  }

  private async get(path: string): Promise<Fetched> {
    try {
      const res = await fetch(`${this.config.updateCheck.apiBase}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `swellwright/${this.config.version.replace(/[^0-9A-Za-z.+_-]/gu, '-')}`,
          'x-github-api-version': '2022-11-28',
        },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.shutdown.signal]),
      });
      if (res.status === 404) {
        await res.body?.cancel();
        return { kind: 'missing' };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { kind: 'failed', why: `HTTP ${String(res.status)}` };
      }
      return { kind: 'ok', body: JSON.parse(await readLimited(res)) as unknown };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { kind: 'failed', why: 'the answer is not JSON' };
      }
      return { kind: 'failed', why: error instanceof Error ? error.name : 'unknown error' };
    }
  }
}
