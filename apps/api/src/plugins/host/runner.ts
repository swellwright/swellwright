/**
 * Runs INSIDE a plugin's process (ADR 0028). Everything the plugin may do, it does here, under the Node
 * permission model: it reads its own directory and this file and nothing else, has no network, no child
 * processes, no workers and no code generation from strings. This file imports nothing from the application:
 * the process may read only these two places, and a plugin must not be able to learn how the core is built.
 *
 * The protocol over the IPC channel, JSON messages:
 *   core -> plugin   { type: 'call', id, kind, method, params, config }
 *                    { type: 'reply', id, ok: true, value } | { type: 'reply', id, ok: false, message }
 *   plugin -> core   { type: 'ready', modules: { [kind]: string[] } } | { type: 'failed' }
 *                    { type: 'result', id, value } | { type: 'error', id, message }
 *                    { type: 'core', id, call, op: 'fetch', url, init }
 *                    { type: 'core', id, call, op: 'secret', field }
 *                    { type: 'core', id, call, op: 'storage', action, key?, value? }
 *   `call` is the id of the call the request belongs to: the core answers only while that call is under way.
 */
import type {
  PluginContext,
  PluginFetchInit,
  PluginFetchResponse,
  PluginStorage,
} from '@swellwright/plugin-api';

const MAX_MESSAGE_CHARS = 500;

type Method = (params: unknown, context: PluginContext) => unknown;

interface Waiting {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const modules = new Map<string, Record<string, Method>>();
const asking = new Map<number, Waiting>();
let nextAsk = 1;

function send(message: unknown): void {
  if (process.send === undefined) {
    throw new Error('This file is run by the Swellwright core and has no other use.');
  }
  process.send(message);
}

/**
 * A request to the core: the one way this process gets anything from outside. It names the call it belongs to; the
 * core answers only while that call is under way.
 */
function ask(call: number, payload: Record<string, unknown>): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const id = nextAsk++;
    asking.set(id, { resolve, reject });
    send({ type: 'core', id, call, ...payload });
  });
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_MESSAGE_CHARS);
}

function responseOf(
  status: number,
  headers: Record<string, string>,
  body: string,
): PluginFetchResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  };
}

function contextOf(pluginId: string, call: number, config: PluginContext['config']): PluginContext {
  const storage: PluginStorage = {
    get: (key) => ask(call, { op: 'storage', action: 'get', key }),
    set: async (key, value) => {
      await ask(call, { op: 'storage', action: 'set', key, value });
    },
    delete: async (key) => {
      await ask(call, { op: 'storage', action: 'delete', key });
    },
    keys: () => ask(call, { op: 'storage', action: 'keys' }) as Promise<string[]>,
  };
  return {
    pluginId,
    config,
    secret: (field) => ask(call, { op: 'secret', field }) as Promise<string>,
    storage,
    fetch: async (url: string, init?: PluginFetchInit) => {
      const answer = (await ask(call, { op: 'fetch', url, init: init ?? {} })) as {
        status: number;
        headers: Record<string, string>;
        body: string;
      };
      return responseOf(answer.status, answer.headers, answer.body);
    },
  };
}

interface ReplyMessage {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly message?: string;
}

function settle(message: ReplyMessage): void {
  const waiting = asking.get(message.id);
  if (waiting === undefined) {
    return;
  }
  asking.delete(message.id);
  if (message.ok) {
    waiting.resolve(message.value);
  } else {
    waiting.reject(new Error(message.message ?? 'The core refused the request.'));
  }
}

interface CallMessage {
  readonly id: number;
  readonly kind: string;
  readonly method: string;
  readonly params: unknown;
  readonly config: PluginContext['config'];
}

async function handleCall(pluginId: string, message: CallMessage): Promise<void> {
  const methods = modules.get(message.kind);
  // Own properties only: `constructor` and `toString` are not methods of the plugin.
  const handler =
    methods !== undefined && Object.hasOwn(methods, message.method)
      ? methods[message.method]
      : undefined;
  if (handler === undefined) {
    send({
      type: 'error',
      id: message.id,
      message: `The plugin has no method "${message.method}" for ${message.kind}.`,
    });
    return;
  }
  try {
    const value = await handler(message.params, contextOf(pluginId, message.id, message.config));
    send({ type: 'result', id: message.id, value: value === undefined ? null : value });
  } catch (error) {
    send({ type: 'error', id: message.id, message: describe(error) });
  }
}

async function load(pluginId: string, specs: readonly string[]): Promise<void> {
  const listing = Object.create(null) as Record<string, string[]>;
  for (const spec of specs) {
    const at = spec.indexOf('=');
    const kind = spec.slice(0, at);
    const loaded = (await import(spec.slice(at + 1))) as { default?: unknown };
    const exported = (loaded.default ?? loaded) as { methods?: unknown };
    const found = exported.methods;
    if (typeof found !== 'object' || found === null) {
      throw new Error(`The module for ${kind} exports no "methods" object.`);
    }
    const methods = Object.create(null) as Record<string, Method>;
    for (const [name, method] of Object.entries(found)) {
      if (typeof method !== 'function') {
        throw new Error(`"${name}" of ${kind} is not a function.`);
      }
      methods[name] = method as Method;
    }
    modules.set(kind, methods);
    listing[kind] = Object.keys(methods).sort();
  }
  process.on('message', (message: { type?: string } & Record<string, unknown>) => {
    if (message.type === 'call') {
      void handleCall(pluginId, message as unknown as CallMessage);
    } else if (message.type === 'reply') {
      settle(message as unknown as ReplyMessage);
    }
  });
  send({ type: 'ready', modules: listing });
}

const [pluginId, ...specs] = process.argv.slice(2);
try {
  await load(pluginId ?? '', specs);
} catch {
  send({ type: 'failed' });
  // Give the message a moment to leave; the core kills the process on `failed` anyway.
  setTimeout(() => process.exit(1), 100);
}
