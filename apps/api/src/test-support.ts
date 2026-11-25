import assert from 'node:assert/strict';

import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  ApiErrorSchema,
  type AuditEvent,
  type UserRole,
  TotpConfirmedSchema,
  TotpEnrollmentSchema,
} from '@swellwright/contracts';
import { Database } from '@swellwright/db';
import { createIsolatedDatabase, type IsolatedDatabase } from '@swellwright/db/testing';

import { toAuditEvent } from './audit/audit.service.js';
import { PasswordHasher } from './auth/password.js';
import { SecretBox } from './auth/secret-box.js';
import { base32Decode, base32Encode, generateTotpSecret, timeStep, totpCode } from './auth/totp.js';
import { type AppOptions } from './app.module.js';
import { createApp } from './bootstrap.js';
import { loadConfig } from './config.js';

/** Helpers shared by the tests that run the whole application against a database of their own. */

export const databaseUrl = process.env['SW_TEST_DATABASE_URL'];
export const SETUP_TOKEN = 'test-setup-token-0123456789';
export const PASSWORD = 'correct horse battery staple';
/** Another valid password, for the tests that change one. */
export const NEW_PASSWORD_FOR_TESTS = 'a different long passphrase';
export const CHEAP = { memory: 256, passes: 1, parallelism: 1 } as const;
/** The vault's Argon2id cost for tests: real parameters would take a quarter of a gibibyte per attempt. */
export const CHEAP_KDF = { memoryKib: 256, passes: 1, parallelism: 1 } as const;
export const AUTH_KEY = Buffer.alloc(32, 1).toString('base64');

export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
  readonly setCookie: string[];
}

/** A browser stand-in: keeps the session cookie between calls. */
export class Client {
  cookie: string | undefined;

  constructor(private readonly base: string) {}

  async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = res.headers.getSetCookie();
    for (const line of setCookie) {
      const [pair] = line.split(';');
      const [name, value] = (pair ?? '').split('=');
      if (name === 'sw_session') {
        this.cookie = value ? `sw_session=${value}` : undefined;
      }
    }
    const text = await res.text();
    return {
      status: res.status,
      body: text ? (JSON.parse(text) as unknown) : undefined,
      headers: res.headers,
      setCookie,
    };
  }

  get(path: string): Promise<Reply> {
    return this.call('GET', path);
  }

  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> {
    return this.call('POST', path, body, headers);
  }
}

export const errorCode = (reply: Reply): string => ApiErrorSchema.parse(reply.body).error.code;

/** A code for the current step, or a step further on when the current one was used already. */
export const codeFor = (secret: string, stepsAhead = 0): string =>
  totpCode(base32Decode(secret), timeStep(Date.now()) + stepsAhead);

export interface Instance {
  app: NestExpressApplication;
  base: string;
  isolated: IsolatedDatabase;
  client: () => Client;
}

export async function start(
  env: Record<string, string> = {},
  extra: Partial<AppOptions> = {},
): Promise<Instance> {
  const isolated = await createIsolatedDatabase(databaseUrl ?? '');
  const config = loadConfig(
    {
      SW_LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      SW_AUTH_KEY: AUTH_KEY,
      SW_SETUP_TOKEN: SETUP_TOKEN,
      SW_LOCKOUT_ATTEMPTS: '3',
      ...env,
    },
    '0.0.0-test',
  );
  const app = await createApp(config, {
    readinessChecks: [],
    passwordParams: CHEAP,
    vaultKdf: CHEAP_KDF,
    database: isolated.database,
    // The loop of the run engine polls the database: the tests that are not about it leave it off (those that are turn it on).
    engine: { tuning: { autostart: false } },
    ...extra,
  });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${String(port)}/api/v1`;
  return { app, base, isolated, client: () => new Client(base) };
}

/**
 * Stops the application of an instance and starts another one on the same database: a restart of the server. Sessions,
 * the vault and everything else that is in the database is still there; what lived in memory (the open vault, the pools)
 * is gone, as after a real restart.
 */
export async function restart(
  instance: Instance,
  env: Record<string, string> = {},
  extra: Partial<AppOptions> = {},
): Promise<Instance> {
  await instance.app.close();
  const poolSize = Number(process.env['SW_TEST_DATABASE_POOL'] ?? '3');
  const database = new Database({
    url: databaseUrl ?? '',
    schema: instance.isolated.schema,
    poolSize,
  });
  const config = loadConfig(
    {
      SW_LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      SW_AUTH_KEY: AUTH_KEY,
      SW_SETUP_TOKEN: SETUP_TOKEN,
      SW_LOCKOUT_ATTEMPTS: '3',
      ...env,
    },
    '0.0.0-test',
  );
  const app = await createApp(config, {
    readinessChecks: [],
    passwordParams: CHEAP,
    vaultKdf: CHEAP_KDF,
    database,
    engine: { tuning: { autostart: false } },
    ...extra,
  });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${String(port)}/api/v1`;
  return {
    app,
    base,
    // The schema is dropped through the first handle; the new handle is closed with the application.
    isolated: { ...instance.isolated, database },
    client: () => new Client(base),
  };
}

export async function stop(instance: Instance): Promise<void> {
  await instance.app.close();
  await instance.isolated.drop();
}

/** Creates the owner and finishes the enrollment. Returns what a later sign-in needs. */
export async function createOwner(
  instance: Instance,
  username = 'owner',
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const client = instance.client();
  const created = await client.post('/setup/owner', {
    setupToken: SETUP_TOKEN,
    username,
    password: PASSWORD,
  });
  assert.equal(created.status, 200);
  const enrollment = TotpEnrollmentSchema.parse((await client.post('/auth/totp/enrollment')).body);
  const confirmed = await client.post('/auth/totp/confirm', { code: codeFor(enrollment.secret) });
  assert.equal(confirmed.status, 200);
  return {
    secret: enrollment.secret,
    recoveryCodes: TotpConfirmedSchema.parse(confirmed.body).recoveryCodes,
  };
}

/** Lets the same authenticator code be used again: a test has no 30-second wait. */
export async function forgetLastStep(instance: Instance): Promise<void> {
  await instance.isolated.database.client.credential.updateMany({ data: { totpLastStep: null } });
}

/**
 * Adds a user with a role, a password and a confirmed authenticator straight in the database, as the
 * future user management will. Returns the authenticator secret for signing in.
 */
export async function createUser(
  instance: Instance,
  username: string,
  role: UserRole,
): Promise<{ id: string; secret: string }> {
  const secret = generateTotpSecret();
  const created = await instance.isolated.database.client.user.create({
    data: { username, role },
  });
  const box = new SecretBox(Buffer.from(AUTH_KEY, 'base64'));
  await instance.isolated.database.client.credential.create({
    data: {
      userId: created.id,
      passwordHash: await new PasswordHasher(CHEAP).hash(PASSWORD),
      totpSecret: new Uint8Array(box.seal(secret, `swellwright:totp:v1:${created.id}`)),
      totpConfirmedAt: new Date(),
    },
  });
  return { id: created.id, secret: base32Encode(secret) };
}

/** A value that must be there, or a failed test. Keeps later lines free of `?.` that the type no longer needs. */
export function found<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `${what} was not found`);
  return value;
}

/** Every audit event in the instance's database, oldest first, as the API would show it. */
export async function auditEvents(instance: Instance): Promise<AuditEvent[]> {
  const rows = await instance.isolated.database.client.auditEvent.findMany({
    orderBy: { seq: 'asc' },
  });
  return rows.map(toAuditEvent);
}

/** Takes an invitation through the password and the authenticator, as the invitee would. */
export async function acceptInvitation(
  instance: Instance,
  token: string,
  password: string,
): Promise<{ client: Client; secret: string }> {
  const client = instance.client();
  const accepted = await client.post('/auth/invitations/accept', { token, password });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const enrollment = TotpEnrollmentSchema.parse((await client.post('/auth/totp/enrollment')).body);
  const confirmed = await client.post('/auth/totp/confirm', { code: codeFor(enrollment.secret) });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return { client, secret: enrollment.secret };
}

/** A client signed in as the user: password, then an authenticator code. */
export async function signInAs(
  instance: Instance,
  username: string,
  secret: string,
  password = PASSWORD,
): Promise<Client> {
  await forgetLastStep(instance);
  const client = instance.client();
  const login = await client.post('/auth/login', { username, password });
  assert.equal(login.status, 200);
  const done = await client.post('/auth/totp', { code: codeFor(secret) });
  assert.equal(done.status, 200);
  return client;
}
