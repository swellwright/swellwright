import { Injectable } from '@nestjs/common';

interface Entry {
  readonly value: unknown;
  readonly fetchedAt: number;
}

/**
 * A short memory of what was read from the panel (ADR 0040): per kind of object, for the connection that is current,
 * with the requests that are running now so that a second caller joins one instead of asking again. It holds what the
 * adapters returned, which is masked, and never the token: the token is read from the vault for one piece of work and
 * dropped. A new or removed connection empties it.
 */
@Injectable()
export class PanelCache {
  private connectionId: string | null = null;
  private entries = new Map<string, Entry>();
  private running = new Map<string, Promise<unknown>>();

  /** Makes the cache belong to this connection; the memory of another one is dropped. */
  forConnection(id: string): void {
    if (this.connectionId !== id) {
      this.reset();
      this.connectionId = id;
    }
  }

  reset(): void {
    this.connectionId = null;
    this.entries = new Map();
    // A request that is running for the old connection finishes into nothing: its callers keep their promise.
    this.running = new Map();
  }

  /** What is kept for a key if it is not older than `ttlMs`. */
  fresh(
    key: string,
    ttlMs: number,
    now: number,
  ): { value: unknown; fetchedAt: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry || ttlMs <= 0 || now - entry.fetchedAt >= ttlMs) {
      return undefined;
    }
    return { value: entry.value, fetchedAt: entry.fetchedAt };
  }

  put(connectionId: string, key: string, value: unknown, fetchedAt: number): void {
    // A result that arrives after the connection was replaced belongs to nobody.
    if (this.connectionId === connectionId) {
      this.entries.set(key, { value, fetchedAt });
    }
  }

  joinOrStart<T>(connectionId: string, key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.running.get(key);
    if (existing && this.connectionId === connectionId) {
      return existing as Promise<T>;
    }
    const promise = start().finally(() => {
      if (this.running.get(key) === promise) {
        this.running.delete(key);
      }
    });
    this.running.set(key, promise);
    return promise;
  }
}
