// Patterns that an operator writes into a convention pack (a remark must look like this, a name must match that) are
// matched with this module and not with `new RegExp(...)`. A pack is data that arrives from a person and a pattern is
// a program: with the engine of the language a pattern such as `(a+)+$` takes exponential time on a short value and
// stops the server. This module matches in linear time whatever the pattern is.
//
// How: the structure of the pattern (sequence, alternation, groups, repetition) is parsed here and run as a
// Thompson automaton, which keeps a set of states and never backs up, so the time is the length of the value times the
// size of the automaton. The single characters (a class like `[A-Z]`, `\d`, `\p{L}`, a dot) are tested with the
// built-in engine, one character at a time, which cannot back up either.
//
// The language is a subset on purpose, and it is always anchored: a pattern matches a whole value. Supported: literals,
// `.`, escapes (`\d \D \w \W \s \S \p{..} \P{..} \uXXXX \u{...} \xHH \n \t \r` and an escaped symbol), classes
// `[...]`, groups `( )`, `(?: )` and named groups (they do not capture), alternation `|`, and the quantifiers
// `* + ? {n} {n,} {n,m}` with an optional lazy `?` (which changes nothing for a yes-or-no match). `^` at the very start
// and `$` at the very end are accepted and ignored. Refused, with a message: back-references, lookahead and
// lookbehind, word boundaries, a quantifier on nothing, an anchor in the middle, a count above 64, a pattern longer
// than 256 characters or one that would need more than 5000 automaton states.

export class UnsafePatternError extends Error {
  constructor(
    message: string,
    readonly position: number | null = null,
  ) {
    super(position === null ? message : `${message} (at character ${String(position + 1)})`);
    this.name = 'UnsafePatternError';
  }
}

export const PATTERN_LIMITS = {
  sourceChars: 256,
  /** The most a quantifier may repeat or require. */
  count: 64,
  /** The size of the automaton after counted repetitions are written out. */
  states: 5000,
  /** A value longer than this does not match. */
  valueChars: 512,
} as const;

type Test = (codePoint: number) => boolean;

type Node =
  | { readonly t: 'empty' }
  | { readonly t: 'char'; readonly test: Test }
  | { readonly t: 'cat'; readonly items: readonly Node[] }
  | { readonly t: 'alt'; readonly items: readonly Node[] }
  | { readonly t: 'rep'; readonly node: Node; readonly min: number; readonly max: number };

// ---- parsing ----------------------------------------------------------------------------------------------------

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  f: 0x0c,
  v: 0x0b,
  '0': 0x00,
};

const isHex = (text: string): boolean => /^[0-9a-fA-F]+$/u.test(text);

/** A test for one character that the built-in engine decides: a class, a property, a shorthand. */
function nativeTest(source: string, position: number): Test {
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${source})$`, 'u');
  } catch {
    throw new UnsafePatternError('Not a valid character class or escape', position);
  }
  const cache = new Map<number, boolean>();
  return (cp) => {
    const known = cache.get(cp);
    if (known !== undefined) {
      return known;
    }
    const result = re.test(String.fromCodePoint(cp));
    if (cache.size < 4096) {
      cache.set(cp, result);
    }
    return result;
  };
}

class Parser {
  private pos = 0;
  private nodes = 0;
  private readonly chars: readonly string[];

  constructor(readonly source: string) {
    this.chars = Array.from(source);
  }

  parse(): Node {
    let end = this.chars.length;
    if (this.chars[0] === '^') {
      this.pos = 1;
    }
    if (end > this.pos && this.chars[end - 1] === '$') {
      // The `$` is an anchor unless an odd number of backslashes escapes it.
      let slashes = 0;
      while (end - 2 - slashes >= this.pos && this.chars[end - 2 - slashes] === '\\') {
        slashes += 1;
      }
      if (slashes % 2 === 0) {
        end -= 1;
      }
    }
    const node = this.alternation(end, 0);
    if (this.pos < end) {
      // Only a stray `)` can stop the parse early.
      throw new UnsafePatternError('Unbalanced parenthesis', this.pos);
    }
    return node;
  }

  private count(): void {
    this.nodes += 1;
    if (this.nodes > PATTERN_LIMITS.states) {
      throw new UnsafePatternError('The pattern is too large');
    }
  }

  private alternation(end: number, depth: number): Node {
    if (depth > 32) {
      throw new UnsafePatternError('Groups are nested too deeply', this.pos);
    }
    const branches: Node[] = [this.concatenation(end, depth)];
    while (this.pos < end && this.chars[this.pos] === '|') {
      this.pos += 1;
      branches.push(this.concatenation(end, depth));
    }
    return branches.length === 1 ? (branches[0] ?? { t: 'empty' }) : { t: 'alt', items: branches };
  }

  private concatenation(end: number, depth: number): Node {
    const items: Node[] = [];
    while (this.pos < end) {
      const c = this.chars[this.pos];
      if (c === '|' || c === ')') {
        break;
      }
      items.push(this.repetition(end, depth));
    }
    if (items.length === 0) {
      return { t: 'empty' };
    }
    return items.length === 1 ? (items[0] ?? { t: 'empty' }) : { t: 'cat', items };
  }

  private repetition(end: number, depth: number): Node {
    const start = this.pos;
    const atom = this.atom(end, depth);
    const quantifier = this.quantifier(end);
    if (quantifier === null) {
      return atom;
    }
    const finiteMax = quantifier.max !== Number.POSITIVE_INFINITY;
    if (
      quantifier.min > PATTERN_LIMITS.count ||
      (finiteMax && quantifier.max > PATTERN_LIMITS.count)
    ) {
      throw new UnsafePatternError(
        `A repeat count is above ${String(PATTERN_LIMITS.count)}`,
        start,
      );
    }
    this.count();
    return { t: 'rep', node: atom, min: quantifier.min, max: quantifier.max };
  }

  private quantifier(end: number): { min: number; max: number } | null {
    const c = this.chars[this.pos];
    let result: { min: number; max: number } | null = null;
    if (this.pos >= end) {
      return null;
    }
    if (c === '*') {
      result = { min: 0, max: Number.POSITIVE_INFINITY };
      this.pos += 1;
    } else if (c === '+') {
      result = { min: 1, max: Number.POSITIVE_INFINITY };
      this.pos += 1;
    } else if (c === '?') {
      result = { min: 0, max: 1 };
      this.pos += 1;
    } else if (c === '{') {
      const close = this.chars.indexOf('}', this.pos);
      if (close !== -1 && close < end) {
        const body = this.chars.slice(this.pos + 1, close).join('');
        const match = /^(\d{1,4})(?:(,)(\d{1,4})?)?$/u.exec(body);
        if (match) {
          const min = Number(match[1]);
          const max =
            match[2] === undefined
              ? min
              : match[3] === undefined
                ? Number.POSITIVE_INFINITY
                : Number(match[3]);
          if (max < min) {
            throw new UnsafePatternError(
              'A repeat count has its maximum below its minimum',
              this.pos,
            );
          }
          result = { min, max };
          this.pos = close + 1;
        }
      }
    }
    if (result === null) {
      return null;
    }
    // A lazy marker changes which match is found first, not whether there is one. A possessive one is not supported.
    if (this.pos < end && this.chars[this.pos] === '?') {
      this.pos += 1;
    } else if (this.pos < end && this.chars[this.pos] === '+') {
      throw new UnsafePatternError('Possessive quantifiers are not supported', this.pos);
    }
    if (this.pos < end && '*+?'.includes(this.chars[this.pos] ?? '')) {
      throw new UnsafePatternError('A quantifier follows a quantifier', this.pos);
    }
    return result;
  }

  private atom(end: number, depth: number): Node {
    const c = this.chars[this.pos] ?? '';
    const at = this.pos;
    this.count();
    switch (c) {
      case '(':
        return this.group(end, depth);
      case '[':
        return { t: 'char', test: this.charClass(end) };
      case '.':
        this.pos += 1;
        return { t: 'char', test: nativeTest('.', at) };
      case '\\':
        return { t: 'char', test: this.escape(end) };
      case '*':
      case '+':
      case '?':
        throw new UnsafePatternError('A quantifier has nothing to repeat', at);
      case '{': {
        // A `{` that is not a quantifier is an ordinary character, as in most dialects.
        this.pos += 1;
        return literal(0x7b);
      }
      case '^':
      case '$':
        throw new UnsafePatternError(
          'An anchor is only accepted at the very start (`^`) or the very end (`$`); a pattern always matches the whole value',
          at,
        );
      default: {
        this.pos += 1;
        const cp = c.codePointAt(0);
        if (cp === undefined) {
          throw new UnsafePatternError('Unexpected end of the pattern', at);
        }
        return literal(cp);
      }
    }
  }

  private group(end: number, depth: number): Node {
    const open = this.pos;
    this.pos += 1;
    if (this.chars[this.pos] === '?') {
      const next = this.chars[this.pos + 1];
      if (next === ':') {
        this.pos += 2;
      } else if (
        next === '<' &&
        this.chars[this.pos + 2] !== '=' &&
        this.chars[this.pos + 2] !== '!'
      ) {
        const close = this.chars.indexOf('>', this.pos);
        const name = close === -1 ? '' : this.chars.slice(this.pos + 2, close).join('');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
          throw new UnsafePatternError('A group name is not valid', this.pos);
        }
        this.pos = close + 1;
      } else {
        throw new UnsafePatternError(
          'Lookahead, lookbehind and other group modifiers are not supported',
          this.pos,
        );
      }
    }
    const inner = this.alternation(end, depth + 1);
    if (this.chars[this.pos] !== ')' || this.pos >= end) {
      throw new UnsafePatternError('A parenthesis is not closed', open);
    }
    this.pos += 1;
    return inner;
  }

  private charClass(end: number): Test {
    const open = this.pos;
    let i = this.pos + 1;
    if (this.chars[i] === '^') {
      i += 1;
    }
    // A `]` right after the opening is an ordinary member in some dialects and an empty class in others: refuse the doubt.
    while (i < end) {
      const c = this.chars[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '[') {
        throw new UnsafePatternError('Nested or set-operation classes are not supported', i);
      }
      if (c === ']') {
        break;
      }
      i += 1;
    }
    if (i >= end || this.chars[i] !== ']') {
      throw new UnsafePatternError('A character class is not closed', open);
    }
    const text = this.chars.slice(open, i + 1).join('');
    if (text === '[]' || text === '[^]') {
      throw new UnsafePatternError('A character class is empty', open);
    }
    this.pos = i + 1;
    return nativeTest(text, open);
  }

  private escape(end: number): Test {
    const at = this.pos;
    const c = this.chars[this.pos + 1];
    if (c === undefined || this.pos + 1 >= end) {
      throw new UnsafePatternError('The pattern ends with a backslash', at);
    }
    this.pos += 2;
    switch (c) {
      case 'd':
      case 'D':
      case 'w':
      case 'W':
      case 's':
      case 'S':
        return nativeTest(`\\${c}`, at);
      case 'p':
      case 'P': {
        if (this.chars[this.pos] !== '{') {
          throw new UnsafePatternError('`\\p` needs a property in braces, like `\\p{L}`', at);
        }
        const close = this.chars.indexOf('}', this.pos);
        if (close === -1) {
          throw new UnsafePatternError('A property is not closed', at);
        }
        const name = this.chars.slice(this.pos, close + 1).join('');
        this.pos = close + 1;
        return nativeTest(`\\${c}${name}`, at);
      }
      case 'b':
      case 'B':
        throw new UnsafePatternError('Word boundaries are not supported', at);
      case 'k':
        throw new UnsafePatternError('Back-references are not supported', at);
      case 'u': {
        if (this.chars[this.pos] === '{') {
          const close = this.chars.indexOf('}', this.pos);
          const hex = close === -1 ? '' : this.chars.slice(this.pos + 1, close).join('');
          if (!isHex(hex) || hex.length > 6 || Number.parseInt(hex, 16) > 0x10ffff) {
            throw new UnsafePatternError('Not a valid code point escape', at);
          }
          this.pos = close + 1;
          return literalTest(Number.parseInt(hex, 16));
        }
        const hex = this.chars.slice(this.pos, this.pos + 4).join('');
        if (hex.length !== 4 || !isHex(hex)) {
          throw new UnsafePatternError('Not a valid `\\uXXXX` escape', at);
        }
        this.pos += 4;
        return literalTest(Number.parseInt(hex, 16));
      }
      case 'x': {
        const hex = this.chars.slice(this.pos, this.pos + 2).join('');
        if (hex.length !== 2 || !isHex(hex)) {
          throw new UnsafePatternError('Not a valid `\\xHH` escape', at);
        }
        this.pos += 2;
        return literalTest(Number.parseInt(hex, 16));
      }
      default: {
        if (/^[1-9]$/u.test(c)) {
          throw new UnsafePatternError('Back-references are not supported', at);
        }
        const simple = SIMPLE_ESCAPES[c];
        if (simple !== undefined) {
          return literalTest(simple);
        }
        // An escaped symbol or a letter that means nothing special stands for itself; escaped letters are refused,
        // since `\a` would mean different things in different dialects.
        if (/^[A-Za-z]$/u.test(c)) {
          throw new UnsafePatternError(`The escape \`\\${c}\` is not supported`, at);
        }
        const cp = c.codePointAt(0);
        if (cp === undefined) {
          throw new UnsafePatternError('Unexpected end of the pattern', at);
        }
        return literalTest(cp);
      }
    }
  }
}

const literalTest =
  (cp: number): Test =>
  (other) =>
    other === cp;
const literal = (cp: number): Node => ({ t: 'char', test: literalTest(cp) });

// ---- the automaton ----------------------------------------------------------------------------------------------

type State =
  | { readonly k: 'char'; readonly test: Test; next: number }
  | { readonly k: 'split'; a: number; b: number }
  | { readonly k: 'jump'; next: number }
  | { readonly k: 'match' };

interface Fragment {
  readonly start: number;
  /** The states whose `next` is still to be connected. */
  readonly outs: readonly Hole[];
}
interface Hole {
  state: number;
  slot: 'next' | 'a' | 'b';
}

class Builder {
  readonly states: State[] = [];

  private add(state: State): number {
    if (this.states.length >= PATTERN_LIMITS.states) {
      throw new UnsafePatternError('The pattern is too large once repeats are written out');
    }
    this.states.push(state);
    return this.states.length - 1;
  }

  private patch(holes: readonly Hole[], target: number): void {
    for (const hole of holes) {
      const state = this.states[hole.state];
      if (state === undefined) {
        continue;
      }
      if (state.k === 'split') {
        if (hole.slot === 'a') {
          state.a = target;
        } else {
          state.b = target;
        }
      } else if (state.k !== 'match') {
        state.next = target;
      }
    }
  }

  build(node: Node): Fragment {
    switch (node.t) {
      case 'empty': {
        const s = this.add({ k: 'jump', next: -1 });
        return { start: s, outs: [{ state: s, slot: 'next' }] };
      }
      case 'char': {
        const s = this.add({ k: 'char', test: node.test, next: -1 });
        return { start: s, outs: [{ state: s, slot: 'next' }] };
      }
      case 'cat': {
        let first: Fragment | null = null;
        let last: Fragment | null = null;
        for (const item of node.items) {
          const fragment = this.build(item);
          if (last === null) {
            first = fragment;
          } else {
            this.patch(last.outs, fragment.start);
          }
          last = fragment;
        }
        if (first === null || last === null) {
          return this.build({ t: 'empty' });
        }
        return { start: first.start, outs: last.outs };
      }
      case 'alt': {
        const fragments = node.items.map((item) => this.build(item));
        let start = fragments[fragments.length - 1]?.start ?? -1;
        for (let i = fragments.length - 2; i >= 0; i -= 1) {
          const head = fragments[i];
          if (head === undefined) {
            continue;
          }
          start = this.add({ k: 'split', a: head.start, b: start });
        }
        return { start, outs: fragments.flatMap((f) => [...f.outs]) };
      }
      case 'rep':
        return this.repeat(node);
    }
  }

  private repeat(node: Extract<Node, { t: 'rep' }>): Fragment {
    const parts: Fragment[] = [];
    for (let i = 0; i < node.min; i += 1) {
      parts.push(this.build(node.node));
    }
    if (node.max === Number.POSITIVE_INFINITY) {
      // x* : split -> x -> back to split; leaving goes out of the split.
      const body = this.build(node.node);
      const split = this.add({ k: 'split', a: body.start, b: -1 });
      this.patch(body.outs, split);
      parts.push({ start: split, outs: [{ state: split, slot: 'b' }] });
    } else {
      // (x(x(x)?)?)? : each optional copy can be skipped, and skipping ends it all.
      const optional = node.max - node.min;
      const skips: Hole[] = [];
      let first: Fragment | null = null;
      let previous: Fragment | null = null;
      for (let i = 0; i < optional; i += 1) {
        const body = this.build(node.node);
        const split = this.add({ k: 'split', a: body.start, b: -1 });
        skips.push({ state: split, slot: 'b' });
        if (previous !== null) {
          this.patch(previous.outs, split);
        }
        previous = { start: split, outs: body.outs };
        first ??= previous;
      }
      if (first !== null && previous !== null) {
        parts.push({ start: first.start, outs: [...previous.outs, ...skips] });
      }
    }
    if (parts.length === 0) {
      return this.build({ t: 'empty' });
    }
    for (let i = 1; i < parts.length; i += 1) {
      const before = parts[i - 1];
      const here = parts[i];
      if (before !== undefined && here !== undefined) {
        this.patch(before.outs, here.start);
      }
    }
    const head = parts[0];
    const tail = parts[parts.length - 1];
    if (head === undefined || tail === undefined) {
      return this.build({ t: 'empty' });
    }
    return { start: head.start, outs: tail.outs };
  }

  finish(fragment: Fragment): { states: State[]; start: number; accept: number } {
    const accept = this.add({ k: 'match' });
    this.patch(fragment.outs, accept);
    return { states: this.states, start: fragment.start, accept };
  }
}

// ---- matching ---------------------------------------------------------------------------------------------------

export interface CompiledPattern {
  readonly source: string;
  /** Whether the pattern matches the whole value. Linear in the length of the value. */
  matches(value: string): boolean;
}

class Automaton implements CompiledPattern {
  constructor(
    readonly source: string,
    private readonly states: readonly State[],
    private readonly start: number,
    private readonly accept: number,
  ) {}

  matches(value: string): boolean {
    if (value.length > PATTERN_LIMITS.valueChars) {
      return false;
    }
    const size = this.states.length;
    let current = new Uint32Array(size);
    let next = new Uint32Array(size);
    let stamp = 1;
    const marks = new Uint32Array(size);

    const closure = (
      from: number,
      into: Uint32Array,
      count: number,
      mark: Uint32Array,
      at: number,
    ): number => {
      const stack = [from];
      let n = count;
      while (stack.length > 0) {
        const index = stack.pop();
        if (index === undefined || index < 0 || mark[index] === at) {
          continue;
        }
        mark[index] = at;
        const state = this.states[index];
        if (state === undefined) {
          continue;
        }
        if (state.k === 'split') {
          stack.push(state.b, state.a);
        } else if (state.k === 'jump') {
          stack.push(state.next);
        } else {
          into[n] = index;
          n += 1;
        }
      }
      return n;
    };

    let currentCount = closure(this.start, current, 0, marks, stamp);
    for (const ch of value) {
      const cp = ch.codePointAt(0) ?? 0;
      stamp += 1;
      let nextCount = 0;
      for (let i = 0; i < currentCount; i += 1) {
        const state = this.states[current[i] ?? 0];
        if (state?.k === 'char' && state.test(cp)) {
          nextCount = closure(state.next, next, nextCount, marks, stamp);
        }
      }
      [current, next] = [next, current];
      currentCount = nextCount;
      if (currentCount === 0) {
        return false;
      }
    }
    for (let i = 0; i < currentCount; i += 1) {
      if (current[i] === this.accept) {
        return true;
      }
    }
    return false;
  }
}

/** Compiles a pattern, or throws `UnsafePatternError` with a message an operator can act on. */
export function compilePattern(source: string): CompiledPattern {
  if (source.length === 0) {
    throw new UnsafePatternError('The pattern is empty');
  }
  if (source.length > PATTERN_LIMITS.sourceChars) {
    throw new UnsafePatternError(
      `The pattern is longer than ${String(PATTERN_LIMITS.sourceChars)} characters`,
    );
  }
  const tree = new Parser(source).parse();
  const builder = new Builder();
  const { states, start, accept } = builder.finish(builder.build(tree));
  return new Automaton(source, states, start, accept);
}

/** The reason a pattern is refused, or null when it is fine. */
export function patternProblem(source: string): string | null {
  try {
    compilePattern(source);
    return null;
  } catch (error) {
    if (error instanceof UnsafePatternError) {
      return error.message;
    }
    throw error;
  }
}
