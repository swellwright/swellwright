// A bound on how long a regular expression that a person wrote can make the engine of the language work. JavaScript's
// engine backtracks: a pattern such as `(a|a)*b` takes exponential time and `.*.*.*x` polynomial time on a short text,
// and either can stop the API, which runs a check on its one event loop. This module reads the structure of a pattern
// (no engine runs it) and estimates, from above, how many ways the engine can try to match one text: every place where
// the engine has a choice multiplies the estimate by the number of choices. A pattern whose estimate is over the budget
// is refused with a sentence a person can act on.
//
// The choices that count:
// - a repetition whose end is not decided by the next character (`.*` followed by `x`: `.` takes `x` too) offers one
//   choice per character of the text; one whose end is decided (`[a-z]+` followed by `=`, `\d+` at the end) offers one;
// - a bounded repetition `{n,m}` and `?` that are not decided the same way offer `m - n + 1` and 2;
// - an alternation offers one choice per branch, unless the first characters of the branches tell them apart;
// - a repetition of a part that itself has choices (`(a|a)*`, `(a+)+`, `(a?)*`) is refused outright: that is where the
//   exponential cases are.
// Each way can cost up to the length of the text before it fails (a long fixed suffix is matched again for every way),
// so the work is the ways times the length of the text. What it cannot tell apart (a Unicode property, a lookaround, a
// case-insensitive group) counts as "could be any character".
//
// The estimate is a first filter with a readable answer, not the guarantee: an estimate can be wrong. Every place that
// runs a person's pattern also runs it under a deadline (`apps/api/src/common/regex-deadline.ts`).

/** The longest text a bounded pattern is run on. Every caller cuts its input to this before it matches. */
export const REGEX_INPUT_LIMIT = 1000;

/** Steps of the engine (ways times the length of the text) at most. */
const BUDGET = 2_000_000;
const CAP = 1e15;

/** The largest count a `{n}`, `{n,}` or `{n,m}` may give. */
const MAX_COUNT = REGEX_INPUT_LIMIT;

const mul = (a: number, b: number): number => Math.min(CAP, a * b);
/** `base` to the power `exponent`, capped, without a loop over the exponent. */
const pow = (base: number, exponent: number): number =>
  base <= 1 || exponent === 0 ? 1 : Math.min(CAP, base ** exponent);
const add = (a: number, b: number): number => Math.min(CAP, a + b);

/**
 * A set of code points, with a pseudo code point for the end of the text. A set that is not `exact` is an
 * approximation from above (a Unicode property, a case-insensitive letter): it is treated as every character, and
 * its complement is every character too, never the empty set that complementing "every character" would give.
 */
class CharSet {
  constructor(
    readonly ranges: readonly (readonly [number, number])[],
    readonly end = false,
    readonly exact = true,
  ) {}

  static readonly none = new CharSet([]);
  static readonly all = new CharSet([[0, 0x10ffff]]);
  /** What this module cannot tell exactly: any character, and complemented, any character again. */
  static readonly unknown = new CharSet([[0, 0x10ffff]], false, false);
  static readonly endOfLine = new CharSet(
    [
      [0x0a, 0x0a],
      [0x0d, 0x0d],
      [0x2028, 0x2029],
    ],
    true,
  );

  static of(codePoint: number): CharSet {
    return new CharSet([[codePoint, codePoint]]);
  }

  union(other: CharSet): CharSet {
    if (!this.exact || !other.exact) {
      return new CharSet(CharSet.unknown.ranges, this.end || other.end, false);
    }
    return new CharSet([...this.ranges, ...other.ranges], this.end || other.end);
  }

  overlaps(other: CharSet): boolean {
    if (this.end && other.end) {
      return true;
    }
    return this.ranges.some(([lo, hi]) =>
      other.ranges.some(([otherLo, otherHi]) => lo <= otherHi && otherLo <= hi),
    );
  }

  complement(): CharSet {
    if (!this.exact) {
      return CharSet.unknown;
    }
    const sorted = [...this.ranges].sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    let next = 0;
    for (const [lo, hi] of sorted) {
      if (lo > next) {
        out.push([next, lo - 1]);
      }
      next = Math.max(next, hi + 1);
    }
    if (next <= 0x10ffff) {
      out.push([next, 0x10ffff]);
    }
    return new CharSet(out);
  }
}

const DIGIT = new CharSet([[0x30, 0x39]]);
const WORD = new CharSet([
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
]);
const SPACE = new CharSet([
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]);

type Node =
  | { readonly t: 'char'; readonly set: CharSet }
  /** `^`, `\b`, `\B`: a condition that consumes nothing. */
  | { readonly t: 'assert' }
  /** `$`: the next thing is the end of the text or of a line. */
  | { readonly t: 'end' }
  | { readonly t: 'look'; readonly node: Node }
  | { readonly t: 'seq'; readonly items: readonly Node[] }
  | { readonly t: 'alt'; readonly items: readonly Node[] }
  | { readonly t: 'rep'; readonly node: Node; readonly min: number; readonly max: number };

class RegexBudgetError extends Error {}

/** Reads a pattern that the engine already accepted with the `u` flag. */
class Reader {
  private pos = 0;
  /** Inside a group with the `i` modifier: a literal could be any case of itself, so it counts as anything. */
  private fold = 0;

  constructor(private readonly source: string) {}

  parse(): Node {
    const node = this.alternation();
    if (this.pos < this.source.length) {
      throw new RegexBudgetError('unbalanced');
    }
    return node;
  }

  private peek(): string | undefined {
    return this.source[this.pos];
  }

  private alternation(): Node {
    const items = [this.sequence()];
    while (this.peek() === '|') {
      this.pos += 1;
      items.push(this.sequence());
    }
    const [only] = items;
    return items.length === 1 && only !== undefined ? only : { t: 'alt', items };
  }

  private sequence(): Node {
    const items: Node[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === '|' || c === ')') {
        break;
      }
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    return { t: 'seq', items };
  }

  private quantified(atom: Node): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === '*') {
      [min, max] = [0, Infinity];
      this.pos += 1;
    } else if (c === '+') {
      [min, max] = [1, Infinity];
      this.pos += 1;
    } else if (c === '?') {
      [min, max] = [0, 1];
      this.pos += 1;
    } else if (c === '{') {
      const match = /^\{(\d+)(,(\d*))?\}/u.exec(this.source.slice(this.pos));
      if (!match) {
        return atom;
      }
      this.pos += match[0].length;
      min = Number(match[1]);
      max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
      // A count larger than any text the pattern runs on says nothing a smaller one would not, and a huge one must not
      // make the estimate itself loop: it is refused before anything counts with it.
      if (min > MAX_COUNT || (max !== Infinity && max > MAX_COUNT)) {
        throw new RegexBudgetError('count');
      }
    } else {
      return atom;
    }
    if (this.peek() === '?') {
      // Lazy: the same choices in another order.
      this.pos += 1;
    }
    return { t: 'rep', node: atom, min, max };
  }

  private atom(): Node {
    const c = this.peek() ?? '';
    if (c === '(') {
      return this.group();
    }
    if (c === '[') {
      return { t: 'char', set: this.cls() };
    }
    if (c === '.') {
      this.pos += 1;
      return { t: 'char', set: CharSet.all };
    }
    if (c === '^') {
      this.pos += 1;
      return { t: 'assert' };
    }
    if (c === '$') {
      this.pos += 1;
      return { t: 'end' };
    }
    if (c === '\\') {
      const escaped = this.escape(false);
      return escaped === 'assert' ? { t: 'assert' } : { t: 'char', set: escaped };
    }
    const codePoint = this.source.codePointAt(this.pos) ?? 0;
    this.pos += codePoint > 0xffff ? 2 : 1;
    return { t: 'char', set: this.literal(codePoint) };
  }

  private literal(codePoint: number): CharSet {
    return this.fold > 0 ? CharSet.unknown : CharSet.of(codePoint);
  }

  private group(): Node {
    this.pos += 1; // (
    let look = false;
    let folds = false;
    if (this.peek() === '?') {
      const rest = this.source.slice(this.pos + 1);
      if (rest.startsWith(':')) {
        this.pos += 2;
      } else if (rest.startsWith('=') || rest.startsWith('!')) {
        this.pos += 2;
        look = true;
      } else if (rest.startsWith('<=') || rest.startsWith('<!')) {
        this.pos += 3;
        look = true;
      } else if (rest.startsWith('<')) {
        const close = this.source.indexOf('>', this.pos);
        this.pos = close + 1;
      } else {
        // Modifiers: `(?i:...)`, `(?-i:...)`, `(?ims-s:...)`.
        const match = /^([ims]*)(?:-([ims]*))?:/u.exec(rest);
        if (!match) {
          throw new RegexBudgetError('group');
        }
        folds = (match[1] ?? '').includes('i');
        this.pos += 1 + match[0].length;
      }
    }
    if (folds) {
      this.fold += 1;
    }
    const inner = this.alternation();
    if (folds) {
      this.fold -= 1;
    }
    if (this.peek() !== ')') {
      throw new RegexBudgetError('unbalanced');
    }
    this.pos += 1;
    return look ? { t: 'look', node: inner } : inner;
  }

  /** An escape at `pos` (on the backslash). Inside a class `\b` is a backspace and there are no assertions. */
  private escape(inClass: boolean): CharSet | 'assert' {
    this.pos += 1;
    const c = this.peek() ?? '';
    this.pos += 1;
    switch (c) {
      case 'd':
        return DIGIT;
      case 'D':
        return DIGIT.complement();
      case 'w':
        return this.fold > 0 ? CharSet.unknown : WORD;
      case 'W':
        return this.fold > 0 ? CharSet.unknown : WORD.complement();
      case 's':
        return SPACE;
      case 'S':
        return SPACE.complement();
      case 'b':
        return inClass ? CharSet.of(0x08) : 'assert';
      case 'B':
        return 'assert';
      case 'p':
      case 'P': {
        const close = this.source.indexOf('}', this.pos);
        this.pos = close + 1;
        return CharSet.unknown;
      }
      case 'u': {
        const braced = /^\{([0-9A-Fa-f]+)\}/u.exec(this.source.slice(this.pos));
        if (braced) {
          this.pos += braced[0].length;
          return this.literal(parseInt(braced[1] ?? '0', 16));
        }
        const four = this.source.slice(this.pos, this.pos + 4);
        this.pos += 4;
        const unit = parseInt(four, 16);
        // With the `u` flag a lead surrogate and a trail surrogate written as two escapes (`😀`) are ONE
        // character to the engine, so a quantifier after them repeats both: they must be one atom here too.
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const trail = this.trailSurrogate();
          if (trail !== undefined) {
            return this.literal(0x10000 + ((unit - 0xd800) << 10) + (trail - 0xdc00));
          }
        }
        return this.literal(unit);
      }
      case 'x': {
        const two = this.source.slice(this.pos, this.pos + 2);
        this.pos += 2;
        return this.literal(parseInt(two, 16));
      }
      case 'c':
        this.pos += 1;
        return CharSet.unknown;
      case 'n':
        return CharSet.of(0x0a);
      case 'r':
        return CharSet.of(0x0d);
      case 't':
        return CharSet.of(0x09);
      case 'f':
        return CharSet.of(0x0c);
      case 'v':
        return CharSet.of(0x0b);
      case '0':
        return CharSet.of(0);
      default: {
        if (/^[1-9k]$/u.test(c)) {
          // A back reference matches what a group matched: anything.
          if (c === 'k') {
            this.pos = this.source.indexOf('>', this.pos) + 1;
          } else {
            while (/[0-9]/u.test(this.peek() ?? '')) {
              this.pos += 1;
            }
          }
          return CharSet.unknown;
        }
        this.pos -= 1;
        const codePoint = this.source.codePointAt(this.pos) ?? 0;
        this.pos += codePoint > 0xffff ? 2 : 1;
        return this.literal(codePoint);
      }
    }
  }

  /** A trail surrogate right at `pos`, as `\uDC00`-`\uDFFF` or as the code unit itself, consumed; else undefined. */
  private trailSurrogate(): number | undefined {
    const escaped = /^\\u([Dd][C-Fc-f][0-9A-Fa-f]{2})/u.exec(
      this.source.slice(this.pos, this.pos + 6),
    );
    if (escaped) {
      this.pos += 6;
      return parseInt(escaped[1] ?? 'DC00', 16);
    }
    const unit = this.source.charCodeAt(this.pos);
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      this.pos += 1;
      return unit;
    }
    return undefined;
  }

  private classMember(): CharSet {
    if (this.peek() === '\\') {
      const escaped = this.escape(true);
      return escaped === 'assert' ? CharSet.unknown : escaped;
    }
    const codePoint = this.source.codePointAt(this.pos) ?? 0;
    this.pos += codePoint > 0xffff ? 2 : 1;
    return this.literal(codePoint);
  }

  private cls(): CharSet {
    this.pos += 1; // [
    let negate = false;
    if (this.peek() === '^') {
      negate = true;
      this.pos += 1;
    }
    let set = CharSet.none;
    while (this.peek() !== ']') {
      if (this.peek() === undefined) {
        throw new RegexBudgetError('class');
      }
      const first = this.classMember();
      if (this.peek() === '-' && this.source[this.pos + 1] !== ']') {
        this.pos += 1;
        const last = this.classMember();
        const [lo] = first.ranges[0] ?? [0, 0];
        const [, hi] = last.ranges[last.ranges.length - 1] ?? [0x10ffff, 0x10ffff];
        // A range between two single characters; anything else (a class escape at an end) the engine refused already.
        set = set.union(
          first.exact &&
            last.exact &&
            first.ranges.length === 1 &&
            last.ranges.length === 1 &&
            lo <= hi
            ? new CharSet([[lo, hi]])
            : CharSet.unknown,
        );
      } else {
        set = set.union(first);
      }
    }
    this.pos += 1; // ]
    const result = negate ? (this.fold > 0 ? CharSet.unknown : set.complement()) : set;
    // A class that matches nothing (`[]`, `[^\d\D]`) is a pattern that cannot be meant; it is refused, not reasoned about.
    if (result.ranges.length === 0) {
      throw new RegexBudgetError('empty');
    }
    return result;
  }
}

interface Facts {
  /** Ways this part can try to match, as an upper bound. */
  readonly ways: number;
  /** The characters a match of this part can begin with. */
  readonly first: CharSet;
  /** It can match nothing. */
  readonly nullable: boolean;
}

/** What a part can begin with, and whether it can be empty, independent of what follows it. */
function firstOf(node: Node): { first: CharSet; nullable: boolean } {
  switch (node.t) {
    case 'char':
      return { first: node.set, nullable: false };
    case 'assert':
    case 'look':
      return { first: CharSet.none, nullable: true };
    case 'end':
      return { first: CharSet.endOfLine, nullable: false };
    case 'seq': {
      let first = CharSet.none;
      for (const item of node.items) {
        const facts = firstOf(item);
        first = first.union(facts.first);
        if (!facts.nullable) {
          return { first, nullable: false };
        }
      }
      return { first, nullable: true };
    }
    case 'alt': {
      let first = CharSet.none;
      let nullable = false;
      for (const item of node.items) {
        const facts = firstOf(item);
        first = first.union(facts.first);
        nullable ||= facts.nullable;
      }
      return { first, nullable };
    }
    case 'rep': {
      const facts = firstOf(node.node);
      return { first: facts.first, nullable: node.min === 0 || facts.nullable };
    }
  }
}

/** The facts of a part, given the characters that can come right after it. */
function analyse(node: Node, follow: CharSet, length: number): Facts {
  switch (node.t) {
    case 'char':
      return { ways: 1, first: node.set, nullable: false };
    case 'assert':
      return { ways: 1, first: CharSet.none, nullable: true };
    case 'end':
      return { ways: 1, first: CharSet.endOfLine, nullable: false };
    case 'look': {
      // A lookaround is a match of its own at this place; it succeeds as soon as its content does.
      const inner = analyse(node.node, CharSet.none, length);
      return { ways: inner.ways, first: CharSet.none, nullable: true };
    }
    case 'seq': {
      let next = follow;
      let ways = 1;
      for (const item of [...node.items].reverse()) {
        const facts = analyse(item, next, length);
        ways = mul(ways, facts.ways);
        next = facts.nullable ? facts.first.union(next) : facts.first;
      }
      return { ways, ...firstOf(node) };
    }
    case 'alt': {
      const branches = node.items.map((item) => analyse(item, follow, length));
      const apart =
        branches.every((branch) => !branch.nullable) &&
        branches.every((branch, index) =>
          branches.slice(index + 1).every((other) => !branch.first.overlaps(other.first)),
        );
      const ways = apart
        ? Math.max(...branches.map((branch) => branch.ways))
        : branches.reduce((sum, branch) => add(sum, branch.ways), 0);
      return { ways, ...firstOf(node) };
    }
    case 'rep': {
      const own = firstOf(node.node);
      const inner = analyse(node.node, node.max > 1 ? own.first.union(follow) : follow, length);
      if (node.max === node.min) {
        return {
          ways: pow(inner.ways, node.min),
          first: own.first,
          nullable: node.min === 0 || own.nullable,
        };
      }
      if (inner.ways > 1 || own.nullable) {
        throw new RegexBudgetError('nested');
      }
      // Whether to take one more turn is decided by the next character when it cannot also begin what follows.
      const decided = !own.first.overlaps(follow);
      const turns = node.max === Infinity ? length : node.max - node.min + 1;
      return {
        ways: decided ? 1 : Math.min(turns, length),
        first: own.first,
        nullable: node.min === 0,
      };
    }
  }
}

/**
 * Why a pattern could make the engine work too long on a text of up to `REGEX_INPUT_LIMIT` characters, in one
 * sentence; undefined when its estimate is within the budget. The pattern must already compile with the `u` flag; a
 * caller that anchors it (`^(?:p)$`) passes the anchored source.
 */
export function regexBudgetIssue(source: string): string | undefined {
  let ways: number;
  try {
    const tree = new Reader(source).parse();
    // After a search, anything may follow: the match is over. A whole-text pattern ends at its own `$`.
    ways = analyse(tree, CharSet.none, REGEX_INPUT_LIMIT).ways;
  } catch (error) {
    if (error instanceof RegexBudgetError) {
      if (error.message === 'empty') {
        return 'A character class of the pattern matches no character.';
      }
      if (error.message === 'count') {
        return `A count in braces is larger than ${String(MAX_COUNT)}, the longest text a pattern is run on.`;
      }
      return error.message === 'nested'
        ? 'The pattern repeats a part that has choices of its own (like (a|b)*, (a+)+ or (a?)*); write it so that every repetition is decided by the next character.'
        : 'The pattern could not be read.';
    }
    throw error;
  }
  // Every way can fail only after it has gone over the text: the work is the ways times its length.
  const total = mul(ways, REGEX_INPUT_LIMIT);
  if (total > BUDGET) {
    return 'The pattern could take too long to match: it has several open-ended repetitions (like .* or \\s+) that can take the same characters as what comes after them; anchor it or make the parts distinct.';
  }
  return undefined;
}
