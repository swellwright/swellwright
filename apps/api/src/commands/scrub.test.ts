import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OutputScrubber } from './scrub.js';

const TOKEN = 'tok_9f3a7c51d2b84e60';
const scrubber = (...secrets: [string, string][]): OutputScrubber =>
  new OutputScrubber(secrets.map(([name, value]) => ({ name, value })));

/**
 * What the runner does with a stream: reads it in pieces, and bytes that were held back are read again with the next
 * piece (the piece grows by what was held, as a later poll finds the file longer).
 */
function throughPieces(s: OutputScrubber, text: Buffer, size: number): string {
  const out: Buffer[] = [];
  let read = 0;
  let carry = 0;
  while (read < text.length) {
    const end = Math.min(text.length, read + carry + size);
    const piece = text.subarray(read, end);
    const result = s.scrub(piece, { final: end === text.length });
    out.push(result.out);
    read += result.consumed;
    carry = piece.length - result.consumed;
  }
  return Buffer.concat(out).toString('utf8');
}

describe('scrubbing the output of a run', () => {
  it('replaces the value wherever it occurs, with a marker that names the secret', () => {
    const s = scrubber(['NODE_KEY', TOKEN]);
    const result = s.scrub(Buffer.from(`key=${TOKEN} again ${TOKEN}!\n`), { final: true });
    assert.equal(result.out.toString(), 'key=[secret NODE_KEY] again [secret NODE_KEY]!\n');
    assert.equal(result.consumed, `key=${TOKEN} again ${TOKEN}!\n`.length);
  });

  it('handles several secrets, and prefers the longer one where two start in the same place', () => {
    const s = scrubber(['SHORT', 'abcd'], ['LONG', 'abcdefgh'], ['OTHER', 'zzzz']);
    const result = s.scrub(Buffer.from('abcdefgh abcd zzzz abc'), { final: true });
    assert.equal(result.out.toString(), '[secret LONG] [secret SHORT] [secret OTHER] abc');
  });

  it('looks for the value without its trailing line break, and keeps the line break', () => {
    const s = scrubber(['FILE', `${TOKEN}\n`]);
    const cat = s.scrub(Buffer.from(`${TOKEN}\nnext line\n`), { final: true });
    assert.equal(cat.out.toString(), '[secret FILE]\nnext line\n', 'a printed file');
    const echo = s.scrub(Buffer.from(`token: ${TOKEN}\n`), { final: true });
    assert.equal(
      echo.out.toString(),
      'token: [secret FILE]\n',
      'a printed value without the break',
    );
    const windows = scrubber(['W', `${TOKEN}\r\n`]).scrub(Buffer.from(`${TOKEN}\r\n`), {
      final: true,
    });
    assert.equal(windows.out.toString(), '[secret W]\r\n');
  });

  it('finds a value in the middle of a multi-line secret, and a secret of several lines whole', () => {
    const value = 'line one\nline two\nline three';
    const result = scrubber(['PEM', value]).scrub(Buffer.from(`x ${value} y`), { final: true });
    assert.equal(result.out.toString(), 'x [secret PEM] y');
  });

  it('holds back a tail that may be the start of a value, and releases it at the end', () => {
    const s = scrubber(['K', 'abcdef']);
    const first = s.scrub(Buffer.from('hello abc'), { final: false });
    assert.equal(first.out.toString(), 'hello ');
    assert.equal(first.consumed, 6);
    const last = s.scrub(Buffer.from('abc'), { final: true });
    assert.equal(last.out.toString(), 'abc', 'nothing more will come: it was only text');
    assert.equal(last.consumed, 3);
    // Nothing that cannot start a value is held.
    const plain = s.scrub(Buffer.from('hello xyz'), { final: false });
    assert.equal(plain.out.toString(), 'hello xyz');
    assert.equal(plain.consumed, 9);
  });

  it('finds a value that is split over two pieces, wherever the split falls', () => {
    const text = Buffer.from(`before ${TOKEN} middle ${TOKEN} after\n`);
    const whole = scrubber(['NODE_KEY', TOKEN]).scrub(text, { final: true }).out.toString();
    assert.equal(whole, 'before [secret NODE_KEY] middle [secret NODE_KEY] after\n');
    for (let size = 1; size <= text.length; size += 1) {
      assert.equal(
        throughPieces(scrubber(['NODE_KEY', TOKEN]), text, size),
        whole,
        `read in pieces of ${String(size)}`,
      );
    }
  });

  it('does not touch bytes that are not text, and finds a value of multi-byte characters', () => {
    const odd = 'пароль-€-😀';
    const binary = Buffer.concat([
      Buffer.from([0, 1, 2, 255, 254]),
      Buffer.from(odd),
      Buffer.from([0, 0xc3]),
    ]);
    const result = scrubber(['P', odd]).scrub(binary, { final: true });
    assert.deepEqual([...result.out], [0, 1, 2, 255, 254, ...Buffer.from('[secret P]'), 0, 0xc3]);
    for (let size = 1; size <= binary.length; size += 1) {
      const stream = scrubber(['P', odd]);
      assert.equal(
        throughPieces(stream, binary, size),
        result.out.toString('utf8'),
        `pieces of ${String(size)}`,
      );
    }
  });

  it('does nothing without secrets, and ignores a secret that is only line breaks', () => {
    const none = new OutputScrubber([]);
    assert.equal(none.active, false);
    assert.equal(none.scrub(Buffer.from('anything'), { final: false }).consumed, 8);
    const breaks = scrubber(['B', '\n\n']);
    assert.equal(
      breaks.scrub(Buffer.from('a\n\nb'), { final: true }).out.toString(),
      'a[secret B]b',
    );
  });
});
