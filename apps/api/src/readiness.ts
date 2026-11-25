import { Inject, Injectable } from '@nestjs/common';
import { type CheckResult, type ReadyResponse } from '@swellwright/contracts';
import { Redis } from 'iovalkey';

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');
const CHECK_TIMEOUT_MS = 2000;

/** A dependency probe. `run` resolves when the dependency answers and rejects otherwise. */
export interface ReadinessCheck {
  readonly name: string;
  run(): Promise<void>;
  close?(): Promise<void>;
}

/** Short, secret-free reason for a failed check. Raw driver messages can contain hosts and credentials. */
export function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message === 'timeout') {
    return 'timeout';
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,32}$/u.test(code) ? code : 'error';
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('error'));
      },
    );
  });
}

@Injectable()
export class ReadinessService {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: readonly ReadinessCheck[]) {}

  async run(): Promise<ReadyResponse> {
    const entries = await Promise.all(
      this.checks.map(async (check): Promise<[string, CheckResult]> => {
        const started = performance.now();
        try {
          await withTimeout(check.run(), CHECK_TIMEOUT_MS);
          return [check.name, { status: 'up', latencyMs: Math.round(performance.now() - started) }];
        } catch (error) {
          return [
            check.name,
            {
              status: 'down',
              latencyMs: Math.round(performance.now() - started),
              error: reasonOf(error),
            },
          ];
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    const down = entries.some(([, result]) => result.status === 'down');
    return { status: down ? 'not_ready' : 'ready', checks };
  }

  async close(): Promise<void> {
    await Promise.all(
      this.checks.map(async (c) => {
        await c.close?.();
      }),
    );
  }
}

/** What the check needs from the database: the shared connection pool is owned and closed elsewhere. */
export interface SchemaProbe {
  assertReady(): Promise<void>;
}

/** The server answers and the schema matches the migrations shipped with this build. */
export class DatabaseCheck implements ReadinessCheck {
  readonly name = 'postgres';

  constructor(private readonly database: SchemaProbe) {}

  async run(): Promise<void> {
    await this.database.assertReady();
  }
}

/**
 * Opens a short-lived connection per probe, so a failed probe leaves no half-open client behind. The probe owns its
 * deadline: connecting and the `PING` together get `timeoutMs`, and the client is closed when it passes, so a peer
 * that accepts the socket and never answers cannot keep a connection open after readiness has said `timeout`.
 * Overlapping readiness calls share the probe in flight instead of opening a connection each.
 */
export class ValkeyCheck implements ReadinessCheck {
  readonly name = 'valkey';
  private inFlight: Promise<void> | undefined;
  private active: Redis | undefined;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number = CHECK_TIMEOUT_MS,
  ) {}

  run(): Promise<void> {
    this.inFlight ??= this.probe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async probe(): Promise<void> {
    const client = new Redis(this.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: this.timeoutMs,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    this.active = client;
    try {
      await withTimeout(
        (async () => {
          await client.connect();
          await client.ping();
        })(),
        this.timeoutMs,
      );
    } finally {
      client.disconnect();
      if (this.active === client) {
        this.active = undefined;
      }
    }
  }

  close(): Promise<void> {
    this.active?.disconnect();
    this.active = undefined;
    return Promise.resolve();
  }
}
