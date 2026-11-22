import assert from 'node:assert/strict';

import {
  ApiErrorSchema,
  type PanelConnectionView,
  PanelConnectionViewSchema,
  SecretViewSchema,
} from '@swellwright/contracts';
import { FAKE_SECRETS } from '@swellwright/remnawave/test-support';

import { auditEvents, type Client, type Instance, type Reply } from '../test-support.js';

/** Helpers shared by the tests of the panel connection (ADR 0041). */

export const PASSPHRASE = 'a long passphrase for the vault, used in tests';

/** The environment of an API that may talk to a fake panel on this machine over plain http. */
export const PANEL_ENV = {
  SW_PANEL_ALLOW_HTTP: 'true',
  SW_PANEL_ALLOW_LOOPBACK: 'true',
  SW_PANEL_CHECK_INTERVAL_MINUTES: '0',
  SW_PANEL_CACHE_TTL_SECONDS: '300',
  SW_PANEL_REFRESH_RATE_LIMIT_PER_MINUTE: '200',
  SW_PANEL_TEST_RATE_LIMIT_PER_MINUTE: '200',
} as const;

export const errorOf = (reply: Reply): { code: string; message: string; details?: unknown } =>
  ApiErrorSchema.parse(reply.body).error;

export async function makeSecret(
  owner: Client,
  name: string,
  type: string,
  value: string,
): Promise<string> {
  const reply = await owner.post('/secrets', { name, type, value });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return SecretViewSchema.parse(reply.body).id;
}

export function connect(
  owner: Client,
  baseUrl: string,
  tokenSecretId: string,
  extra: Record<string, unknown> = {},
): Promise<Reply> {
  return owner.call('PUT', '/panel/connection', { baseUrl, tokenSecretId, ...extra });
}

export async function connection(client: Client): Promise<PanelConnectionView> {
  const reply = await client.get('/panel/connection');
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return PanelConnectionViewSchema.parse(reply.body);
}

/** Every secret the fake panel holds, plus the tokens a test used: none of them may reach a response or a record. */
export function forbiddenTexts(tokens: readonly string[]): string[] {
  return [...Object.values(FAKE_SECRETS).flat(), ...tokens];
}

export function assertClean(
  texts: readonly string[],
  forbidden: readonly string[],
  what: string,
): void {
  for (const text of texts) {
    for (const secret of forbidden) {
      assert.ok(!text.includes(secret), `${what} holds ${secret}`);
    }
  }
}

/** The audit events about the panel, oldest first. */
export async function panelEvents(instance: Instance) {
  return (await auditEvents(instance)).filter((event) => event.action.startsWith('panel.'));
}

/** A signed token with an expiry claim, shaped like the API tokens of the panel (the signature is not checked). */
export function tokenExpiringIn(days: number, now = Date.now()): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const exp = Math.floor(now / 1000) + Math.round(days * 86_400);
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ uuid: 'fake', role: 'API', exp })}.fake-signature-bytes`;
}
