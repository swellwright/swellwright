import type { PanelHostView } from '@swellwright/contracts';
import { z } from 'zod';

import { addressKind, normalizeAddress, refs, subjects } from '../model.js';
import { realityServerNames, rawInboundOf, serverNameListed } from '../xray.js';
import { addHint, clip, defineRule, patternParam, rangesParam, replaceHint } from './framework.js';

// Rules about hosts (the entries of a subscription): their address, SNI, remark, binding and route id.

/** The address of the node a host most likely stands for: the only node that serves its inbound, when there is one. */
const onlyServingNode = (hostNodes: readonly { address: string }[]): { address: string } | null =>
  hostNodes.length === 1 ? (hostNodes[0] ?? null) : null;

export const hostAddressPolicy = defineRule({
  id: 'host.address-policy',
  kind: 'host',
  defaultSeverity: 'warning',
  needs: ['hosts'],
  codes: ['invalid', 'not_ip', 'not_domain'],
  params: z.strictObject({
    policy: z
      .enum(['ip', 'domain', 'any'])
      .default('any')
      .describe('What the address of a host must be: an IP address, a domain name, or either.'),
  }),
  run({ model, index, emit }, { policy }) {
    for (const host of model.hosts) {
      const kind = addressKind(host.address);
      const subject = subjects.host(host);
      const node = onlyServingNode(index.servingNodes(host));
      const params = { address: clip(host.address) };
      if (kind === 'invalid') {
        emit({ code: 'invalid', severity: 'error', subject, params, fields: ['/address'] });
      } else if (policy === 'ip' && kind === 'name') {
        const to = node !== null && addressKind(node.address) !== 'name' ? node.address : null;
        emit({
          code: 'not_ip',
          subject,
          params,
          fields: ['/address'],
          fix: replaceHint(
            '/address',
            host.address,
            to,
            'The address of the node that serves the host.',
          ),
        });
      } else if (policy === 'domain' && kind !== 'name') {
        const to = node !== null && addressKind(node.address) === 'name' ? node.address : null;
        emit({
          code: 'not_domain',
          subject,
          params,
          fields: ['/address'],
          fix: replaceHint(
            '/address',
            host.address,
            to,
            'The name of the node that serves the host.',
          ),
        });
      }
    }
  },
});

export const hostSniExplicit = defineRule({
  id: 'host.sni-explicit',
  kind: 'host',
  defaultSeverity: 'warning',
  needs: ['hosts'],
  codes: ['missing'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const host of model.hosts) {
      const blank = host.sni === null || host.sni.trim() === '';
      if (
        !blank ||
        host.securityLayer === 'NONE' ||
        host.overrideSniFromAddress ||
        host.keepSniBlank
      ) {
        continue;
      }
      // The first server name of the inbound is what the clients would use now; say so.
      const entry =
        host.inbound.configProfileInboundUuid === null
          ? undefined
          : index.inbounds.get(host.inbound.configProfileInboundUuid);
      const names =
        entry === undefined ? [] : realityServerNames(rawInboundOf(entry.profile, entry.inbound));
      emit({
        code: 'missing',
        subject: subjects.host(host),
        fields: ['/sni'],
        fix: addHint(
          '/sni',
          names[0] ?? null,
          'The server name of the inbound, so that the host does not depend on it.',
        ),
      });
    }
  },
});

export const hostRemarkUnique = defineRule({
  id: 'host.remark-unique',
  kind: 'host',
  defaultSeverity: 'warning',
  needs: ['hosts'],
  codes: ['empty', 'duplicate'],
  params: z.strictObject({
    caseSensitive: z
      .boolean()
      .default(false)
      .describe('Whether "Node" and "node" are different remarks.'),
  }),
  run({ model, emit }, { caseSensitive }) {
    const groups = new Map<string, PanelHostView[]>();
    for (const host of model.hosts) {
      const remark = host.remark.trim();
      if (remark === '') {
        emit({
          code: 'empty',
          severity: 'error',
          subject: subjects.host(host),
          fields: ['/remark'],
        });
        continue;
      }
      const key = caseSensitive ? remark : remark.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), host]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }
      for (const host of group) {
        emit({
          code: 'duplicate',
          subject: subjects.host(host),
          related: group
            .filter((other) => other.uuid !== host.uuid)
            .slice(0, 5)
            .map((other) => refs.host(other)),
          params: { remark: clip(host.remark), count: group.length },
          fields: ['/remark'],
        });
      }
    }
  },
});

export const hostRemarkPattern = defineRule({
  id: 'host.remark-pattern',
  kind: 'host',
  defaultSeverity: 'warning',
  needs: ['hosts'],
  codes: ['mismatch'],
  patternParams: ['pattern'],
  requires: ['pattern'],
  params: z.strictObject({
    pattern: patternParam(
      'The remark must match this pattern entirely. The rule does nothing until a pattern is set.',
    ),
  }),
  run({ model, emit, pattern: compile }, { pattern }) {
    if (pattern === null) {
      return;
    }
    const matcher = compile(pattern);
    for (const host of model.hosts) {
      if (!matcher.matches(host.remark)) {
        emit({
          code: 'mismatch',
          subject: subjects.host(host),
          params: { remark: clip(host.remark), pattern: clip(pattern, 120) },
          fields: ['/remark'],
        });
      }
    }
  },
});

export const hostInboundExists = defineRule({
  id: 'host.inbound-exists',
  kind: 'host',
  defaultSeverity: 'error',
  needs: ['hosts', 'configProfiles'],
  codes: ['unbound', 'missing_profile', 'missing_inbound', 'inbound_of_other_profile'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const host of model.hosts) {
      const { configProfileUuid, configProfileInboundUuid } = host.inbound;
      const subject = subjects.host(host);
      if (configProfileUuid === null && configProfileInboundUuid === null) {
        emit({ code: 'unbound', severity: 'warning', subject, fields: ['/inbound'] });
        continue;
      }
      const profile =
        configProfileUuid === null ? undefined : index.profiles.get(configProfileUuid);
      if (profile === undefined) {
        emit({ code: 'missing_profile', subject, fields: ['/inbound/configProfileUuid'] });
        continue;
      }
      const entry =
        configProfileInboundUuid === null
          ? undefined
          : index.inbounds.get(configProfileInboundUuid);
      if (entry === undefined) {
        emit({
          code: 'missing_inbound',
          subject,
          related: [refs.profile(profile)],
          fields: ['/inbound/configProfileInboundUuid'],
        });
      } else if (entry.profile.uuid !== profile.uuid) {
        emit({
          code: 'inbound_of_other_profile',
          subject,
          related: [refs.profile(profile), refs.profile(entry.profile)],
          params: { tag: entry.inbound.tag, profile: entry.profile.name },
          fields: ['/inbound'],
        });
      }
    }
  },
});

export const hostServingNode = defineRule({
  id: 'host.serving-node',
  kind: 'host',
  defaultSeverity: 'warning',
  needs: ['hosts', 'nodes', 'configProfiles'],
  codes: ['no_node', 'node_missing', 'node_not_serving'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const host of model.hosts) {
      if (host.isDisabled) {
        continue;
      }
      const { configProfileInboundUuid } = host.inbound;
      const entry =
        configProfileInboundUuid === null
          ? undefined
          : index.inbounds.get(configProfileInboundUuid);
      if (entry === undefined) {
        continue; // host.inbound-exists says it
      }
      const subject = subjects.host(host);
      const serving = index.servingNodes(host);
      if (serving.length === 0) {
        emit({
          code: 'no_node',
          subject,
          params: { tag: entry.inbound.tag },
          fields: ['/inbound'],
        });
      }
      for (const uuid of host.nodeUuids) {
        const node = index.nodes.get(uuid);
        if (node === undefined) {
          emit({ code: 'node_missing', subject, key: uuid, fields: ['/nodeUuids'] });
        } else if (!serving.some((s) => s.uuid === uuid)) {
          emit({
            code: 'node_not_serving',
            subject,
            key: uuid,
            related: [refs.node(node)],
            params: { node: node.name, tag: entry.inbound.tag },
            fields: ['/nodeUuids'],
          });
        }
      }
    }
  },
});

export const hostState = defineRule({
  id: 'host.state',
  kind: 'host',
  defaultSeverity: 'info',
  needs: ['hosts'],
  codes: ['disabled', 'hidden'],
  params: z.strictObject({
    report: z
      .array(z.enum(['disabled', 'hidden']))
      .max(2)
      .default(['disabled', 'hidden'])
      .describe('Which states to point out: `disabled`, `hidden`.'),
  }),
  run({ model, emit }, { report }) {
    for (const host of model.hosts) {
      if (host.isDisabled && report.includes('disabled')) {
        emit({ code: 'disabled', subject: subjects.host(host), fields: ['/isDisabled'] });
      }
      if (host.isHidden && report.includes('hidden')) {
        emit({ code: 'hidden', subject: subjects.host(host), fields: ['/isHidden'] });
      }
    }
  },
});

export const hostSniInInboundNames = defineRule({
  id: 'host.sni-in-inbound-names',
  kind: 'host',
  defaultSeverity: 'warning',
  needs: ['hosts', 'configProfiles'],
  codes: ['not_listed'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const host of model.hosts) {
      const sni = host.sni?.trim() ?? '';
      if (sni === '' || host.overrideSniFromAddress || host.securityLayer === 'NONE') {
        continue;
      }
      const entry =
        host.inbound.configProfileInboundUuid === null
          ? undefined
          : index.inbounds.get(host.inbound.configProfileInboundUuid);
      if (entry === undefined) {
        continue;
      }
      const names = realityServerNames(rawInboundOf(entry.profile, entry.inbound));
      if (names.length === 0 || serverNameListed(sni, names)) {
        continue;
      }
      emit({
        code: 'not_listed',
        subject: subjects.host(host),
        related: [refs.inbound(entry.inbound)],
        params: {
          sni: clip(sni),
          tag: entry.inbound.tag,
          names: clip(names.slice(0, 5).join(', ')),
        },
        fields: ['/sni'],
        fix: replaceHint('/sni', sni, names[0] ?? null, 'A server name the inbound accepts.'),
      });
    }
  },
});

export const hostVlessRouteId = defineRule({
  id: 'host.vless-route-id',
  kind: 'host',
  defaultSeverity: 'warning',
  needs: ['hosts'],
  codes: ['reserved', 'out_of_range', 'ambiguous'],
  params: z.strictObject({
    reserved: rangesParam(
      'Route ids that must not be used. The default is the observed behaviour of Remnawave 3.4.x: 0 and 0x4000-0x4FFF.',
      [
        { from: 0, to: 0, reason: 'zero' },
        { from: 16_384, to: 20_479, reason: '0x4000-0x4FFF' },
      ],
    ),
    max: z.number().int().min(0).max(1_000_000).default(65_535).describe('The largest route id.'),
    warnOnDuplicates: z
      .boolean()
      .default(false)
      .describe('Report one route id that hosts of different inbounds share.'),
  }),
  run({ model, emit }, { reserved, max, warnOnDuplicates }) {
    const check = (id: number, subject: ReturnType<typeof subjects.host>, field: string): void => {
      if (id < 0 || id > max) {
        emit({ code: 'out_of_range', subject, params: { id, max }, fields: [field] });
        return;
      }
      const hit = reserved.find((range) => id >= range.from && id <= range.to);
      if (hit !== undefined) {
        emit({
          code: 'reserved',
          subject,
          params: { id, from: hit.from, to: hit.to, reason: hit.reason ?? null },
          fields: [field],
        });
      }
    };
    const byId = new Map<number, PanelHostView[]>();
    for (const host of model.hosts) {
      if (host.vlessRouteId === null) {
        continue;
      }
      check(host.vlessRouteId, subjects.host(host), '/vlessRouteId');
      byId.set(host.vlessRouteId, [...(byId.get(host.vlessRouteId) ?? []), host]);
    }
    if (!model.unavailable.has('externalSquads')) {
      for (const squad of model.externalSquads) {
        const id = squad.hostOverrides.vlessRouteId;
        if (id !== null) {
          check(id, subjects.externalSquad(squad), '/hostOverrides/vlessRouteId');
        }
      }
    }
    if (!warnOnDuplicates) {
      return;
    }
    for (const [id, hosts] of byId) {
      const inbounds = new Set(hosts.map((host) => host.inbound.configProfileInboundUuid));
      if (inbounds.size < 2) {
        continue;
      }
      for (const host of hosts) {
        emit({
          code: 'ambiguous',
          subject: subjects.host(host),
          related: hosts
            .filter((other) => other.uuid !== host.uuid)
            .slice(0, 5)
            .map((other) => refs.host(other)),
          params: { id, count: inbounds.size },
          fields: ['/vlessRouteId'],
        });
      }
    }
  },
});

/** The same address, normalised, for the rules that compare addresses. */
export const sameAddress = (a: string, b: string): boolean =>
  normalizeAddress(a) === normalizeAddress(b);

export const HOST_RULES = [
  hostAddressPolicy,
  hostSniExplicit,
  hostRemarkUnique,
  hostRemarkPattern,
  hostInboundExists,
  hostServingNode,
  hostState,
  hostSniInInboundNames,
  hostVlessRouteId,
];
