/**
 * The calls that wait for one confirmation dialog. Several calls can need a fresh second factor at the same moment
 * (two row actions, a dialog that sends twice); they all wait for the same code, and all go on, or all fail, together.
 */
export class StepUpWaiters {
  #waiting: { readonly resolve: () => void; readonly reject: (error: Error) => void }[] = [];
  readonly #listeners = new Set<() => void>();
  /** Set when the console that owns the dialog is gone; the error every later wait fails with. */
  #disposedWith: Error | undefined;

  /**
   * Resolves when the code is confirmed; rejects when the dialog is closed or the console goes away. Once the console
   * is gone, it rejects at once: a request that answers `step_up_required` after the sign-out has no dialog to wait for.
   */
  wait(): Promise<void> {
    if (this.#disposedWith !== undefined) {
      return Promise.reject(this.#disposedWith);
    }
    return new Promise<void>((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
      this.#changed();
    });
  }

  /**
   * Runs `action`; when it fails because a fresh second factor is needed (`needsCode`), waits for the dialog and runs it
   * once more, but only while the console that asked is still there.
   */
  async run<T>(action: () => Promise<T>, needsCode: (error: unknown) => boolean): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!needsCode(error)) {
        throw error;
      }
    }
    await this.wait();
    if (this.#disposedWith !== undefined) {
      throw this.#disposedWith;
    }
    return action();
  }

  /** Whether the console that owns the dialog is gone. */
  get disposed(): boolean {
    return this.#disposedWith !== undefined;
  }

  /** The console is gone for good: every waiting call fails with `error`, and so does every later one. */
  dispose(error: Error): void {
    this.#disposedWith = error;
    this.rejectAll(error);
  }

  /** The console is (again) on screen. React mounts an effect twice in development, so disposal is undone here. */
  activate(): void {
    this.#disposedWith = undefined;
  }

  /** Whether the dialog has anyone to answer. */
  get pending(): boolean {
    return this.#waiting.length > 0;
  }

  /** The code was accepted: every waiting call runs again. */
  resolveAll(): void {
    for (const waiter of this.#take()) {
      waiter.resolve();
    }
  }

  /** Cancelled, or the console was closed: every waiting call fails with `error`. */
  rejectAll(error: Error): void {
    for (const waiter of this.#take()) {
      waiter.reject(error);
    }
  }

  /** For `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly isPending = (): boolean => this.pending;

  #take() {
    const taken = this.#waiting;
    this.#waiting = [];
    if (taken.length > 0) {
      this.#changed();
    }
    return taken;
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
