import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

import { isLocalAddress } from './url.js';

// The one place that opens a connection to a panel (ADR 0040). It speaks GET and nothing else, checks every address
// the name resolves to before connecting to one of them (so a name cannot be pointed at an internal service after the
// check), verifies TLS unless told otherwise, never follows a redirect on its own, and stops reading a response that
// is larger than allowed. `node:https` is used instead of `fetch` because fetch cannot take a CA, a connect-time
// address check or a connect timeout of its own without a second HTTP library.

export type TransportFailure =
  | 'connect_timeout'
  | 'timeout'
  | 'dns'
  | 'refused'
  | 'reset'
  | 'tls'
  | 'address'
  | 'too_large'
  | 'encoding'
  | 'other';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportFailure,
    message: string,
    /** The errno or TLS code, for tests and logs (never a secret). */
    readonly errno?: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface TransportRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly connectTimeoutMs: number;
  /** For the whole exchange, from the first byte sent to the last byte received. */
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface TransportResponse {
  readonly status: number;
  /** Lower-case names; repeated headers are joined with a comma. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface Transport {
  get(request: TransportRequest): Promise<TransportResponse>;
  /** Closes idle connections. The transport must not be used afterwards. */
  close(): void;
}

export type AddressGuard = (address: string) => string | null;

export interface NodeTransportOptions {
  /** PEM text of an extra certificate authority, trusted in addition to the system roots. */
  readonly trustedCa?: string | undefined;
  /** Turns the verification of the server certificate off. Never a default; only explicit configuration sets it. */
  readonly allowInsecureTls?: boolean | undefined;
  /**
   * Judges an address the host name resolved to (or an address literal in the URL). Returns why it is refused, or null.
   * Applied to every answer before a connection to any of them is made.
   */
  readonly addressGuard?: AddressGuard | undefined;
  /** At most this many sockets per host at the same time. */
  readonly maxSockets?: number | undefined;
}

const ERRNO_KIND: Readonly<Record<string, TransportFailure>> = {
  ECONNREFUSED: 'refused',
  ECONNRESET: 'reset',
  EPIPE: 'reset',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EAI_FAIL: 'dns',
  ETIMEDOUT: 'connect_timeout',
  EHOSTUNREACH: 'refused',
  ENETUNREACH: 'refused',
};

const TLS_PREFIXES = [
  'CERT_',
  'DEPTH_ZERO',
  'SELF_SIGNED',
  'UNABLE_TO_',
  'ERR_TLS_',
  'ERR_SSL_',
  'HOSTNAME_MISMATCH',
  'EPROTO',
];

function classify(error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const errno = typeof code === 'string' ? code : undefined;
  if (errno === 'ESW_ADDRESS') {
    return new TransportError('address', (error as Error).message, errno);
  }
  if (errno !== undefined) {
    const kind = ERRNO_KIND[errno];
    if (kind) {
      return new TransportError(kind, `The connection failed (${errno}).`, errno);
    }
    if (TLS_PREFIXES.some((prefix) => errno.startsWith(prefix))) {
      return new TransportError('tls', `The TLS handshake failed (${errno}).`, errno);
    }
    return new TransportError('other', `The connection failed (${errno}).`, errno);
  }
  return new TransportError('other', 'The connection failed.');
}

function refusal(address: string, reason: string): Error {
  return Object.assign(new Error(`The address ${address} is not allowed: ${reason}`), {
    code: 'ESW_ADDRESS',
  });
}

function decode(body: Uint8Array, encoding: string, maxBytes: number): Uint8Array {
  const options = { maxOutputLength: maxBytes };
  try {
    switch (encoding) {
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(body, options);
      case 'deflate':
        return zlib.inflateSync(body, options);
      case 'br':
        return zlib.brotliDecompressSync(body, options);
      default:
        throw new TransportError(
          'encoding',
          'The panel used a content encoding that is not supported.',
        );
    }
  } catch (error) {
    if (error instanceof TransportError) {
      throw error;
    }
    const code = (error as { code?: unknown }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new TransportError('too_large', 'The decoded response is larger than the limit.');
    }
    throw new TransportError('encoding', 'The compressed response could not be decoded.');
  }
}

type LookupReply = (
  error: NodeJS.ErrnoException | null,
  addressOrList?: string | LookupAddress[],
  family?: number,
) => void;

/** Resolves a name, checks every answer, and hands only checked answers to the socket. */
function lookupWith(guard: AddressGuard | undefined): http.AgentOptions['lookup'] {
  return (hostname, lookupOptions, callback) => {
    const given =
      typeof lookupOptions === 'number'
        ? { family: lookupOptions }
        : ((lookupOptions as { family?: number; all?: boolean } | undefined) ?? {});
    const reply = callback as unknown as LookupReply;
    dnsLookup(
      hostname,
      { family: given.family ?? 0, all: true, order: 'verbatim' },
      (error, answers) => {
        if (error) {
          reply(error);
          return;
        }
        if (answers.length === 0) {
          reply(
            Object.assign(new Error('The host name resolves to no address.'), {
              code: 'ENOTFOUND',
            }),
          );
          return;
        }
        for (const answer of answers) {
          const reason = guard?.(answer.address);
          if (reason) {
            reply(refusal(answer.address, reason));
            return;
          }
        }
        if (given.all === true) {
          reply(null, answers);
        } else {
          const first = answers[0];
          reply(null, first?.address ?? '', first?.family ?? 4);
        }
      },
    );
  };
}

export function createNodeTransport(options: NodeTransportOptions = {}): Transport {
  const { addressGuard } = options;
  const ca = options.trustedCa ? [...tls.rootCertificates, options.trustedCa] : undefined;

  /** For http, the address must also be a local one: the check that made the URL acceptable looked at the name only. */
  const httpGuard: AddressGuard = (address) => {
    const reason = addressGuard?.(address);
    if (reason) {
      return reason;
    }
    return isLocalAddress(address)
      ? null
      : 'plain http is only allowed for loopback and private addresses';
  };
  const shared = { keepAlive: true, maxSockets: options.maxSockets ?? 8 };
  const httpsAgent = new https.Agent({
    ...shared,
    lookup: lookupWith(addressGuard),
    rejectUnauthorized: options.allowInsecureTls !== true,
    minVersion: 'TLSv1.2',
    ...(ca ? { ca } : {}),
  });
  const httpAgent = new http.Agent({ ...shared, lookup: lookupWith(httpGuard) });

  return {
    get(request) {
      return new Promise<TransportResponse>((resolve, reject) => {
        const { url } = request;
        const secure = url.protocol === 'https:';
        const hostname = url.hostname.replace(/^\[|\]$/gu, '');
        if (isIP(hostname) !== 0) {
          // A literal address is not resolved, so the lookup of the agent never sees it.
          const reason = (secure ? addressGuard : httpGuard)?.(hostname);
          if (reason) {
            reject(
              new TransportError('address', `The address ${hostname} is not allowed: ${reason}`),
            );
            return;
          }
        }
        let done = false;
        const timers: { total?: NodeJS.Timeout; connect?: NodeJS.Timeout } = {};
        const settle = (action: () => void): void => {
          if (!done) {
            done = true;
            clearTimeout(timers.total);
            clearTimeout(timers.connect);
            action();
          }
        };
        const req = (secure ? https : http).request(
          {
            protocol: url.protocol,
            hostname,
            port: url.port === '' ? undefined : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers: { ...request.headers },
            agent: secure ? httpsAgent : httpAgent,
          },
          (res) => {
            const fail = (error: TransportError): void => {
              settle(() => {
                reject(error);
              });
              res.destroy();
              req.destroy();
            };
            const length = Number(res.headers['content-length']);
            if (Number.isFinite(length) && length > request.maxBytes) {
              fail(new TransportError('too_large', 'The response is larger than the limit.'));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > request.maxBytes) {
                fail(new TransportError('too_large', 'The response is larger than the limit.'));
                return;
              }
              chunks.push(chunk);
            });
            res.on('error', (error) => {
              settle(() => {
                reject(classify(error));
              });
            });
            res.on('aborted', () => {
              settle(() => {
                reject(
                  new TransportError(
                    'reset',
                    'The connection was closed before the response ended.',
                  ),
                );
              });
            });
            res.on('end', () => {
              settle(() => {
                try {
                  let body: Uint8Array = Buffer.concat(chunks);
                  const encoding = (res.headers['content-encoding'] ?? '').toLowerCase().trim();
                  if (encoding !== '' && encoding !== 'identity') {
                    body = decode(body, encoding, request.maxBytes);
                  }
                  const headers: Record<string, string> = {};
                  for (const [name, value] of Object.entries(res.headers)) {
                    if (value !== undefined) {
                      headers[name] = Array.isArray(value) ? value.join(', ') : value;
                    }
                  }
                  resolve({ status: res.statusCode ?? 0, headers, body });
                } catch (error) {
                  reject(classify(error));
                }
              });
            });
          },
        );
        const timeOut = (kind: 'timeout' | 'connect_timeout', message: string): void => {
          settle(() => {
            reject(new TransportError(kind, message));
          });
          req.destroy();
        };
        timers.total = setTimeout(() => {
          timeOut('timeout', 'The panel did not answer in time.');
        }, request.timeoutMs);
        req.on('socket', (socket) => {
          if (socket.connecting) {
            timers.connect = setTimeout(() => {
              timeOut('connect_timeout', 'The connection was not made in time.');
            }, request.connectTimeoutMs);
            socket.once(secure ? 'secureConnect' : 'connect', () => {
              clearTimeout(timers.connect);
            });
          }
        });
        req.on('error', (error) => {
          settle(() => {
            reject(classify(error));
          });
        });
        req.end();
      });
    },
    close() {
      httpsAgent.destroy();
      httpAgent.destroy();
    },
  };
}
