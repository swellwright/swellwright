import { type MutationOptions, QueryClient, type QueryClientConfig } from '@tanstack/react-query';

const CONSOLE_DEFAULTS: QueryClientConfig = {
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
};

/** The defaults of every cache of the console: one retry, and no refetch when the window gets focus back. */
export function createConsoleQueryClient(): QueryClient {
  return new QueryClient(CONSOLE_DEFAULTS);
}

/** The callbacks of a mutation that act on the screen (toasts, navigation, state) once the answer is in. */
const SIDE_EFFECTS = ['onMutate', 'onSuccess', 'onError', 'onSettled'] as const;
const fenced = new WeakSet<object>();

/**
 * The cache of one signed-in session. Once it is disposed, the callbacks of a mutation that was still on its way do
 * nothing: an answer for the previous account cannot show a toast (a secret's name, a user's name) to the next one.
 * Clearing a cache alone does not stop those callbacks, so every mutation's options pass through here.
 */
export class SessionQueryClient extends QueryClient {
  #disposed = false;

  constructor(config: QueryClientConfig = CONSOLE_DEFAULTS) {
    super(config);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Stops what is still going, empties the cache and silences the callbacks of late answers. */
  dispose(): void {
    this.#disposed = true;
    void this.cancelQueries();
    this.clear();
  }

  // The signature of the method this overrides.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override defaultMutationOptions<T extends MutationOptions<any, any, any, any>>(options?: T): T {
    const merged = super.defaultMutationOptions(options);
    const out = { ...merged } as Record<string, unknown>;
    for (const name of SIDE_EFFECTS) {
      const callback = out[name];
      if (typeof callback === 'function' && !fenced.has(callback)) {
        const original = callback as (...args: unknown[]) => unknown;
        const guarded = (...args: unknown[]): unknown =>
          this.#disposed ? undefined : original(...args);
        fenced.add(guarded);
        out[name] = guarded;
      }
    }
    return out as T;
  }
}

/** For a client of another kind: stop what is going and empty it. */
export function disposeQueryClient(client: QueryClient): void {
  if (client instanceof SessionQueryClient) {
    client.dispose();
    return;
  }
  void client.cancelQueries();
  client.clear();
}

/**
 * One cache for each signed-in session. What one account read (its sessions, tokens, lists) lives in the cache of that
 * session and goes with it; the next account in the same tab starts with an empty one, even while its own requests
 * are still on their way. Each session also has a generation: work started in one (a confirmation dialog, a callback)
 * can be fenced so that it does nothing in the next.
 */
export class SessionQueryClients {
  #current: { readonly key: string; readonly client: QueryClient } | undefined;
  #generation = 0;
  readonly #create: () => QueryClient;

  constructor(create: () => QueryClient = () => new SessionQueryClient()) {
    this.#create = create;
  }

  /** The cache of the session `key` (the user id). A different key ends the previous session's cache first. */
  clientFor(key: string): QueryClient {
    if (this.#current?.key === key) {
      return this.#current.client;
    }
    this.end();
    const client = this.#create();
    this.#current = { key, client };
    this.#generation += 1;
    return client;
  }

  /** The session is over (signed out, ended by the server, or another account): its cache is dropped. */
  end(): void {
    const current = this.#current;
    this.#current = undefined;
    this.#generation += 1;
    if (current !== undefined) {
      disposeQueryClient(current.client);
    }
  }

  /**
   * `action`, bound to the session that is current now: called after that session ended (or another began), it does
   * nothing. For callbacks that outlive the screen that made them, such as the confirm button of a dialog.
   */
  fence<A extends unknown[]>(action: (...args: A) => void): (...args: A) => void {
    const generation = this.#generation;
    const live = this.#current !== undefined;
    return (...args: A) => {
      if (live && this.#generation === generation && this.#current !== undefined) {
        action(...args);
      }
    };
  }
}

/** The caches of the console in this tab. The sign-in screens keep their own client (the one in `main.tsx`). */
export const sessionQueryClients = new SessionQueryClients();
