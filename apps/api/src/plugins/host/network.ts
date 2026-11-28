import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIPv4, isIPv6 } from 'node:net';

import { PLUGIN_LIMITS, type PluginFetchInit } from '@swellwright/plugin-api';

/** An answer the plugin gets: text, with the headers in lower case. */
export interface NetworkResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Why the core refused a request, in words the plugin author can act on. It reaches the plugin as an error. */
export class NetworkRefused extends Error {
  constructor(
    message: string,
    readonly reason: 'not_allowed' | 'address' | 'invalid' | 'limit',
  ) {
    super(message);
    this.name = 'NetworkRefused';
  }
}

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'expect',
]);

const REQUEST_TIMEOUT_MS = 15_000;

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** True for an IPv4 address, as four numbers, that a plugin may be sent to. */
function isPublicV4(a: number, b: number, c: number): boolean {
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) || // the old 6to4 relays
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 literal (a trailing dotted IPv4 included), or undefined. */
function groupsOf(address: string): number[] | undefined {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (dotted !== null) {
    if (!isIPv4(dotted[0])) {
      return undefined;
    }
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${(((a ?? 0) << 8) | (b ?? 0)).toString(16)}:${(((c ?? 0) << 8) | (d ?? 0)).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const parse = (part: string): number[] | undefined => {
    if (part === '') {
      return [];
    }
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/u.test(group)) {
        return undefined;
      }
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? undefined : [...head, ...Array<number>(missing).fill(0), ...tail];
}

/**
 * True for an IPv6 address a plugin may be sent to. Only global unicast (2000::/3) qualifies, without the ranges in
 * it that are not an ordinary destination: documentation, the IETF protocol block (Teredo, benchmarking, ORCHID and
 * the like), 6to4. An address that carries an IPv4 one (mapped, compatible, or translated by NAT64) is judged by the
 * IPv4 address it carries. Every other form is refused, so an unusual spelling or a special prefix cannot lead a
 * plugin to the network the core sits in.
 */
function isPublicV6(groups: readonly number[]): boolean {
  const g = (index: number): number => groups[index] ?? 0;
  const v4 = (): boolean => isPublicV4(g(6) >> 8, g(6) & 0xff, g(7) >> 8);
  const zeroUpTo = (end: number): boolean => groups.slice(0, end).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated): the IPv4 address decides.
  if (zeroUpTo(5) && (g(5) === 0xffff || g(5) === 0)) {
    return !(g(5) === 0 && g(6) === 0) && v4();
  }
  // 64:ff9b::/96, the NAT64 prefix every IPv6-only network uses to reach IPv4: the IPv4 address decides.
  if (g(0) === 0x64 && g(1) === 0xff9b && g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0) {
    return v4();
  }
  if ((g(0) & 0xe000) !== 0x2000) {
    // Not global unicast: unique local, link local, site local, multicast, discard, local NAT64, reserved.
    return false;
  }
  return !(
    (g(0) === 0x2001 && g(1) < 0x0200) || // 2001::/23, IETF protocol assignments (Teredo is 2001::/32)
    (g(0) === 0x2001 && g(1) === 0x0db8) || // 2001:db8::/32, documentation
    g(0) === 0x2002 || // 2002::/16, 6to4: an IPv4 address behind a relay
    (g(0) & 0xfff0) === 0x3ff0 // 3ff0::/12, documentation (3fff::/20) and what is left of the old 6bone block
  );
}

/**
 * True for an address a plugin may be sent to: a public one. Everything that is local, private, shared,
 * reserved or for documentation is refused, so a plugin cannot be used to reach the network the core sits in.
 */
export function isPublicAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (isIPv4(lower)) {
    const [a = 0, b = 0, c = 0] = lower.split('.').map(Number);
    return isPublicV4(a, b, c);
  }
  // A zone (`fe80::1%eth0`) is not part of an address a plugin is sent to.
  if (!isIPv6(lower) || lower.includes('%')) {
    return false;
  }
  const groups = groupsOf(lower);
  return groups !== undefined && isPublicV6(groups);
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** What the transport is asked to do, after every rule has been applied. */
export interface TransportRequest {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  /** The address to connect to, already checked. The name is only for the certificate and the Host header. */
  readonly address: ResolvedAddress;
  /** Ends the request when the call it belongs to is over. */
  readonly signal?: AbortSignal;
}

export type Transport = (request: TransportRequest) => Promise<NetworkResponse>;

export interface NetworkOptions {
  readonly resolve?: (host: string) => Promise<readonly ResolvedAddress[]>;
  readonly transport?: Transport;
  /** Tests only: let an address through that the rule would refuse (a server on this machine). */
  readonly allowAddress?: (address: string) => boolean;
  /** Tests only: talk plain HTTP to a server on this machine. */
  readonly plain?: boolean;
}

async function systemResolve(host: string): Promise<readonly ResolvedAddress[]> {
  const found = await lookup(host, { all: true });
  return found.map((f) => ({ address: f.address, family: f.family === 6 ? 6 : 4 }));
}

function realTransport(plain: boolean): Transport {
  return (r) =>
    new Promise<NetworkResponse>((resolve, reject) => {
      if (r.signal?.aborted === true) {
        reject(new Error('The call this request belongs to is over.'));
        return;
      }
      const send = plain ? httpRequest : httpsRequest;
      const request = send(
        {
          host: r.host,
          port: r.port,
          path: r.path,
          method: r.method,
          headers: { ...r.headers, host: r.port === 443 ? r.host : `${r.host}:${String(r.port)}` },
          servername: r.host,
          // The connection goes to the address that was checked, whatever the name resolves to later.
          lookup: (_host, options, callback) => {
            const answer = { address: r.address.address, family: r.address.family };
            if ((options as { all?: boolean }).all === true) {
              (callback as unknown as (e: null, a: unknown[]) => void)(null, [answer]);
            } else {
              callback(null, answer.address, answer.family);
            }
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > PLUGIN_LIMITS.responseBytes) {
              request.destroy(new NetworkRefused('The response is too large.', 'limit'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined) {
                headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
              }
            }
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          response.on('error', reject);
        },
      );
      // A deadline for the whole exchange, not only for a silence: an answer that trickles in is ended too.
      const deadline = setTimeout(() => {
        request.destroy(new Error('The request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      const abort = (): void => {
        request.destroy(new Error('The call this request belongs to is over.'));
      };
      r.signal?.addEventListener('abort', abort, { once: true });
      request.on('close', () => {
        clearTimeout(deadline);
        r.signal?.removeEventListener('abort', abort);
      });
      request.on('timeout', () => request.destroy(new Error('The request timed out.')));
      request.on('error', reject);
      request.end(r.body);
    });
}

/**
 * The core's door for a plugin (ADR 0028): the only way out of its process. A request goes through only if
 * its `host:port` is one the administrator approved, the name resolves to public addresses only, and the
 * request and the answer are of a bounded size. The connection is made to the address that was checked, so
 * a name that changes its answer between the check and the connection gains nothing. Redirects are not followed.
 */
export class PluginNetwork {
  private readonly resolve: (host: string) => Promise<readonly ResolvedAddress[]>;
  private readonly transport: Transport;
  private readonly allowAddress: (address: string) => boolean;
  private readonly plain: boolean;
  private readonly inFlight = new Map<string, number>();

  constructor(options: NetworkOptions = {}) {
    this.resolve = options.resolve ?? systemResolve;
    this.transport = options.transport ?? realTransport(options.plain === true);
    this.allowAddress = options.allowAddress ?? isPublicAddress;
    this.plain = options.plain === true;
  }

  /** `allowed` is the approved `network` list of the plugin: `host:port` entries. */
  async fetch(
    pluginId: string,
    allowed: readonly string[],
    url: string,
    init: PluginFetchInit = {},
    signal?: AbortSignal,
  ): Promise<NetworkResponse> {
    const target = this.check(allowed, url, init);
    if (signal?.aborted === true) {
      throw new Error('The call this request belongs to is over.');
    }
    const active = this.inFlight.get(pluginId) ?? 0;
    if (active >= PLUGIN_LIMITS.concurrentFetches) {
      throw new NetworkRefused('Too many requests at once.', 'limit');
    }
    this.inFlight.set(pluginId, active + 1);
    try {
      const addresses = await this.resolve(target.host);
      const [address] = addresses;
      if (address === undefined) {
        throw new NetworkRefused(`${target.host} does not resolve.`, 'address');
      }
      if (!addresses.every((a) => this.allowAddress(a.address))) {
        throw new NetworkRefused(
          `${target.host} resolves to an address that is not public; the request is refused.`,
          'address',
        );
      }
      // The name was being resolved while the call could have ended: nothing is sent for a call that is over.
      signal?.throwIfAborted();
      return await this.transport({ ...target, address, ...(signal ? { signal } : {}) });
    } finally {
      this.inFlight.set(pluginId, (this.inFlight.get(pluginId) ?? 1) - 1);
    }
  }

  private check(allowed: readonly string[], url: string, init: PluginFetchInit) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new NetworkRefused('That is not a URL.', 'invalid');
    }
    if (parsed.protocol !== 'https:' && !(this.plain && parsed.protocol === 'http:')) {
      throw new NetworkRefused('Only https is allowed.', 'invalid');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new NetworkRefused('A URL with a name and password is refused.', 'invalid');
    }
    const port =
      parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
    const host = parsed.hostname.toLowerCase();
    if (!allowed.includes(`${host}:${String(port)}`)) {
      throw new NetworkRefused(
        `${host}:${String(port)} is not among the hosts this plugin was approved to call.`,
        'not_allowed',
      );
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (!METHODS.has(method)) {
      throw new NetworkRefused(`The method ${method} is not allowed.`, 'invalid');
    }
    if (init.body !== undefined && Buffer.byteLength(init.body) > PLUGIN_LIMITS.requestBytes) {
      throw new NetworkRefused('The request body is too large.', 'limit');
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!HOP_BY_HOP.has(lower) && typeof value === 'string' && /^[\w-]+$/u.test(lower)) {
        headers[lower] = value;
      }
    }
    headers['user-agent'] ??= 'Swellwright-plugin';
    return {
      host,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      body: init.body,
    };
  }
}
