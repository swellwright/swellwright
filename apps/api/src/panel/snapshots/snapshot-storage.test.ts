import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';

import {
  contentHash,
  SNAPSHOT_CONTENT_FORMAT,
  SNAPSHOT_CONTENT_VERSION,
  type SnapshotContent,
} from '@swellwright/remnawave';

import { CodedHttpException } from '../../http.js';
import { decodeContent, encodeContent, SNAPSHOT_ENCODING } from './snapshot-storage.js';

const config = { name: 'a host', address: '192.0.2.1', tags: ['x'] };
const content: SnapshotContent = {
  format: SNAPSHOT_CONTENT_FORMAT,
  schemaVersion: SNAPSHOT_CONTENT_VERSION,
  maskKeyId: 'abcdef012345',
  kinds: { hosts: [{ id: 'h1', name: 'a host', hash: contentHash(config), config }], nodes: [] },
};
const LIMIT = 1024 * 1024;
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const stored = async (value: unknown = content) => {
  const encoded = await encodeContent(value as SnapshotContent, LIMIT);
  return { encoding: SNAPSHOT_ENCODING, data: encoded.data, sha256: encoded.sha256 };
};

const code = (error: unknown): string | undefined =>
  error instanceof CodedHttpException ? error.apiCode : undefined;

describe('the stored content of a snapshot', () => {
  it('comes back as it went in, compressed and hashed', async () => {
    const encoded = await encodeContent(content, LIMIT);
    assert.equal(encoded.rawBytes, Buffer.byteLength(JSON.stringify(content)));
    assert.match(encoded.sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(await decodeContent(await stored(), LIMIT), content);
  });

  it('refuses to store more than the limit, with the numbers, and says 413', async () => {
    await assert.rejects(encodeContent(content, 100), (error) => {
      assert.equal(code(error), 'snapshot_too_large');
      assert.equal((error as CodedHttpException).getStatus(), 413);
      return true;
    });
  });

  it('is corrupt when a byte changed, the encoding is unknown, the data is not gzip or not JSON, or not a snapshot', async () => {
    const good = await stored();
    const flipped = Buffer.from(good.data);
    flipped[flipped.length - 9] = (flipped[flipped.length - 9] ?? 0) ^ 1;
    const notJson = gzipSync(Buffer.from('not json at all'));
    const notSnapshot = gzipSync(Buffer.from(JSON.stringify({ hello: 'world' })));
    const badItem = gzipSync(
      Buffer.from(JSON.stringify({ ...content, kinds: { hosts: [{ id: 1 }] } })),
    );
    const cases: [string, { encoding: string; data: Uint8Array; sha256: string }][] = [
      ['a changed byte', { ...good, data: flipped }],
      ['an unknown encoding', { ...good, encoding: 'zstd' }],
    ];
    for (const [what, row] of cases) {
      await assert.rejects(
        decodeContent(row, LIMIT),
        (error) => code(error) === 'snapshot_corrupt',
        what,
      );
    }
    // The hash is of the stored bytes, so the other three need a matching hash to get past it.
    for (const [what, data] of [
      ['data that is not gzip', Buffer.from('plain text')],
      ['gzip that is not JSON', notJson],
      ['JSON that is not a snapshot', notSnapshot],
      ['an item without a hash', badItem],
    ] as const) {
      const row = { encoding: SNAPSHOT_ENCODING, data, sha256: sha256(data) };
      await assert.rejects(
        decodeContent(row, LIMIT),
        (error) => code(error) === 'snapshot_corrupt',
        what,
      );
    }
  });

  it('does not inflate more than the limit allows', async () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
    const row = { encoding: SNAPSHOT_ENCODING, data: bomb, sha256: sha256(bomb) };
    await assert.rejects(decodeContent(row, 1024), (error) => code(error) === 'snapshot_corrupt');
  });
});
