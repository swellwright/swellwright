import {
  AUDIT_EXPORT_FORMAT,
  AUDIT_EXPORT_VERSION,
  type AuditEvent,
  AuditEventSchema,
  type ChainProblem,
} from '@swellwright/contracts';

import {
  canonicalDetails,
  checkEvent,
  GENESIS_HASH,
  type ChainCursor,
  type StoredEvent,
} from './chain.js';

/** The result of checking an exported log without the server that wrote it. */
export interface ExportVerification {
  readonly ok: boolean;
  /** How many events were found intact, up to the first problem. */
  readonly checked: number;
  readonly first: number | null;
  readonly last: number | null;
  /** The last event of the file: compare it with a checkpoint noted elsewhere. */
  readonly head: { readonly seq: number; readonly hash: string } | null;
  readonly problem: ChainProblem | null;
  /** Set when the file is not an export at all (bad header, a line that is not an event). */
  readonly error: string | null;
}

function fail(error: string): ExportVerification {
  return { ok: false, checked: 0, first: null, last: null, head: null, problem: null, error };
}

/** The fields a hash covers, taken from an event as the API (and the export) show it. */
export function toStoredEvent(event: AuditEvent): StoredEvent {
  return {
    seq: BigInt(event.seq),
    occurredAt: new Date(event.occurredAt),
    actorId: event.actor?.id ?? null,
    actorName: event.actor?.name ?? null,
    action: event.action,
    outcome: event.outcome,
    objectType: event.object?.type ?? null,
    objectId: event.object?.id ?? null,
    ip: event.ip,
    requestId: event.requestId,
    details: canonicalDetails(event.details),
    prevHash: event.prevHash,
    hash: event.hash,
  };
}

/** The hash of the event with this number in an export file, or null when the file has no such event. */
export function findEventHash(text: string, seq: number): string | null {
  // Every line is parsed: JSON does not fix the order of the members, so no text search can find `seq` reliably.
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const event = AuditEventSchema.parse(JSON.parse(line));
      if (event.seq === seq) {
        return event.hash;
      }
    } catch {
      // Not an event line: keep looking.
    }
  }
  return null;
}

/**
 * Checks a file of the export format: a header line, then one event per line, oldest first. A file that starts
 * at the beginning of the log is also checked against the start of the chain; one that starts later is checked
 * from its first event on (what comes before it is not in the file to be checked).
 */
export function verifyExportText(text: string): ExportVerification {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const [header, ...body] = lines;
  if (header === undefined) {
    return fail('The file is empty.');
  }
  try {
    const parsed = JSON.parse(header) as { format?: unknown; version?: unknown };
    if (parsed.format !== AUDIT_EXPORT_FORMAT || parsed.version !== AUDIT_EXPORT_VERSION) {
      return fail(
        `The first line is not an audit export header (expected format "${AUDIT_EXPORT_FORMAT}", version ${String(AUDIT_EXPORT_VERSION)}).`,
      );
    }
  } catch {
    return fail('The first line is not JSON.');
  }

  let at: ChainCursor | undefined;
  let checked = 0;
  let first: number | null = null;
  let last: number | null = null;
  let head: { seq: number; hash: string } | null = null;
  for (const [index, line] of body.entries()) {
    let event: AuditEvent;
    try {
      event = AuditEventSchema.parse(JSON.parse(line));
    } catch {
      return {
        ok: false,
        checked,
        first,
        last,
        head,
        problem: null,
        error: `Line ${String(index + 2)} is not an audit event.`,
      };
    }
    const stored = toStoredEvent(event);
    at ??= {
      nextSeq: stored.seq,
      prevHash: stored.seq === 1n ? GENESIS_HASH : stored.prevHash,
    };
    const reason = checkEvent(stored, at);
    if (reason) {
      return {
        ok: false,
        checked,
        first,
        last,
        head,
        problem: { seq: reason === 'missing' ? Number(at.nextSeq) : event.seq, reason },
        error: null,
      };
    }
    checked += 1;
    first ??= event.seq;
    last = event.seq;
    head = { seq: event.seq, hash: event.hash };
    at = { nextSeq: stored.seq + 1n, prevHash: event.hash };
  }
  return { ok: true, checked, first, last, head, problem: null, error: null };
}
