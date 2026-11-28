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
 * The map is bounded: at most `maxKeys` live windows. Windows are kept in the order they started, so the expired ones
 * are removed from the front until the first live one. The default rejects unseen keys at capacity; ingress may
 * evict the oldest live window instead. Use eviction only with an independent ceiling that an address rotation
 * cannot reset.
 */
export class WindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => performance.now(),
    private readonly maxKeys: number = DEFAULT_LIMITER_KEYS,
    private readonly overflow: 'reject' | 'evict-oldest' = 'reject',
  ) {}

  /** Records an attempt. Returns false when the key is over its limit for the current window, or the map is full. */
  hit(key: string): boolean {
    return this.tryHit(key) ?? false;
  }

  /** As `hit`, but distinguishes an untracked key at capacity from a key that used its own budget. */
  tryHit(key: string): boolean | undefined {
    const now = this.now();
    this.prune(now);
    const current = this.windows.get(key);
    if (current) {
      // Capped, so a key that keeps hammering cannot overflow its count.
      current.count = Math.min(current.count + 1, this.limit + 1);
      return current.count <= this.limit;
    }
    if (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (this.overflow === 'reject' || oldest === undefined) {
        return undefined;
      }
      this.windows.delete(oldest);
    }
    this.windows.set(key, { endsAt: now + this.windowMs, count: 1 });
    return this.limit >= 1;
  }

  /** Whether the key has used up its limit in the current window. Counts nothing. */
  blocked(key: string): boolean {
    const current = this.windows.get(key);
    return current !== undefined && this.now() < current.endsAt && current.count >= this.limit;
  }

  /**
   * Whole seconds until the key may try again: the rest of its window, or, for an unseen key while the map is full, the
   * time until the oldest window ends. At least 1.
   */
  retryAfterSeconds(key: string): number {
    const now = this.now();
    const current = this.windows.get(key) ?? this.windows.values().next().value;
    const waitMs = current ? current.endsAt - now : this.windowMs;
    return Math.max(1, Math.ceil(waitMs / 1000));
  }

  /** How many keys are tracked now (tests). */
  get size(): number {
    return this.windows.size;
  }

  private prune(now: number): void {
    // Insertion order is start order and every window has the same length: the first live one ends the scan.
    for (const [key, window] of this.windows) {
      if (window.endsAt > now) {
        return;
      }
      this.windows.delete(key);
    }
  }
}
