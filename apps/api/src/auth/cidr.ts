import { BlockList, isIP } from 'node:net';

/** An address in one family, written canonically. An IPv4 address mapped into IPv6 is IPv4. */
export interface ParsedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** `::ffff:203.0.113.9` and `::ffff:cb00:7109` (and their expanded forms) are the IPv4 address 203.0.113.9. */
function mappedIpv4(ipv6: string): string | null {
  // The words of the address decide, whatever the spelling. `::ffff:0:0/96` is the mapped range.
  const words = expandIpv6(ipv6);
  if (words === null || words.slice(0, 5).some((word) => word !== 0) || words[5] !== 0xffff) {
    return null;
  }
  const high = words[6] ?? 0;
  const low = words[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** The eight 16-bit words of a valid IPv6 address (dotted IPv4 tail allowed), or null. */
function expandIpv6(ipv6: string): number[] | null {
  let text = ipv6;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text);
  if (dotted) {
    const octets = (dotted[2] ?? '').split('.').map(Number);
    if (octets.some((octet) => octet > 255)) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    tail.push((a << 8) | b, (c << 8) | d);
    // `::ffff:` loses its trailing colon; `::` stays as it is.
    const before = dotted[1] ?? '';
    text = before.endsWith('::') ? before : before.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parse = (part: string | undefined): number[] | null => {
    if (part === undefined || part === '') {
      return [];
    }
    const out: number[] = [];
    for (const word of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/iu.test(word)) {
        return null;
      }
      out.push(Number.parseInt(word, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || rest === null) {
    return null;
  }
  const known = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) {
      return null;
    }
    return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
  }
  return known === 8 ? [...head, ...tail] : null;
}

/**
 * Validates an address and puts it in one family: a zone (`%eth0`) is dropped, an IPv4-mapped IPv6 address in any
 * spelling becomes the IPv4 address. Null when it is not an address.
 */
export function parseAddress(raw: string | undefined): ParsedAddress | null {
  if (!raw) {
    return null;
  }
  const bare = (raw.split('%')[0] ?? raw).toLowerCase();
  const family = isIP(bare);
  if (family === 4) {
    return { address: bare, family: 4 };
  }
  if (family !== 6) {
    return null;
  }
  const mapped = mappedIpv4(bare);
  return mapped === null ? { address: bare, family: 6 } : { address: mapped, family: 4 };
}

/**
 * The source an address counts as for the limits of sign-in attempts (ADR 0049): an IPv4 address on its own (in any
 * spelling, also mapped into IPv6), an IPv6 address by its /64, which one host usually holds whole and can rotate
 * through freely. A missing or unreadable address is the single source `unknown`. This key does not replace the
 * address recorded for a session or its authentication audit.
 */
export function addressBucket(raw: string | undefined): string {
  return sourcePrefix(raw);
}

/** Group IPv6 sources without recording their interface identifier. IPv4 uses one address. */
export function auditAddressPrefix(raw: string | undefined): string {
  return sourcePrefix(raw);
}

function sourcePrefix(raw: string | undefined): string {
  const parsed = parseAddress(raw);
  if (parsed === null) {
    return 'unknown';
  }
  if (parsed.family === 4) {
    return parsed.address;
  }
  const words = expandIpv6(parsed.address);
  return words === null
    ? 'unknown'
    : `${words
        .slice(0, 4)
        .map((word) => word.toString(16))
        .join(':')}::/64`;
}

/** A range of one family. A mapped IPv6 range of /96 or narrower is the IPv4 range it covers. */
interface ParsedRange {
  readonly base: string;
  readonly prefix: number;
  readonly family: 4 | 6;
}

function parseRange(range: string): ParsedRange | null {
  const parts = range.split('/');
  if (parts.length > 2) {
    return null;
  }
  const [rawBase = '', rawPrefix] = parts;
  if (rawBase.includes('%')) {
    return null;
  }
  const base = parseAddress(rawBase);
  if (!base) {
    return null;
  }
  const nativeFamily = isIP(rawBase.toLowerCase());
  const maxPrefix = nativeFamily === 4 ? 32 : 128;
  let prefix = maxPrefix;
  if (rawPrefix !== undefined) {
    if (!/^\d{1,3}$/u.test(rawPrefix)) {
      return null;
    }
    prefix = Number(rawPrefix);
    if (prefix > maxPrefix) {
      return null;
    }
  }
  if (nativeFamily === 6 && base.family === 4) {
    // `::ffff:203.0.113.0/120` is 203.0.113.0/24. A broader prefix reaches past the mapped range: an IPv6 range.
    if (prefix >= 96) {
      return { base: base.address, prefix: prefix - 96, family: 4 };
    }
    return { base: rawBase.toLowerCase(), prefix, family: 6 };
  }
  return { base: base.address, prefix, family: base.family };
}

/**
 * Whether an address is inside any of the ranges (`203.0.113.0/24`, `2001:db8::/32` or a single address). No ranges
 * means no restriction. An address is only ever compared with ranges of its own family, so `::/0` admits every IPv6
 * address and no IPv4 one (an IPv4 address an IPv6 socket reports as `::ffff:...` counts as IPv4); allowing both
 * takes both `0.0.0.0/0` and `::/0`. An unknown address, or one that is not an address, is outside every range; a
 * range that cannot be read matches nothing.
 */
export function ipInRanges(address: string | undefined, ranges: readonly string[]): boolean {
  if (ranges.length === 0) {
    return true;
  }
  const ip = parseAddress(address);
  if (!ip) {
    return false;
  }
  const type = ip.family === 4 ? 'ipv4' : 'ipv6';
  const list = new BlockList();
  let rules = 0;
  for (const range of ranges) {
    const parsed = parseRange(range);
    if (parsed?.family !== ip.family) {
      continue;
    }
    list.addSubnet(parsed.base, parsed.prefix, type);
    rules += 1;
  }
  return rules > 0 && list.check(ip.address, type);
}
