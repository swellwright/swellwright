import { BlockList, isIP } from 'node:net';

import { PanelUrlError } from './errors.js';

const LOCAL = new BlockList();
for (const [network, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
] as const) {
  LOCAL.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::1', 128],
  ['fc00::', 7],
] as const) {
  LOCAL.addSubnet(network, prefix, 'ipv6');
}

/**
 * True for an address that is on this machine or on a private network: loopback, RFC 1918, shared address space
 * (100.64.0.0/10) and the IPv6 loopback and unique-local ranges. An IPv4-mapped IPv6 address counts as the IPv4 one.
 * A host name is not an address and is never "private" here: a name is judged by what it resolves to, at connect time.
 */
export function isLocalAddress(address: string): boolean {
  let text = address.trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    text = text.slice(1, -1);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(text);
  if (mapped?.[1]) {
    text = mapped[1];
  }
  const family = isIP(text);
  if (family === 0) {
    return false;
  }
  return LOCAL.check(text, family === 4 ? 'ipv4' : 'ipv6');
}

/** `localhost` and the names under `.localhost` always mean this machine (RFC 6761). */
export function isLoopbackName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/u, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

export interface ParsedPanelUrl {
  /** `https://host[:port][/prefix]`, no trailing slash, no credentials, query or fragment. */
  readonly base: string;
  readonly protocol: 'https:' | 'http:';
  /** Without the brackets of an IPv6 literal. */
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  /** Always `/` or `/prefix` without a trailing slash; empty for the root. */
  readonly pathPrefix: string;
}

export interface PanelUrlOptions {
  /**
   * Plain `http:` is refused unless this is true AND the host is a loopback or private address (or `localhost`).
   * A host name that is not `localhost` is refused for http here; the connection layer checks what it resolves to.
   */
  readonly allowInsecureHttp?: boolean;
}

/** Parses and normalises the address of a panel, or throws `PanelUrlError` saying what is wrong. */
export function parsePanelUrl(input: string, options: PanelUrlOptions = {}): ParsedPanelUrl {
  const text = input.trim();
  if (text.length === 0 || text.length > 2048) {
    throw new PanelUrlError('The address of the panel is empty or too long.');
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PanelUrlError('The address of the panel is not a URL (expected https://host).');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PanelUrlError('The address of the panel must start with https://.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new PanelUrlError(
      'The address of the panel must not contain credentials. The token is given separately.',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw new PanelUrlError('The address of the panel must not contain a query or a fragment.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (hostname === '') {
    throw new PanelUrlError('The address of the panel has no host.');
  }
  if (url.protocol === 'http:') {
    if (options.allowInsecureHttp !== true) {
      throw new PanelUrlError(
        'The address of the panel must use https. Plain http is refused: the token would travel in the clear.',
      );
    }
    if (!isLocalAddress(hostname) && !isLoopbackName(hostname)) {
      throw new PanelUrlError(
        'Plain http is only allowed for a loopback or private address, never for a name or a public address.',
      );
    }
  }
  const pathPrefix = url.pathname.replace(/\/+$/u, '');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const origin = url.origin;
  return {
    base: `${origin}${pathPrefix}`,
    protocol: url.protocol,
    hostname,
    port,
    origin,
    pathPrefix,
  };
}
