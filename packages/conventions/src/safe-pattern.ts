// Patterns that an operator writes into a convention pack (a remark must look like this, a name must match that) are
// matched with this module and not with `new RegExp(...)`. A pack is data that arrives from a person and a pattern is
// a program: with the engine of the language a pattern such as `(a+)+$` takes exponential time on a short value and
// stops the server. This module matches in linear time whatever the pattern is.
//
// How: the structure of the pattern (sequence, alternation, groups, repetition) is parsed here and run as a
// Thompson automaton, which keeps a set of states and never backs up, so the time is the length of the value times the
// size of the automaton. The single characters (a class like `[A-Z]`, `\d`, `\p{L}`, a dot) are decided by code of
// this module as well: no text of a pack is ever handed to the regular expression engine of the language, so there is
// nothing for it to compile, and a pack cannot make it do anything but the answers below. Only the Unicode properties
// are looked up in the engine, and only from a fixed list of constant expressions (see `PROPERTY_LIST`).
//
// The language is a subset on purpose, and it is always anchored: a pattern matches a whole value. Supported: literals,
// `.`, escapes (`\d \D \w \W \s \S \p{..} \P{..} \uXXXX \u{...} \xHH \n \t \r` and an escaped symbol), classes
// `[...]` (members, ranges, `^` for negation, the same escapes), groups `( )`, `(?: )` and named groups (they do not
// capture), alternation `|`, and the quantifiers `* + ? {n} {n,} {n,m}` with an optional lazy `?` (which changes
// nothing for a yes-or-no match). `^` at the very start and `$` at the very end are accepted and ignored. Refused,
// with a message: back-references, lookahead and lookbehind, word boundaries, a quantifier on nothing, an anchor in
// the middle, a count above 64, a pattern longer than 256 characters or one that would need more than 5000 automaton
// states, and a Unicode property that is not in the list.

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

/** The character a letter stands for after a backslash (`\n`, `\t`, ...), or undefined when it stands for none. */
function simpleEscape(letter: string): number | undefined {
  switch (letter) {
    case 'n':
      return 0x0a;
    case 'r':
      return 0x0d;
    case 't':
      return 0x09;
    case 'f':
      return 0x0c;
    case 'v':
      return 0x0b;
    case '0':
      return 0x00;
    default:
      return undefined;
  }
}

const isHex = (text: string): boolean => /^[0-9a-fA-F]+$/u.test(text);

// ---- single characters ------------------------------------------------------------------------------------------

/** What the engine of the language means by `\d`, `\w`, `\s` and `.` (without the `s` flag), written out. */
const isDigit: Test = (cp) => cp >= 0x30 && cp <= 0x39;
const isWord: Test = (cp) =>
  isDigit(cp) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f;
const WHITESPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
const isSpace: Test = (cp) => WHITESPACE.has(cp) || (cp >= 0x2000 && cp <= 0x200a);
const isNotLineBreak: Test = (cp) => cp !== 0x0a && cp !== 0x0d && cp !== 0x2028 && cp !== 0x2029;
const not =
  (test: Test): Test =>
  (cp) =>
    !test(cp);

const literalTest =
  (cp: number): Test =>
  (other) =>
    other === cp;
const literal = (cp: number): Node => ({ t: 'char', test: literalTest(cp) });

/**
 * The Unicode properties a pattern may use, each decided by a regular expression made here from a constant. The
 * properties of the language are many and some are new with every release; a fixed list is a promise that what a pack
 * may ask of the engine is known: general categories, the binary properties that are used for names and remarks, and
 * the scripts people write names in.
 */
const GENERAL_CATEGORIES = [
  'L',
  'Lu',
  'Ll',
  'Lt',
  'Lm',
  'Lo',
  'LC',
  'M',
  'Mn',
  'Mc',
  'Me',
  'N',
  'Nd',
  'Nl',
  'No',
  'P',
  'Pc',
  'Pd',
  'Ps',
  'Pe',
  'Pi',
  'Pf',
  'Po',
  'S',
  'Sm',
  'Sc',
  'Sk',
  'So',
  'Z',
  'Zs',
  'Zl',
  'Zp',
  'C',
  'Cc',
  'Cf',
  'Co',
  'Cn',
  'Letter',
  'Uppercase_Letter',
  'Lowercase_Letter',
  'Titlecase_Letter',
  'Modifier_Letter',
  'Other_Letter',
  'Mark',
  'Number',
  'Decimal_Number',
  'Letter_Number',
  'Other_Number',
  'Punctuation',
  'Symbol',
  'Math_Symbol',
  'Currency_Symbol',
  'Separator',
  'Space_Separator',
  'Other',
] as const;
const BINARY_PROPERTIES = [
  'Any',
  'ASCII',
  'Alphabetic',
  'Uppercase',
  'Lowercase',
  'White_Space',
  'Ideographic',
  'ASCII_Hex_Digit',
  'Hex_Digit',
  'Emoji',
  'Emoji_Presentation',
  'Emoji_Modifier',
  'Emoji_Modifier_Base',
  'Emoji_Component',
  'Extended_Pictographic',
  'Regional_Indicator',
] as const;
const SCRIPTS = [
  'Latin',
  'Cyrillic',
  'Greek',
  'Han',
  'Hiragana',
  'Katakana',
  'Hangul',
  'Arabic',
  'Hebrew',
  'Thai',
  'Devanagari',
  'Armenian',
  'Georgian',
  'Common',
] as const;

/** A test that asks the engine about one character at a time and remembers the answers for a while. */
function propertyTest(expression: string): Test {
  const re = new RegExp(`^\\p{${expression}}$`, 'u');
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

interface Property {
  readonly names: readonly string[];
  readonly test: Test;
}

/** Every property a pattern may use, each with the names it goes by. Built from the constants above and nothing else. */
const PROPERTY_LIST: readonly Property[] = [
  ...[...GENERAL_CATEGORIES, ...BINARY_PROPERTIES].map((name) => ({
    names: [name],
    test: propertyTest(name),
  })),
  ...SCRIPTS.flatMap((script) => [
    { names: [`Script=${script}`, `sc=${script}`], test: propertyTest(`Script=${script}`) },
    {
      names: [`Script_Extensions=${script}`, `scx=${script}`],
      test: propertyTest(`Script_Extensions=${script}`),
    },
  ]),
];

/** The test for a property by its name, searched for in the list: the name only ever selects, it is never used as a key. */
function findProperty(name: string): Test | undefined {
  return PROPERTY_LIST.find((property) => property.names.includes(name))?.test;
}

/** A single character test and, when it stands for exactly one character, which (a range may start or end on it). */
interface Atom {
  readonly test: Test;
  readonly cp: number | null;
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
        return { t: 'char', test: isNotLineBreak };
      case '\\':
        return { t: 'char', test: this.escape(end, false).test };
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
    this.pos += 1;
    let negated = false;
    if (this.chars[this.pos] === '^') {
      negated = true;
      this.pos += 1;
    }
    const singles = new Set<number>();
    const ranges: [number, number][] = [];
    const tests: Test[] = [];
    let members = 0;
    for (;;) {
      if (this.pos >= end) {
        throw new UnsafePatternError('A character class is not closed', open);
      }
      const c = this.chars[this.pos];
      if (c === ']') {
        this.pos += 1;
        break;
      }
      if (c === '[') {
        throw new UnsafePatternError('Nested or set-operation classes are not supported', this.pos);
      }
      const from = this.classAtom(end);
      members += 1;
      const next = this.chars[this.pos + 1];
      if (
        this.chars[this.pos] === '-' &&
        next !== undefined &&
        next !== ']' &&
        this.pos + 1 < end
      ) {
        const at = this.pos;
        this.pos += 1;
        const to = this.classAtom(end);
        if (from.cp === null || to.cp === null) {
          throw new UnsafePatternError(
            'A range cannot start or end with a class such as `\\d`',
            at,
          );
        }
        if (to.cp < from.cp) {
          throw new UnsafePatternError('A range is out of order', at);
        }
        ranges.push([from.cp, to.cp]);
      } else if (from.cp === null) {
        tests.push(from.test);
      } else {
        singles.add(from.cp);
      }
    }
    if (members === 0) {
      throw new UnsafePatternError('A character class is empty', open);
    }
    const inside: Test = (cp) =>
      singles.has(cp) ||
      ranges.some(([low, high]) => cp >= low && cp <= high) ||
      tests.some((test) => test(cp));
    return negated ? not(inside) : inside;
  }

  /** One member of a class: an escape, or a character that stands for itself. */
  private classAtom(end: number): Atom {
    const c = this.chars[this.pos];
    if (c === '\\') {
      return this.escape(end, true);
    }
    const cp = c?.codePointAt(0);
    if (cp === undefined) {
      throw new UnsafePatternError('Unexpected end of the pattern', this.pos);
    }
    this.pos += 1;
    return { test: literalTest(cp), cp };
  }

  /** An escape, outside or inside a class: the test for it and, when it stands for one character, that character. */
  private escape(end: number, inClass: boolean): Atom {
    const at = this.pos;
    const c = this.chars[this.pos + 1];
    if (c === undefined || this.pos + 1 >= end) {
      throw new UnsafePatternError('The pattern ends with a backslash', at);
    }
    this.pos += 2;
    const single = (cp: number): Atom => ({ test: literalTest(cp), cp });
    switch (c) {
      case 'd':
        return { test: isDigit, cp: null };
      case 'D':
        return { test: not(isDigit), cp: null };
      case 'w':
        return { test: isWord, cp: null };
      case 'W':
        return { test: not(isWord), cp: null };
      case 's':
        return { test: isSpace, cp: null };
      case 'S':
        return { test: not(isSpace), cp: null };
      case 'p':
      case 'P': {
        if (this.chars[this.pos] !== '{') {
          throw new UnsafePatternError('`\\p` needs a property in braces, like `\\p{L}`', at);
        }
        const close = this.chars.indexOf('}', this.pos);
        if (close === -1) {
          throw new UnsafePatternError('A property is not closed', at);
        }
        const name = this.chars.slice(this.pos + 1, close).join('');
        const test = findProperty(name);
        if (test === undefined) {
          throw new UnsafePatternError(
            'Not a supported Unicode property: use a general category such as `L` or `Nd`, one of Alphabetic, Uppercase, Lowercase, Emoji, Extended_Pictographic, Regional_Indicator and the like, or `Script=` with Latin, Cyrillic, Greek, Han and the like',
            at,
          );
        }
        this.pos = close + 1;
        return { test: c === 'p' ? test : not(test), cp: null };
      }
      case 'b':
        throw new UnsafePatternError(
          inClass ? 'The escape `\\b` is not supported' : 'Word boundaries are not supported',
          at,
        );
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
          return single(Number.parseInt(hex, 16));
        }
        const hex = this.chars.slice(this.pos, this.pos + 4).join('');
        if (hex.length !== 4 || !isHex(hex)) {
          throw new UnsafePatternError('Not a valid `\\uXXXX` escape', at);
        }
        this.pos += 4;
        return single(Number.parseInt(hex, 16));
      }
      case 'x': {
        const hex = this.chars.slice(this.pos, this.pos + 2).join('');
        if (hex.length !== 2 || !isHex(hex)) {
          throw new UnsafePatternError('Not a valid `\\xHH` escape', at);
        }
        this.pos += 2;
        return single(Number.parseInt(hex, 16));
      }
      default: {
        if (/^[1-9]$/u.test(c)) {
          throw new UnsafePatternError('Back-references are not supported', at);
        }
        const simple = simpleEscape(c);
        if (simple !== undefined) {
          return single(simple);
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
        return single(cp);
      }
    }
  }
}

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
