/**
 * A fixed-window counter per key, in memory. It slows down guessing from one address and is lost on restart;
 * the per-account lockout in the database is the durable control.
 */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private overflow: { start: number; count: number } | undefined;
  private pruneAfter = -Infinity;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly capacity = Infinity,
  ) {}

  /** Records an attempt. Returns false when the key is over its limit for the current window. */
  hit(key: string): boolean {
    const now = this.now();
    this.prune(now);
    const current = this.windows.get(key);
    if (!current && this.windows.size >= this.capacity) {
      // Do not evict a tracked key: churning addresses would otherwise reset their guessing budgets.
      if (!this.overflow || now - this.overflow.start >= this.windowMs) {
        this.overflow = { start: now, count: 1 };
        return true;
      }
      this.overflow.count = Math.min(this.limit + 1, this.overflow.count + 1);
      return this.overflow.count <= this.limit;
    }
    if (!current || now - current.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count = Math.min(this.limit + 1, current.count + 1);
    return current.count <= this.limit;
  }

  /** Whether the key has used up its limit in the current window. Counts nothing. */
  blocked(key: string): boolean {
    const current =
      this.windows.get(key) ?? (this.windows.size >= this.capacity ? this.overflow : undefined);
    return (
      current !== undefined &&
      this.now() - current.start < this.windowMs &&
      current.count >= this.limit
    );
  }

  private prune(now: number): void {
    if (this.windows.size < Math.min(1024, this.capacity) || now < this.pruneAfter) {
      return;
    }
    this.pruneAfter = now + Math.min(this.windowMs, 5000);
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}
