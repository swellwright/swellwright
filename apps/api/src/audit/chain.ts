import { createHash } from 'node:crypto';

import { type AuditDetails, AuditDetailsSchema, type ChainProblem } from '@swellwright/contracts';

/** What the first event links to. */
export const GENESIS_HASH = '0'.repeat(64);

/** Bumped if the fields or their order ever change; part of every hash, so old hashes stay checkable. */
const FORMAT = 1;

/** The fields a hash covers: exactly what the table stores, nothing derived. */
export interface ChainFields {
  readonly seq: bigint;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly ip: string | null;
  readonly requestId: string | null;
  /** The canonical text of `details`, as stored. */
  readonly details: string;
  readonly prevHash: string;
}

export interface StoredEvent extends ChainFields {
  readonly hash: string;
}

/**
 * The one text a set of details has: keys in code-unit order, no spaces. Flat records of short strings,
 * integers and booleans only (the schema refuses the rest), so there is no second way to write the same facts.
 */
export function canonicalDetails(details: AuditDetails): string {
  const checked = AuditDetailsSchema.parse(details);
  const sorted: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(checked).sort()) {
    sorted[key] = checked[key] ?? null;
  }
  return JSON.stringify(sorted);
}

/**
 * SHA-256 over a JSON array of the fields in a fixed order: a format version first, the previous hash last.
 * An array of strings, numbers and nulls has one encoding, and a field cannot bleed into its neighbour.
 */
export function chainHash(fields: ChainFields): string {
  const text = JSON.stringify([
    FORMAT,
    fields.seq.toString(),
    fields.occurredAt.toISOString(),
    fields.actorId,
    fields.actorName,
    fields.action,
    fields.outcome,
    fields.objectType,
    fields.objectId,
    fields.ip,
    fields.requestId,
    fields.details,
    fields.prevHash,
  ]);
  // This hashes append-only audit metadata (seq, actor, action, outcome, object ids, a
  // schema-validated `details` record, prevHash) for tamper detection, never a password or
  // passphrase: audit.service.ts builds `details` from literal, schema-checked values (e.g.
  // `{ kek_version }`), and vault.service.ts never puts a passphrase into it. Passphrases are
  // only ever hashed with the Argon2-based KDF in vault/kdf.ts.
  return createHash('sha256').update(text, 'utf8').digest('hex'); // lgtm[js/insufficient-password-hash]
}

/** Where the walk of the chain stands: the number and the hash the next event has to carry. */
export interface ChainCursor {
  readonly nextSeq: bigint;
  readonly prevHash: string;
}

export const START_OF_CHAIN: ChainCursor = { nextSeq: 1n, prevHash: GENESIS_HASH };

/** The first thing wrong with an event at this place in the chain, or null when it is intact. */
export function checkEvent(event: StoredEvent, at: ChainCursor): ChainProblem['reason'] | null {
  if (event.seq !== at.nextSeq) {
    return 'missing';
  }
  if (event.prevHash !== at.prevHash) {
    return 'link';
  }
  if (chainHash(event) !== event.hash) {
    return 'content';
  }
  return null;
}
