import { Resolver } from 'node:dns/promises';

import { type DnsQuery, queryErrorFromCode } from '@swellwright/conventions';

/**
 * The question the reconciliation asks of DNS, answered by Node's resolver (ADR 0044): the servers of this machine, or
 * the ones named in `SW_CHECKS_DNS_SERVERS`. One try per question and a timeout of its own, so that a name that does
 * not answer costs the time of one timeout and not several; the package puts a deadline on top of it as well.
 */
export function nodeDnsQuery(servers: readonly string[], timeoutMs: number): DnsQuery {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (servers.length > 0) {
    resolver.setServers([...servers]);
  }
  return async (name, type) => {
    try {
      switch (type) {
        case 'A': {
          const answers = await resolver.resolve4(name, { ttl: true });
          return {
            records: answers.map((answer) => answer.address),
            ttl: smallest(answers.map((answer) => answer.ttl)),
          };
        }
        case 'AAAA': {
          const answers = await resolver.resolve6(name, { ttl: true });
          return {
            records: answers.map((answer) => answer.address),
            ttl: smallest(answers.map((answer) => answer.ttl)),
          };
        }
        case 'CNAME':
          return { records: await resolver.resolveCname(name), ttl: null };
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      throw queryErrorFromCode(
        typeof code === 'string' ? code : undefined,
        error instanceof Error ? error.message : 'DNS error',
      );
    }
  };
}

const smallest = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.min(...values);
