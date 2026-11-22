import { createHash } from 'node:crypto';

import type { PanelInboundView } from '@swellwright/contracts';

import type { ProfileInput } from './model.js';

// What the rules and the impact calculator read out of an Xray configuration. The configuration arrives masked (ADR
// 0041) and is free-form JSON, so every access here is defensive: a shape that is not what was expected gives "nothing
// found", never an exception.

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The inbounds a configuration lists, as objects (anything else in the list is left out). */
export function configInbounds(config: unknown): Obj[] {
  return isObj(config) && Array.isArray(config['inbounds']) ? config['inbounds'].filter(isObj) : [];
}

/** The raw inbound of a profile's inbound: the detail's own copy, or the entry of the configuration with its tag. */
export function rawInboundOf(profile: ProfileInput, inbound: PanelInboundView): Obj | null {
  if (isObj(inbound.raw)) {
    return inbound.raw;
  }
  return (
    configInbounds(profile.config).find((candidate) => candidate['tag'] === inbound.tag) ?? null
  );
}

/** The names a REALITY inbound accepts (`serverNames`). Empty for anything else. */
export function realityServerNames(raw: Obj | null): string[] {
  const stream = raw?.['streamSettings'];
  const reality = isObj(stream) ? stream['realitySettings'] : undefined;
  const names = isObj(reality) ? reality['serverNames'] : undefined;
  return Array.isArray(names)
    ? names.filter((n): n is string => typeof n === 'string' && n !== '')
    : [];
}

/** Whether `name` is one of `names`: equal, or covered by a wildcard such as `*.example.com`. */
export function serverNameListed(name: string, names: readonly string[]): boolean {
  const wanted = name.trim().toLowerCase();
  return names.some((candidate) => {
    const have = candidate.trim().toLowerCase();
    if (have === wanted) {
      return true;
    }
    return (
      have.startsWith('*.') && wanted.endsWith(have.slice(1)) && wanted.length > have.length - 1
    );
  });
}

/** The address an inbound listens on; every address when it says nothing. */
export function listenOf(raw: Obj | null): string {
  return text(raw?.['listen']) ?? '0.0.0.0';
}

const UDP_NETWORKS = new Set(['kcp', 'mkcp', 'quic', 'hysteria', 'hysteria2', 'udp']);

/** The transport the port belongs to: a UDP network keeps a port of its own, apart from a TCP one. */
export function transportOf(inbound: Pick<PanelInboundView, 'network'>): 'tcp' | 'udp' {
  return inbound.network !== null && UDP_NETWORKS.has(inbound.network.toLowerCase())
    ? 'udp'
    : 'tcp';
}

export const isWildcardListen = (listen: string): boolean =>
  listen === '0.0.0.0' || listen === '::' || listen === '' || listen === '[::]';

/**
 * The snippets a configuration names (ADR 0041, the panel's editor): `"snippets": ["name", ...]` at the root, and
 * `"snippet": "name"` in an outbound, a routing rule or a balancer.
 */
export function snippetNames(config: unknown): string[] {
  if (!isObj(config)) {
    return [];
  }
  const names = new Set<string>();
  const root = config['snippets'];
  if (Array.isArray(root)) {
    for (const name of root) {
      if (typeof name === 'string') {
        names.add(name);
      }
    }
  }
  const lists: unknown[] = [config['outbounds']];
  const routing = config['routing'];
  if (isObj(routing)) {
    lists.push(routing['rules'], routing['balancers']);
  }
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      const name = isObj(item) ? text(item['snippet']) : null;
      if (name !== null) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/** An Xray `port` as a number, when it is one (a range or a list is not). */
export function portOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_535) {
    return value;
  }
  if (typeof value === 'string' && /^\d{1,5}$/u.test(value)) {
    const n = Number(value);
    return n <= 65_535 ? n : null;
  }
  return null;
}

/** A stable identifier that looks like a UUID, made from a string: for an inbound the panel has not numbered yet. */
export function syntheticUuid(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The inbounds a configuration would give a profile, as the panel's list shows them. An inbound whose tag the profile
 * has already keeps its identity; a new one gets a made-up identity that is the same on every run, so that two
 * calculations of one proposal agree. The second value says which are new.
 */
export function inboundsFromConfig(
  profile: Pick<ProfileInput, 'uuid' | 'inbounds'>,
  config: unknown,
): { inbounds: PanelInboundView[]; created: Set<string> } {
  const known = new Map(profile.inbounds.map((inbound) => [inbound.tag, inbound]));
  const created = new Set<string>();
  const seen = new Map<string, number>();
  const inbounds: PanelInboundView[] = [];
  for (const raw of configInbounds(config)) {
    const tag = text(raw['tag']);
    if (tag === null) {
      continue;
    }
    const stream = isObj(raw['streamSettings']) ? raw['streamSettings'] : {};
    const times = seen.get(tag) ?? 0;
    seen.set(tag, times + 1);
    // A tag that is listed twice (a mistake the linter reports) must not collapse into one inbound.
    const existing = times === 0 ? known.get(tag) : undefined;
    const uuid = existing?.uuid ?? syntheticUuid(`${profile.uuid}:${tag}:${String(times)}`);
    if (existing === undefined) {
      created.add(uuid);
    }
    inbounds.push({
      uuid,
      profileUuid: profile.uuid,
      tag,
      type: text(raw['protocol']) ?? existing?.type ?? 'unknown',
      network: text(stream['network']),
      security: text(stream['security']),
      port: portOf(raw['port']),
      raw,
    });
  }
  return { inbounds, created };
}
