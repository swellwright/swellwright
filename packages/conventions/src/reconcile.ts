import {
  CONVENTION_PACK_LIMITS,
  type CheckFixHint,
  type CheckObjectRef,
  type CheckParams,
  type PanelHostView,
  type PanelNodeView,
  type ReconciliationCheck,
  type ReconciliationRow,
  type ReconciliationStatus,
  type ReconciliationSummary,
} from '@swellwright/contracts';

import type { DnsAnswer } from './dns.js';
import { canonicalJson } from './json.js';
import { message } from './messages.js';
import {
  addressKind,
  isIpAddress,
  ModelIndex,
  normalizeAddress,
  type PanelModel,
  refs,
  type Subject,
  subjects,
} from './model.js';
import type { ResolvedPack } from './pack.js';

// Reconciliation: what hosts, nodes and the servers of the inventory say about each other. "Check only": the function
// reads the model, the answers of DNS and the inventory, and returns rows; nothing is changed anywhere, and a fix is a
// hint of what a later write would do. A name that did not resolve in time, or an inbound that nothing serves, is a row
// with the status `unknown`, never an exception: the point of the report is to say what could not be decided.

/** A server of the inventory, as far as reconciliation needs to know it. */
export interface InventoryServer {
  readonly id: string;
  readonly name: string;
  /** What SSH connects to: an IP or a name. */
  readonly address: string;
  readonly state: string;
  readonly tags: readonly string[];
  /** The host name the facts reported, when they were collected. */
  readonly hostname: string | null;
}

export interface ReconcileInput {
  readonly model: PanelModel;
  readonly pack: ResolvedPack;
  /** Answers for names, by normalised name. Empty when DNS is off. */
  readonly dns: ReadonlyMap<string, DnsAnswer>;
  /** Names that were not looked up because of the cap. */
  readonly dnsSkipped: ReadonlySet<string>;
  /** The inventory; null when the caller may not read it. */
  readonly inventory: readonly InventoryServer[] | null;
}

export interface ReconcileResult {
  readonly rows: ReconciliationRow[];
  readonly summary: ReconciliationSummary;
  readonly truncated: boolean;
  /**
   * How many nodes of the panel have no server in the inventory (`node.server` rows that are `missing`), counted over
   * every row, not only the ones kept in `rows`. With an empty inventory that is every node: a place to start, not a
   * drift, and the dashboard needs to tell it from a difference that is one.
   */
  readonly unmanaged: number;
}

/** The names a run has to look up, most important first: node addresses, then servers, then host addresses. */
export function namesToResolve(
  model: PanelModel,
  pack: ResolvedPack,
  inventory: readonly InventoryServer[] | null,
): string[] {
  const names = new Set<string>();
  const add = (address: string): void => {
    const name = normalizeAddress(address);
    if (addressKind(name) === 'name') {
      names.add(name);
    }
  };
  if (!pack.reconciliation.dnsEnabled) {
    return [];
  }
  const { disabledChecks, hostAddress } = pack.reconciliation;
  if (
    !disabledChecks.has('node.dns') ||
    !disabledChecks.has('node.server') ||
    !disabledChecks.has('host.address') ||
    !disabledChecks.has('node.duplicate')
  ) {
    for (const node of model.nodes) {
      add(node.address);
    }
  }
  if (inventory !== null && !disabledChecks.has('node.server')) {
    for (const server of inventory) {
      add(server.address);
    }
  }
  if (
    (hostAddress === 'node' || hostAddress === 'node-ip') &&
    !disabledChecks.has('host.address')
  ) {
    for (const host of model.hosts) {
      add(host.address);
    }
  }
  return [...names];
}

// ---- helpers ----------------------------------------------------------------------------------------------------

interface Where {
  readonly addr: string;
  readonly kind: ReturnType<typeof addressKind>;
  /** The IPs the address stands for: itself when it is an IP, else what the name resolved to. */
  readonly ips: Set<string>;
  readonly answer: DnsAnswer | undefined;
  /** True when the IPs are known (an IP, or a name that resolved). */
  readonly known: boolean;
  readonly skipped: boolean;
}

function whereIs(address: string, input: ReconcileInput): Where {
  const addr = normalizeAddress(address);
  const kind = addressKind(addr);
  if (kind === 'ipv4' || kind === 'ipv6') {
    return { addr, kind, ips: new Set([addr]), answer: undefined, known: true, skipped: false };
  }
  const answer = input.dns.get(addr);
  const ips = new Set(answer?.status === 'ok' ? answer.addresses : []);
  return {
    addr,
    kind,
    ips,
    answer,
    known: ips.size > 0,
    skipped: kind === 'name' && answer === undefined && input.dnsSkipped.has(addr),
  };
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  [...a].some((value) => b.has(value));
const list = (values: Iterable<string>, max = 3): string => [...values].slice(0, max).join(', ');

class Rows {
  readonly rows: ReconciliationRow[] = [];
  private readonly ids = new Set<string>();

  constructor(private readonly pack: ResolvedPack) {}

  add(input: {
    check: ReconciliationCheck;
    status: ReconciliationStatus;
    subject: Subject;
    counterpart?: CheckObjectRef | null;
    related?: readonly CheckObjectRef[];
    expected?: string | null;
    actual?: string | null;
    reason: string;
    params?: CheckParams;
    fix?: CheckFixHint | null;
    ttl?: number | null;
    key?: string;
  }): void {
    if (this.pack.reconciliation.disabledChecks.has(input.check)) {
      return;
    }
    const scope = this.pack.reconciliation.scope;
    if (scope !== null && !scope.allows(input.subject)) {
      return;
    }
    const id = [
      input.check,
      input.subject.ref.kind,
      input.subject.ref.uuid ?? input.subject.ref.name,
      input.counterpart?.uuid ?? undefined,
      input.key,
    ]
      .filter((part) => part !== undefined)
      .join(':')
      .slice(0, 400);
    if (this.ids.has(id)) {
      return;
    }
    this.ids.add(id);
    const params = input.params ?? {};
    const reasonKey = `reconciliation.reasons.${input.reason}`;
    this.rows.push({
      id,
      check: input.check,
      status: input.status,
      subject: input.subject.ref,
      counterpart: input.counterpart ?? null,
      related: [...(input.related ?? [])].slice(0, 20),
      expected:
        input.expected === undefined || input.expected === null
          ? null
          : input.expected.slice(0, 1000),
      actual:
        input.actual === undefined || input.actual === null ? null : input.actual.slice(0, 1000),
      reason: message(reasonKey, params).slice(0, 1000),
      reasonKey,
      params,
      fix: input.fix ?? null,
      ttlSeconds: input.ttl ?? null,
    });
  }
}

// ---- the report -------------------------------------------------------------------------------------------------

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { model, pack } = input;
  const index = new ModelIndex(model);
  const rows = new Rows(pack);

  const nodeWhere = new Map<string, Where>(
    model.nodes.map((node) => [node.uuid, whereIs(node.address, input)]),
  );
  const where = (node: PanelNodeView): Where =>
    nodeWhere.get(node.uuid) ?? whereIs(node.address, input);

  // ---- hosts
  for (const host of model.hosts) {
    hostRows(host, index, input, rows, where);
  }
  hostDuplicates(model.hosts, rows);

  // ---- nodes
  for (const node of model.nodes) {
    nodeDnsRows(node, where(node), input, rows);
  }
  nodeDuplicates(model.nodes, where, rows);

  // ---- inventory
  if (input.inventory !== null) {
    inventoryRows(input.inventory, input, rows, where);
  }

  const all = rows.rows;
  const summary = summarise(all);
  const limited = all.slice(0, CONVENTION_PACK_LIMITS.rows);
  const unmanaged = all.filter((row) => row.check === 'node.server' && row.status === 'missing');
  return {
    rows: limited,
    summary,
    truncated: all.length > limited.length,
    unmanaged: unmanaged.length,
  };
}

function summarise(rows: readonly ReconciliationRow[]): ReconciliationSummary {
  const counts = { ok: 0, drift: 0, missing: 0, extra: 0, unknown: 0 };
  const byCheck: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] += 1;
    if (row.status !== 'ok') {
      byCheck[row.check] = (byCheck[row.check] ?? 0) + 1;
    }
  }
  return { ...counts, total: rows.length, byCheck };
}

// ---- hosts ------------------------------------------------------------------------------------------------------

/** The nodes a host stands for: the ones it is assigned to (they say where it points), else the ones that serve it. */
function candidatesOf(host: PanelHostView, index: ModelIndex): PanelNodeView[] {
  const assigned = host.nodeUuids.flatMap((uuid) => {
    const node = index.nodes.get(uuid);
    return node === undefined ? [] : [node];
  });
  return assigned.length > 0 ? assigned : index.servingNodes(host);
}

function hostRows(
  host: PanelHostView,
  index: ModelIndex,
  input: ReconcileInput,
  rows: Rows,
  where: (node: PanelNodeView) => Where,
): void {
  const { pack } = input;
  const settings = pack.reconciliation;
  const subject = subjects.host(host);
  const candidates = candidatesOf(host, index);
  const first = candidates[0];

  // host.node: the nodes a host is assigned to exist and serve its inbound.
  if (host.nodeUuids.length > 0) {
    const serving = new Set(index.servingNodes(host).map((node) => node.uuid));
    let clean = true;
    for (const uuid of host.nodeUuids) {
      const node = index.nodes.get(uuid);
      if (node === undefined) {
        clean = false;
        rows.add({
          check: 'host.node',
          status: 'drift',
          subject,
          key: uuid,
          reason: 'assigned_node_missing',
          actual: uuid,
        });
      } else if (!serving.has(uuid)) {
        clean = false;
        rows.add({
          check: 'host.node',
          status: 'drift',
          subject,
          counterpart: refs.node(node),
          key: uuid,
          reason: 'assigned_node_not_serving',
          params: { node: node.name },
          actual: node.name,
        });
      }
    }
    if (clean) {
      rows.add({ check: 'host.node', status: 'ok', subject, reason: 'assigned_nodes_serve' });
    }
  }

  if (first === undefined) {
    // Nothing serves the inbound and the host names no node: the other checks have nothing to compare with.
    for (const check of ['host.address', 'host.sni', 'host.port'] as const) {
      const wanted =
        check === 'host.address'
          ? settings.hostAddress !== 'none'
          : check === 'host.sni'
            ? settings.hostSni !== 'none'
            : settings.hostPort !== 'none';
      if (wanted) {
        rows.add({
          check,
          status: 'unknown',
          subject,
          reason: 'no_serving_node',
          actual: check === 'host.address' ? host.address : null,
        });
      }
    }
    return;
  }

  if (settings.hostAddress !== 'none') {
    hostAddressRow(host, subject, candidates, input, rows, where);
  }
  if (settings.hostSni !== 'none') {
    hostSniRow(host, subject, candidates, rows);
  }
  if (settings.hostPort !== 'none') {
    hostPortRow(host, subject, index, rows);
  }
}

function hostAddressRow(
  host: PanelHostView,
  subject: Subject,
  candidates: readonly PanelNodeView[],
  input: ReconcileInput,
  rows: Rows,
  where: (node: PanelNodeView) => Where,
): void {
  const policy = input.pack.reconciliation.hostAddress;
  const mine = whereIs(host.address, input);
  const nodes = candidates.map((node) => ({ node, w: where(node) }));
  const counterpart = nodes[0] === undefined ? null : refs.node(nodes[0].node);
  const related = nodes.slice(1).map(({ node }) => refs.node(node));
  const base = {
    check: 'host.address',
    subject,
    counterpart,
    related,
    actual: host.address,
  } as const;

  const matches = (n: (typeof nodes)[number]): 'address' | 'ip' | 'resolves' | null => {
    if (mine.addr === n.w.addr) {
      return policy === 'node-ip' && mine.kind === 'name' ? null : 'address';
    }
    if (policy === 'node-address') {
      return null;
    }
    if (isIpAddress(mine.addr) && n.w.ips.has(mine.addr)) {
      return 'ip';
    }
    if (policy === 'node' && mine.kind === 'name' && intersects(mine.ips, n.w.ips)) {
      return 'resolves';
    }
    return null;
  };

  for (const n of nodes) {
    const how = matches(n);
    if (how !== null) {
      const ip =
        how === 'resolves' ? ([...mine.ips].find((candidate) => n.w.ips.has(candidate)) ?? '') : '';
      rows.add({
        ...base,
        status: 'ok',
        counterpart: refs.node(n.node),
        reason:
          how === 'address'
            ? 'address_matches_node'
            : how === 'ip'
              ? 'address_is_node_ip'
              : 'address_resolves_to_node',
        params: { node: n.node.name, ip },
        expected: n.node.address,
      });
      return;
    }
  }

  const only = nodes.length === 1 ? nodes[0] : undefined;
  const expectedList = nodes.map(({ node, w }) =>
    policy === 'node-ip' ? list(w.ips, 1) || node.address : node.address,
  );
  const expected = list(new Set(expectedList));
  const nodeName = nodes[0]?.node.name ?? '';
  const fixTo =
    only === undefined
      ? null
      : policy === 'node-ip'
        ? list(only.w.ips, 1) || null
        : only.node.address;
  const fix =
    fixTo === null
      ? null
      : ({
          op: 'replace',
          path: '/address',
          from: host.address,
          to: fixTo,
          note: 'The address the pack expects for the node that serves the host.',
        } satisfies CheckFixHint);

  // Cannot decide: the node's IPs or the host's own name did not resolve.
  const nodeUnknown = nodes.filter(({ w }) => !w.known);
  if (policy !== 'node-address') {
    if (nodeUnknown.length === nodes.length) {
      rows.add({
        ...base,
        status: 'unknown',
        reason: 'node_ip_unknown',
        params: { node: nodeName },
        expected,
      });
      return;
    }
    if (policy === 'node' && mine.kind === 'name' && !mine.known) {
      rows.add({
        ...base,
        status: 'unknown',
        reason: 'host_name_unresolved',
        params: { address: host.address, node: nodeName },
        expected,
      });
      return;
    }
  }
  if (policy === 'node-ip' && mine.kind === 'name') {
    rows.add({
      ...base,
      status: 'drift',
      reason: 'address_not_ip',
      params: { address: host.address, node: nodeName },
      expected,
      fix,
    });
  } else if (policy === 'node-ip') {
    rows.add({
      ...base,
      status: 'drift',
      reason: 'address_not_node_ip',
      params: { address: host.address, node: nodeName, expected },
      expected,
      fix,
    });
  } else if (policy === 'node-address') {
    rows.add({
      ...base,
      status: 'drift',
      reason: 'address_not_node_address',
      params: { address: host.address, node: nodeName, expected },
      expected,
      fix,
    });
  } else {
    rows.add({
      ...base,
      status: 'drift',
      reason: 'address_differs',
      params: { address: host.address, node: nodeName, expected },
      expected,
      fix,
    });
  }
}

function hostSniRow(
  host: PanelHostView,
  subject: Subject,
  candidates: readonly PanelNodeView[],
  rows: Rows,
): void {
  if (host.keepSniBlank) {
    return; // deliberately blank
  }
  const named = candidates.filter((node) => addressKind(node.address) === 'name');
  const counterpart = candidates[0] === undefined ? null : refs.node(candidates[0]);
  if (named.length === 0) {
    rows.add({
      check: 'host.sni',
      status: 'unknown',
      subject,
      counterpart,
      reason: 'node_address_is_ip',
      params: { node: candidates[0]?.name ?? '' },
    });
    return;
  }
  const effective = host.overrideSniFromAddress ? host.address : (host.sni ?? '');
  const wanted = new Set(named.map((node) => normalizeAddress(node.address)));
  const expected = list(named.map((node) => node.address));
  const nodeName = named[0]?.name ?? '';
  if (effective.trim() === '') {
    rows.add({
      check: 'host.sni',
      status: 'drift',
      subject,
      counterpart,
      reason: 'sni_missing',
      params: { node: nodeName, expected },
      expected,
      fix:
        named.length === 1 && named[0] !== undefined
          ? {
              op: 'add',
              path: '/sni',
              from: null,
              to: named[0].address,
              note: 'The address of the node, as the pack asks.',
            }
          : null,
    });
  } else if (wanted.has(normalizeAddress(effective))) {
    const hit = named.find(
      (node) => normalizeAddress(node.address) === normalizeAddress(effective),
    );
    rows.add({
      check: 'host.sni',
      status: 'ok',
      subject,
      counterpart: hit === undefined ? counterpart : refs.node(hit),
      reason: 'sni_matches',
      params: { node: hit?.name ?? nodeName },
      expected,
      actual: effective,
    });
  } else {
    rows.add({
      check: 'host.sni',
      status: 'drift',
      subject,
      counterpart,
      reason: 'sni_differs',
      params: { sni: effective.slice(0, 100), node: nodeName, expected },
      expected,
      actual: effective,
      fix:
        named.length === 1 && named[0] !== undefined
          ? {
              op: 'replace',
              path: '/sni',
              from: effective,
              to: named[0].address,
              note: 'The address of the node, as the pack asks.',
            }
          : null,
    });
  }
}

function hostPortRow(host: PanelHostView, subject: Subject, index: ModelIndex, rows: Rows): void {
  const entry =
    host.inbound.configProfileInboundUuid === null
      ? undefined
      : index.inbounds.get(host.inbound.configProfileInboundUuid);
  if (entry === undefined) {
    return;
  }
  const tag = entry.inbound.tag;
  if (entry.inbound.port === null) {
    rows.add({
      check: 'host.port',
      status: 'unknown',
      subject,
      reason: 'inbound_port_unknown',
      params: { tag },
      actual: String(host.port),
    });
  } else if (entry.inbound.port === host.port) {
    rows.add({
      check: 'host.port',
      status: 'ok',
      subject,
      reason: 'port_matches',
      params: { tag },
      expected: String(entry.inbound.port),
      actual: String(host.port),
    });
  } else {
    rows.add({
      check: 'host.port',
      status: 'drift',
      subject,
      reason: 'port_differs',
      params: { port: host.port, expected: entry.inbound.port, tag },
      expected: String(entry.inbound.port),
      actual: String(host.port),
      fix: {
        op: 'replace',
        path: '/port',
        from: host.port,
        to: entry.inbound.port,
        note: 'The port of the inbound.',
      },
    });
  }
}

/** The strings of a list as a sorted list: the order of a list of ids or tags says nothing. */
const sortedText = (values: readonly string[]): string[] => [...values].sort();

/**
 * What makes a host a different entry for a client: everything that decides which server, with which settings and
 * under which conditions a client gets. The remark, the position in the list and the uuid are not in it (they name and
 * order the entry), and neither is the state `disabled` (a disabled host is in no subscription; such hosts are left
 * out before). Two hosts with one such key are the same entry twice. Hosts that differ in any of these fields are not
 * duplicates: the common layout of one host for each subscription template (a "global" and a "selective" entry of one
 * node, same address, port, SNI and inbound, different `xrayJsonTemplateUuid`) is on purpose.
 */
export function hostSelectionKey(host: PanelHostView): string {
  return canonicalJson({
    address: normalizeAddress(host.address),
    port: host.port,
    sni: (host.sni ?? '').trim().toLowerCase(),
    host: host.host,
    path: host.path,
    alpn: host.alpn,
    fingerprint: host.fingerprint,
    securityLayer: host.securityLayer,
    overrideSniFromAddress: host.overrideSniFromAddress,
    keepSniBlank: host.keepSniBlank,
    pinnedPeerCertSha256: host.pinnedPeerCertSha256,
    verifyPeerCertByName: host.verifyPeerCertByName,
    inbound: host.inbound,
    nodeUuids: sortedText(host.nodeUuids),
    xrayJsonTemplateUuid: host.xrayJsonTemplateUuid,
    vlessRouteId: host.vlessRouteId,
    shuffleHost: host.shuffleHost,
    mihomoX25519: host.mihomoX25519,
    mihomoIpVersion: host.mihomoIpVersion,
    xhttpExtraParams: host.xhttpExtraParams,
    muxParams: host.muxParams,
    sockoptParams: host.sockoptParams,
    finalMask: host.finalMask,
    mapper: host.mapper,
    internalSquads: {
      mode: host.internalSquads.mode,
      squadUuids: sortedText(host.internalSquads.squadUuids),
    },
    excludeFromSubscriptionTypes: sortedText(host.excludeFromSubscriptionTypes),
    includeInSrrRules: sortedText(host.includeInSrrRules),
    // Tags select hosts for a template (`tagRegex`, `sameTagAsRecipient`); the description and the visibility are what
    // a client or a person sees of the entry.
    tags: sortedText(host.tags),
    serverDescription: host.serverDescription,
    isHidden: host.isHidden,
  });
}

function hostDuplicates(hosts: readonly PanelHostView[], rows: Rows): void {
  const groups = new Map<string, PanelHostView[]>();
  for (const host of hosts) {
    if (host.isDisabled) {
      continue;
    }
    const key = hostSelectionKey(host);
    groups.set(key, [...(groups.get(key) ?? []), host]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const host of group) {
      rows.add({
        check: 'host.duplicate',
        status: 'drift',
        subject: subjects.host(host),
        related: group
          .filter((other) => other.uuid !== host.uuid)
          .slice(0, 5)
          .map((other) => refs.host(other)),
        reason: 'duplicate_host',
        params: { count: group.length },
        actual: host.address,
      });
    }
  }
}

// ---- nodes ------------------------------------------------------------------------------------------------------

function nodeDnsRows(node: PanelNodeView, w: Where, input: ReconcileInput, rows: Rows): void {
  if (w.kind !== 'name') {
    return;
  }
  const subject = subjects.node(node);
  const base = { check: 'node.dns', subject, actual: node.address } as const;
  const params = { address: node.address } as const;
  if (!input.pack.reconciliation.dnsEnabled) {
    rows.add({ ...base, status: 'unknown', reason: 'dns_disabled', params });
    return;
  }
  const answer = w.answer;
  if (answer === undefined) {
    rows.add({
      ...base,
      status: 'unknown',
      reason: 'dns_skipped_cap',
      params: { ...params, cap: 0 },
    });
    return;
  }
  switch (answer.status) {
    case 'ok': {
      const ips = list(answer.addresses, 5);
      if (answer.refused.length > 0) {
        rows.add({
          ...base,
          status: 'drift',
          reason: 'resolves_to_refused_address',
          params: { ...params, ip: answer.refused[0] ?? '' },
          actual: list([...answer.addresses, ...answer.refused], 5),
          ttl: answer.ttl,
        });
        break;
      }
      const high = answer.ttl !== null && answer.ttl > input.pack.reconciliation.maxTtlSeconds;
      rows.add({
        ...base,
        status: 'ok',
        reason: high ? 'resolves_high_ttl' : 'resolves',
        params: { ...params, ips, ttl: answer.ttl, max: input.pack.reconciliation.maxTtlSeconds },
        actual: ips,
        ttl: answer.ttl,
      });
      if (node.isDisabled && answer.addresses.length > 0) {
        rows.add({
          check: 'node.disabled-resolving',
          status: 'drift',
          subject,
          reason: 'disabled_but_resolves',
          params: { ...params, ips },
          actual: ips,
          ttl: answer.ttl,
        });
      }
      break;
    }
    case 'nxdomain':
    case 'invalid':
      rows.add({
        ...base,
        status: 'missing',
        reason: 'no_record',
        params,
        expected: 'A or AAAA record',
        actual: null,
      });
      break;
    case 'timeout':
      rows.add({ ...base, status: 'unknown', reason: 'dns_timeout', params });
      break;
    case 'cname_loop':
      rows.add({ ...base, status: 'unknown', reason: 'dns_cname_loop', params });
      break;
    case 'error':
      rows.add({ ...base, status: 'unknown', reason: 'dns_error', params });
      break;
  }
}

function nodeDuplicates(
  nodes: readonly PanelNodeView[],
  where: (node: PanelNodeView) => Where,
  rows: Rows,
): void {
  const groups = new Map<string, { value: string; nodes: PanelNodeView[] }>();
  const put = (key: string, value: string, node: PanelNodeView): void => {
    const group = groups.get(key) ?? { value, nodes: [] };
    if (!group.nodes.includes(node)) {
      group.nodes.push(node);
    }
    groups.set(key, group);
  };
  for (const node of nodes) {
    const w = where(node);
    put(`a:${w.addr}`, node.address, node);
    for (const ip of w.ips) {
      put(`i:${ip}`, ip, node);
    }
  }
  const seen = new Set<string>();
  for (const group of groups.values()) {
    if (group.nodes.length < 2) {
      continue;
    }
    const members = group.nodes
      .map((node) => node.uuid)
      .sort()
      .join(',');
    if (seen.has(members)) {
      continue;
    }
    seen.add(members);
    for (const node of group.nodes) {
      rows.add({
        check: 'node.duplicate',
        status: 'drift',
        subject: subjects.node(node),
        related: group.nodes
          .filter((other) => other.uuid !== node.uuid)
          .slice(0, 5)
          .map((other) => refs.node(other)),
        reason: 'duplicate_address',
        params: { value: group.value, count: group.nodes.length },
        actual: group.value,
        key: members,
      });
    }
  }
}

// ---- the inventory ----------------------------------------------------------------------------------------------

function inventoryRows(
  servers: readonly InventoryServer[],
  input: ReconcileInput,
  rows: Rows,
  where: (node: PanelNodeView) => Where,
): void {
  const { model, pack } = input;
  const settings = pack.reconciliation;
  const by = new Set(settings.matchBy);
  const serverWhere = new Map(servers.map((server) => [server.id, whereIs(server.address, input)]));
  const matchedServers = new Set<string>();

  for (const node of model.nodes) {
    const w = where(node);
    const hostname =
      node.system?.hostname === null || node.system?.hostname === undefined
        ? null
        : normalizeAddress(node.system.hostname);
    const hits: { server: InventoryServer; how: 'address' | 'dns' | 'hostname'; ip: string }[] = [];
    for (const server of servers) {
      const sw = serverWhere.get(server.id);
      if (sw === undefined) {
        continue;
      }
      let how: 'address' | 'dns' | 'hostname' | null = null;
      let ip = '';
      if (by.has('address') && sw.addr === w.addr) {
        how = 'address';
      } else if (by.has('dns') && intersects(sw.ips, w.ips)) {
        how = 'dns';
        ip = [...sw.ips].find((candidate) => w.ips.has(candidate)) ?? '';
      } else if (by.has('hostname') && hostname !== null) {
        const names = [
          normalizeAddress(server.name),
          server.hostname === null ? '' : normalizeAddress(server.hostname),
        ];
        if (names.includes(hostname)) {
          how = 'hostname';
        }
      }
      if (how !== null) {
        hits.push({ server, how, ip });
      }
    }
    const subject = subjects.node(node);
    const base = { check: 'node.server', subject, actual: node.address } as const;
    for (const hit of hits) {
      matchedServers.add(hit.server.id);
    }
    if (hits.length === 0) {
      // A name that did not resolve (on either side) leaves open whether a server matches by what it resolves to.
      const undecided =
        by.has('dns') && (!w.known || [...serverWhere.values()].some((sw) => !sw.known));
      if (undecided) {
        rows.add({ ...base, status: 'unknown', reason: 'match_undecided' });
      } else if (settings.reportUnmanaged) {
        rows.add({
          ...base,
          status: 'missing',
          reason: 'unmanaged',
          expected: 'a server of the inventory',
        });
      }
    } else if (hits.length === 1 && hits[0] !== undefined) {
      const hit = hits[0];
      const reason =
        hit.how === 'address'
          ? 'matched_by_address'
          : hit.how === 'dns'
            ? 'matched_by_dns'
            : 'matched_by_hostname';
      rows.add({
        ...base,
        status: 'ok',
        counterpart: refs.server(hit.server),
        reason,
        params: { server: hit.server.name, ip: hit.ip, hostname: hostname ?? '' },
        expected: hit.server.address,
      });
    } else {
      rows.add({
        ...base,
        status: 'drift',
        counterpart: hits[0] === undefined ? null : refs.server(hits[0].server),
        related: hits.slice(1, 6).map((hit) => refs.server(hit.server)),
        reason: 'ambiguous_servers',
        params: { count: hits.length, servers: list(hits.map((hit) => hit.server.name)) },
        expected: 'one server',
      });
    }
  }

  for (const server of servers) {
    const subject = subjects.server(server);
    if (server.state !== 'retired' && !matchedServers.has(server.id) && settings.reportExtra) {
      rows.add({
        check: 'server.node',
        status: 'extra',
        subject,
        reason: 'not_in_panel',
        actual: server.address,
        expected: 'a node of the panel',
      });
    }
  }
  const groups = new Map<string, { value: string; servers: InventoryServer[] }>();
  const put = (key: string, value: string, server: InventoryServer): void => {
    const group = groups.get(key) ?? { value, servers: [] };
    if (!group.servers.includes(server)) {
      group.servers.push(server);
    }
    groups.set(key, group);
  };
  for (const server of servers) {
    const sw = serverWhere.get(server.id);
    if (sw === undefined) {
      continue;
    }
    put(`a:${sw.addr}`, server.address, server);
    for (const ip of sw.ips) {
      put(`i:${ip}`, ip, server);
    }
  }
  const seen = new Set<string>();
  for (const group of groups.values()) {
    if (group.servers.length < 2) {
      continue;
    }
    const members = group.servers
      .map((server) => server.id)
      .sort()
      .join(',');
    if (seen.has(members)) {
      continue;
    }
    seen.add(members);
    for (const server of group.servers) {
      rows.add({
        check: 'server.duplicate',
        status: 'drift',
        subject: subjects.server(server),
        related: group.servers
          .filter((other) => other.id !== server.id)
          .slice(0, 5)
          .map((other) => refs.server(other)),
        reason: 'duplicate_server_address',
        params: { value: group.value, count: group.servers.length },
        actual: group.value,
        key: members,
      });
    }
  }
}
