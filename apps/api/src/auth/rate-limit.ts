/** How many keys one limiter tracks at most, unless it is told otherwise. */
export const DEFAULT_LIMITER_KEYS = 4096;

interface Window {
  readonly endsAt: number;
  count: number;
}

/**
 * A fixed-window counter per key, in memory. It slows down guessing from one address and is lost on restart; the
 * per-account state in the database is the durable control.
 *
 * The map tracks at most `maxKeys` keys. At capacity, the default rejects unseen keys; auth ingress may instead
 * evict the oldest window where other controls bound downstream work. The plugin gateway shares one extra window
 * among unseen keys without evicting tracked keys; its table sweeps are also rate-limited.
 */
export class WindowLimiter {
  private readonly windows = new Map<string, Window>();
  private sharedWindow: Window | undefined;
  private pruneAfter = -Infinity;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => performance.now(),
    private readonly maxKeys: number = DEFAULT_LIMITER_KEYS,
    private readonly overflow: 'reject' | 'evict-oldest' | 'shared' = 'reject',
  ) {}

  /** Records an attempt. Returns false when the applicable window or capacity policy refuses it. */
  hit(key: string): boolean {
    return this.tryHit(key) ?? false;
  }

  /** As `hit`, but returns undefined if capacity alone refused an untracked key in reject mode. */
  tryHit(key: string): boolean | undefined {
    const now = this.now();
    this.prune(now);
    const current = this.windows.get(key);
    if (current && current.endsAt > now) {
      return this.countHit(current);
    }
    if (current) {
      // A shared-mode sweep can be deferred, but an expired key gets a fresh window on its next hit.
      this.windows.delete(key);
    }
    if (this.windows.size >= this.maxKeys) {
      if (this.overflow === 'shared') {
        if (!this.sharedWindow || this.sharedWindow.endsAt <= now) {
          this.sharedWindow = { endsAt: now + this.windowMs, count: 0 };
        }
        return this.countHit(this.sharedWindow);
      }
      const oldest = this.windows.keys().next().value;
      if (this.overflow === 'reject' || oldest === undefined) {
        return undefined;
      }
      this.windows.delete(oldest);
    }
    this.windows.set(key, { endsAt: now + this.windowMs, count: 1 });
    return this.limit >= 1;
  }

  private countHit(window: Window): boolean {
    // Capped, so a key that keeps hammering cannot overflow its count.
    window.count = Math.min(window.count + 1, this.limit + 1);
    return window.count <= this.limit;
  }

  /** Whether the key has used up its limit in the current window. Counts nothing. */
  blocked(key: string): boolean {
    const current = this.windows.get(key) ?? this.sharedWindowAtCapacity();
    return current !== undefined && this.now() < current.endsAt && current.count >= this.limit;
  }

  /**
   * Whole seconds until the key may try again: the rest of its window, or, for an unseen key while the map is full, the
   * rest of the shared window if there is one, otherwise the time until the oldest window ends. At least 1.
   */
  retryAfterSeconds(key: string): number {
    const now = this.now();
    const current =
      this.windows.get(key) ?? this.sharedWindowAtCapacity() ?? this.windows.values().next().value;
    const waitMs = current ? current.endsAt - now : this.windowMs;
    return Math.max(1, Math.ceil(waitMs / 1000));
  }

  /** How many keys are tracked now (tests). */
  get size(): number {
    return this.windows.size;
  }

  private sharedWindowAtCapacity(): Window | undefined {
    return this.overflow === 'shared' && this.windows.size >= this.maxKeys
      ? this.sharedWindow
      : undefined;
  }

  private prune(now: number): void {
    if (this.overflow === 'shared') {
      if (this.windows.size < Math.min(1024, this.maxKeys) || now < this.pruneAfter) {
        return;
      }
      this.pruneAfter = now + Math.min(this.windowMs, 5000);
    }
    for (const [key, window] of this.windows) {
      if (window.endsAt <= now) {
        this.windows.delete(key);
      } else if (this.overflow !== 'shared') {
        // With the monotonic clock, the first live window ends the scan.
        return;
      }
    }
  }
}
