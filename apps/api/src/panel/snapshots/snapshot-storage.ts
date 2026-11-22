import { createHash } from 'node:crypto';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import { PANEL_SNAPSHOT_OBJECT_KINDS } from '@swellwright/contracts';
import {
  SNAPSHOT_CONTENT_FORMAT,
  SNAPSHOT_CONTENT_VERSION,
  type SnapshotContent,
} from '@swellwright/remnawave';
import { z } from 'zod';

import { CodedHttpException } from '../../http.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const SNAPSHOT_ENCODING = 'gzip';

export interface EncodedContent {
  /** The gzip of the JSON of the content. */
  readonly data: Buffer;
  /** SHA-256 (hex) of `data`: checked when the content is read, so that a damaged row is found and not believed. */
  readonly sha256: string;
  /** The size of the JSON before compression. */
  readonly rawBytes: number;
}

/** What a snapshot would be and may not be: bigger than the cap is refused before anything is stored. */
export function tooLarge(rawBytes: number, maxBytes: number): CodedHttpException {
  const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  return new CodedHttpException(
    413,
    'snapshot_too_large',
    `The snapshot would hold ${mib(rawBytes)} MiB, and the limit is ${mib(maxBytes)} MiB (SW_PANEL_SNAPSHOT_MAX_MIB).`,
    { bytes: rawBytes, limit: maxBytes },
  );
}

/** The content as stored: JSON, gzipped, hashed. Throws 413 when the JSON is larger than `maxBytes`. */
export async function encodeContent(
  content: SnapshotContent,
  maxBytes: number,
): Promise<EncodedContent> {
  const json = Buffer.from(JSON.stringify(content), 'utf8');
  if (json.length > maxBytes) {
    throw tooLarge(json.length, maxBytes);
  }
  const data = await gzipAsync(json, { level: 6 });
  return { data, sha256: createHash('sha256').update(data).digest('hex'), rawBytes: json.length };
}

const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string().regex(/^[0-9a-f]{64}$/u),
  config: z.unknown(),
});

const ContentSchema = z.object({
  format: z.literal(SNAPSHOT_CONTENT_FORMAT),
  schemaVersion: z.literal(SNAPSHOT_CONTENT_VERSION),
  maskKeyId: z.string(),
  kinds: z.partialRecord(z.enum(PANEL_SNAPSHOT_OBJECT_KINDS), z.array(ItemSchema)),
});

const corrupt = (why: string): CodedHttpException =>
  new CodedHttpException(
    409,
    'snapshot_corrupt',
    `The stored content of this snapshot cannot be read (${why}). Delete it and take another one.`,
  );

/** The content from the stored bytes. A row that does not match its hash, or is not a snapshot, is `snapshot_corrupt`. */
export async function decodeContent(
  stored: { readonly encoding: string; readonly data: Uint8Array; readonly sha256: string },
  maxBytes: number,
): Promise<SnapshotContent> {
  const data = Buffer.from(stored.data);
  if (stored.encoding !== SNAPSHOT_ENCODING) {
    throw corrupt('an encoding this release does not know');
  }
  if (createHash('sha256').update(data).digest('hex') !== stored.sha256) {
    throw corrupt('the bytes do not match their hash');
  }
  let json: Buffer;
  try {
    // A little more than the cap: a snapshot is refused above it when made, and what comes out is bounded all the same.
    json = await gunzipAsync(data, { maxOutputLength: maxBytes + 1024 * 1024 });
  } catch {
    throw corrupt('the compressed data is damaged');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch {
    throw corrupt('the content is not JSON');
  }
  const checked = ContentSchema.safeParse(parsed);
  if (!checked.success) {
    throw corrupt('the content is not in the format of a snapshot');
  }
  const kinds: SnapshotContent['kinds'] = {};
  for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
    const items = checked.data.kinds[kind];
    if (items !== undefined) {
      kinds[kind] = items;
    }
  }
  return {
    format: SNAPSHOT_CONTENT_FORMAT,
    schemaVersion: SNAPSHOT_CONTENT_VERSION,
    maskKeyId: checked.data.maskKeyId,
    kinds,
  };
}
