import assert from 'node:assert/strict';

import {
  type PanelDiff,
  PanelDiffSchema,
  type PanelSnapshotList,
  PanelSnapshotListSchema,
  type PanelSnapshotSummary,
  PanelSnapshotSummarySchema,
} from '@swellwright/contracts';
import { FAKE_SECRETS, ROTATED_SECRETS } from '@swellwright/remnawave/test-support';

import { type AppOptions } from '../../app.module.js';
import {
  type Client,
  codeFor,
  createOwner,
  forgetLastStep,
  type Instance,
  signInAs,
  start,
} from '../../test-support.js';
import { connect, makeSecret, PANEL_ENV, PASSPHRASE } from '../panel-test-support.js';

/** Helpers shared by the tests of the snapshots of the panel (ADR 0043). */

/** The environment of an API whose snapshot job and retention are set for a test. */
export const SNAPSHOT_ENV = {
  ...PANEL_ENV,
  SW_PANEL_SNAPSHOT_KEEP: '4',
  SW_PANEL_SNAPSHOT_INTERVAL_HOURS: '24',
} as const;

/** The body of every answer the helpers below got: the tests scan them for secrets at the end. */
export const SEEN: string[] = [];

export interface Booted {
  readonly instance: Instance;
  readonly owner: Client;
  readonly ownerSecret: string;
  readonly tokenSecretId: string;
}

/** An instance with a signed-in owner, an open vault and a secret that holds the token of the fake panel. */
export async function boot(
  fakeToken: string,
  env: Record<string, string> = {},
  extra: Partial<AppOptions> = {},
): Promise<Booted> {
  const instance = await start({ ...SNAPSHOT_ENV, ...env }, extra);
  const { secret } = await createOwner(instance);
  const owner = await signInAs(instance, 'owner', secret);
  assert.equal((await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status, 201);
  const tokenSecretId = await makeSecret(owner, 'panel token', 'panel_token', fakeToken);
  return { instance, owner, ownerSecret: secret, tokenSecretId };
}

export async function connectTo(booted: Booted, baseUrl: string): Promise<void> {
  const reply = await connect(booted.owner, baseUrl, booted.tokenSecretId);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
}

/** Gives the session of the client a fresh authenticator code, as a person asked for one would. */
export async function elevate(instance: Instance, client: Client, secret: string): Promise<void> {
  await forgetLastStep(instance);
  assert.equal((await client.post('/auth/step-up', { code: codeFor(secret) })).status, 200);
}

/** Lets the step-up of every session lapse, so that the next route that needs a code asks for one. */
export async function lapse(instance: Instance): Promise<void> {
  await instance.isolated.database.client.session.updateMany({
    data: { elevatedUntil: new Date(0) },
  });
}

export async function takeSnapshot(client: Client, label?: string): Promise<PanelSnapshotSummary> {
  const reply = await client.post('/panel/snapshots', label === undefined ? {} : { label });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  SEEN.push(JSON.stringify(reply.body));
  return PanelSnapshotSummarySchema.parse(reply.body);
}

export async function listSnapshots(client: Client, query = ''): Promise<PanelSnapshotList> {
  const reply = await client.get(`/panel/snapshots${query}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  SEEN.push(JSON.stringify(reply.body));
  return PanelSnapshotListSchema.parse(reply.body);
}

export async function diffAgainst(
  client: Client,
  id: string,
  against: string,
  query = '',
): Promise<PanelDiff> {
  const reply = await client.get(`/panel/snapshots/${id}/diff?against=${against}${query}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  SEEN.push(JSON.stringify(reply.body));
  return PanelDiffSchema.parse(reply.body);
}

/** Every secret the fake panel holds and every one a mutation puts in, plus the tokens a test used. */
export function snapshotForbidden(tokens: readonly string[]): string[] {
  return [...Object.values(FAKE_SECRETS).flat(), ...Object.values(ROTATED_SECRETS), ...tokens];
}
