import assert from 'node:assert/strict';

import {
  type AuditEvent,
  type CommandRunView,
  type CommandTargetView,
  CommandRunViewSchema,
  SecretViewSchema,
  ServerAccessSchema,
  ServerViewSchema,
  type ScriptView,
  ScriptViewSchema,
} from '@swellwright/contracts';
import { type CuttableProxy, startCuttableProxy } from '@swellwright/ssh/test-support';

import { type AppOptions } from '../app.module.js';
import {
  auditEvents,
  type Client,
  codeFor,
  createOwner,
  createUser,
  forgetLastStep,
  type Instance,
  restart,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { createGate, type Gate, type Program, StepHost } from './step-host.js';

export const PASSPHRASE = 'a long passphrase for the vault, used in tests';
export const LOGIN = 'the-login-password-for-command-tests';
export const SUDO = 'the-sudo-password-for-command-tests';
export const OTHER = 'not-the-password-of-anybody';
/** A fingerprint of a key no test server has. */
export const FP_OTHER = `SHA256:${'B'.repeat(42)}Q`;

/** Quick polling, a short connect deadline and no rate limits that a test would run into by accident. */
export const BASE_ENV = {
  SW_SSH_ALLOW_LOOPBACK: 'true',
  SW_SSH_CONNECT_TIMEOUT_SECONDS: '2',
  SW_SSH_COMMAND_TIMEOUT_SECONDS: '5',
  SW_SSH_RATE_LIMIT_PER_MINUTE: '600',
  SW_COMMAND_POLL_MS: '25',
  SW_COMMAND_RATE_LIMIT_PER_MINUTE: '600',
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls until `read` returns something, or fails with a message that says what was awaited. */
export async function until<T>(
  what: string,
  read: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(20);
  }
}

/** The audit events of one kind, oldest first. */
export async function eventsOf(instance: Instance, action: string): Promise<AuditEvent[]> {
  return (await auditEvents(instance)).filter((event) => event.action === action);
}

/** One server of a run; a test that asks for a server that is not there fails here, not three lines later. */
export function targetOf(run: CommandRunView, index = 0): CommandTargetView {
  const target = run.targets[index];
  assert.ok(target, `the run has no server number ${String(index)}`);
  return target;
}

export const FINISHED_RUN = ['succeeded', 'failed', 'cancelled', 'partial'];

/** Programs the emulated servers can run, chosen by the `# fake:NAME` line of the script. */
export function standardPrograms(gates: Record<string, Gate> = {}): Record<string, Program> {
  const aborted = (signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        resolve();
      });
    });
  return {
    hello: (context) => {
      context.write('stdout', 'hello\n');
      return 0;
    },
    fail3: (context) => {
      context.write('stdout', 'before\n');
      context.write('stderr', 'boom\n');
      return 3;
    },
    env: (context) => {
      for (const [name, value] of Object.entries(context.env).sort()) {
        if (name.startsWith('SW_PARAM_')) {
          context.write('stdout', `${name}=[${value}]\n`);
        }
      }
      return 0;
    },
    /** Writes, waits at the gate, writes again. */
    split: async (context) => {
      context.write('stdout', 'part one\n');
      await Promise.race([gates['split']?.promise, aborted(context.signal)]);
      context.write('stdout', 'part two\n');
      context.write('stderr', 'warning at the end\n');
      return 0;
    },
    forever: async (context) => {
      context.write('stdout', 'started\n');
      while (!context.signal.aborted) {
        await context.sleep(40);
      }
      return 143;
    },
    lines: (context) => {
      for (let index = 0; index < 20_000; index += 1) {
        context.write('stdout', `line ${String(index).padStart(6, '0')}\n`);
      }
      return 0;
    },
    unicode: (context) => {
      context.write('stdout', 'héllo wörld € 😀 ünïcode — '.repeat(800));
      return 0;
    },
    /** 40 KiB of x. */
    big: (context) => {
      const chunk = Buffer.alloc(4096, 0x78);
      for (let index = 0; index < 10; index += 1) {
        context.write('stdout', chunk);
      }
      return 0;
    },
    gate: async (context) => {
      context.write('stdout', 'waiting\n');
      await Promise.race([gates['gate']?.promise, aborted(context.signal)]);
      context.write('stdout', 'released\n');
      return 0;
    },
  };
}

/**
 * A running application with an owner, an operator, an observer and an auditor, an open vault with the secrets servers
 * need, and helpers that make emulated servers, start runs and follow them.
 */
export class Harness {
  instance!: Instance;
  owner!: Client;
  operator!: Client;
  observer!: Client;
  auditor!: Client;
  private readonly authenticators = new Map<string, string>();
  secrets = { login: '', wrong: '', sudo: '' };
  readonly hosts: StepHost[] = [];
  private readonly proxies: CuttableProxy[] = [];
  private readonly keyBehind = new Map<number, string>();
  private counter = 0;

  async open(
    env: Record<string, string> = {},
    options: Partial<AppOptions> = {},
  ): Promise<void> {
    this.instance = await start({ ...BASE_ENV, ...env }, options);
    const { secret } = await createOwner(this.instance);
    this.authenticators.set('owner', secret);
    this.owner = await signInAs(this.instance, 'owner', secret);
    for (const [username, role] of [
      ['ops', 'operator'],
      ['viewer', 'observer'],
      ['auditor', 'auditor'],
    ] as const) {
      const made = await createUser(this.instance, username, role);
      this.authenticators.set(username, made.secret);
    }
    this.operator = await signInAs(this.instance, 'ops', this.authenticatorOf('ops'));
    this.observer = await signInAs(this.instance, 'viewer', this.authenticatorOf('viewer'));
    this.auditor = await signInAs(this.instance, 'auditor', this.authenticatorOf('auditor'));
    assert.equal(
      (await this.owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status,
      201,
    );
    this.secrets.login = await this.secret('ssh login', 'ssh_password', LOGIN);
    this.secrets.wrong = await this.secret('ssh wrong', 'ssh_password', OTHER);
    this.secrets.sudo = await this.secret('ssh sudo', 'ssh_password', SUDO);
  }

  authenticatorOf(username: string): string {
    const found = this.authenticators.get(username);
    assert.ok(found, `no authenticator remembered for ${username}`);
    return found;
  }

  async close(): Promise<void> {
    for (const proxy of this.proxies) {
      await proxy.close();
    }
    for (const host of this.hosts) {
      await host.close();
    }
    await stop(this.instance);
  }

  /** The application is stopped and another one started on the same database; the signed-in clients move over. */
  async restart(env: Record<string, string> = {}): Promise<void> {
    const next = await restart(this.instance, { ...BASE_ENV, ...env });
    const move = (from: Client): Client => {
      const client = next.client();
      client.cookie = from.cookie;
      return client;
    };
    this.owner = move(this.owner);
    this.operator = move(this.operator);
    this.observer = move(this.observer);
    this.auditor = move(this.auditor);
    this.instance = next;
  }

  /** A fresh authenticator code for the user, to elevate a session again. */
  async stepUp(client: Client, username: string): Promise<void> {
    await forgetLastStep(this.instance);
    const reply = await client.post('/auth/step-up', {
      code: codeFor(this.authenticatorOf(username)),
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
  }

  async lapse(): Promise<void> {
    await this.instance.isolated.database.client.session.updateMany({
      data: { elevatedUntil: new Date(Date.now() - 1000) },
    });
  }

  async secret(name: string, type: string, value: string): Promise<string> {
    const reply = await this.owner.post('/secrets', { name, type, value });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return SecretViewSchema.parse(reply.body).id;
  }

  async host(
    programsOf: Record<string, Program>,
    options: { launchGate?: Promise<void>; launchFailure?: string } = {},
  ): Promise<StepHost> {
    const host = await StepHost.start({
      users: { runner: { password: LOGIN } },
      programs: programsOf,
      ...options,
    });
    this.hosts.push(host);
    return host;
  }

  /** A forwarder that can be cut, in front of a host. */
  async proxyFor(host: StepHost): Promise<CuttableProxy> {
    const proxy = await startCuttableProxy('127.0.0.1', host.port);
    this.proxies.push(proxy);
    this.keyBehind.set(proxy.port, host.fingerprint);
    return proxy;
  }

  /**
   * A server of the inventory that points at an emulated host (or a proxy in front of one), with the host's key
   * pinned and one login entry, unless an option says otherwise.
   */
  async server(
    where: { readonly port: number },
    options: {
      name?: string;
      /** `null`: nothing pinned. A fingerprint: that one instead of the host's. */
      fingerprint?: string | null;
      /** The vault secret of the login password (default: the right one). */
      password?: string;
      /** `false`: no access entry. */
      access?: boolean;
    } = {},
  ): Promise<string> {
    this.counter += 1;
    const name = options.name ?? `srv-${String(this.counter)}`;
    const created = await this.owner.post('/servers', {
      name,
      address: '127.0.0.1',
      sshPort: where.port,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = ServerViewSchema.parse(created.body).id;
    const fingerprint =
      options.fingerprint === undefined
        ? where instanceof StepHost
          ? where.fingerprint
          : this.keyBehind.get(where.port)
        : options.fingerprint;
    if (fingerprint !== null && fingerprint !== undefined) {
      const pinned = await this.owner.post(`/servers/${id}/host-keys`, {
        algorithm: 'ssh-ed25519',
        fingerprintSha256: fingerprint,
      });
      assert.ok(pinned.status === 200 || pinned.status === 201, JSON.stringify(pinned.body));
    }
    if (options.access !== false) {
      const entry = await this.owner.post(`/servers/${id}/access`, {
        method: 'password',
        username: 'runner',
        secretId: options.password ?? this.secrets.login,
      });
      assert.equal(entry.status, 201, JSON.stringify(entry.body));
      ServerAccessSchema.parse(entry.body);
    }
    return id;
  }

  /** The body of an inline run (read level, so that no confirmation is needed). */
  inline(
    serverIds: string[],
    command: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { mode: 'inline', serverIds, command, dangerLevel: 'read', ...extra };
  }

  async createRun(client: Client, body: Record<string, unknown>): Promise<CommandRunView> {
    const reply = await client.post('/command-runs', body);
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return CommandRunViewSchema.parse(reply.body);
  }

  async getRun(id: string, client: Client = this.owner): Promise<CommandRunView> {
    const reply = await client.get(`/command-runs/${id}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return CommandRunViewSchema.parse(reply.body);
  }

  /** Waits for a condition on a run and returns the run as it was then. */
  async waitFor(
    id: string,
    what: string,
    test: (run: CommandRunView) => boolean,
    ms = 20_000,
  ): Promise<CommandRunView> {
    return until(
      what,
      async () => {
        const run = await this.getRun(id);
        return test(run) ? run : undefined;
      },
      ms,
    );
  }

  /** Waits until the run has ended, and returns it. */
  finished(id: string, ms = 20_000): Promise<CommandRunView> {
    return this.waitFor(id, `run ${id} to end`, (run) => FINISHED_RUN.includes(run.state), ms);
  }

  async script(client: Client, body: Record<string, unknown>): Promise<ScriptView> {
    const reply = await client.post('/scripts', body);
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return ScriptViewSchema.parse(reply.body);
  }
}

export { createGate };
