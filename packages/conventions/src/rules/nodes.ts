import type { PanelHostView, PanelNodeView } from '@swellwright/contracts';
import { z } from 'zod';

import { addressKind, normalizeAddress, refs, subjects } from '../model.js';
import { clip, defineRule, patternParam } from './framework.js';

// Rules about nodes: reachable by some host, served by a profile, on the same versions as the rest.

/** `3.4.6` and `26.11.9-beta` as numbers; what cannot be read is null. */
export function versionParts(version: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+){0,3})/u.exec(version.trim());
  return match?.[1] === undefined ? null : match[1].split('.').map(Number);
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a) ?? [];
  const right = versionParts(b) ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** The value most nodes have; on a tie the newest. Null when there is nothing to compare (fewer than two nodes). */
function commonVersion(values: readonly string[]): string | null {
  if (values.length < 2) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(
    ([va, ca], [vb, cb]) => cb - ca || compareVersions(vb, va),
  );
  return ranked[0]?.[0] ?? null;
}

export const nodeHasHost = defineRule({
  id: 'node.has-host',
  kind: 'node',
  defaultSeverity: 'warning',
  needs: ['nodes', 'hosts', 'configProfiles'],
  codes: ['no_host'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const node of model.nodes) {
      if (node.isDisabled) {
        continue;
      }
      // A host points at a node when it is assigned to it, when its address is the node's address (or an IP the panel
      // knows for the node), or when the node is the only one that serves the inbound of a host that names no node.
      // Serving an inbound that other nodes serve too says nothing: a host has one address.
      const known = new Set([
        normalizeAddress(node.address),
        ...node.ips.map((entry) => normalizeAddress(entry.ip)),
      ]);
      const pointed = model.hosts.some((host) => {
        if (host.nodeUuids.includes(node.uuid) || known.has(normalizeAddress(host.address))) {
          return true;
        }
        const serving = host.nodeUuids.length === 0 ? index.servingNodes(host) : [];
        return serving.length === 1 && serving[0]?.uuid === node.uuid;
      });
      if (!pointed) {
        emit({ code: 'no_host', subject: subjects.node(node) });
      }
    }
  },
});

export const nodeDisabledReferenced = defineRule({
  id: 'node.disabled-referenced',
  kind: 'node',
  defaultSeverity: 'warning',
  needs: ['nodes', 'hosts', 'configProfiles'],
  codes: ['last_server', 'assigned'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const node of model.nodes) {
      if (!node.isDisabled) {
        continue;
      }
      const lastServer: PanelHostView[] = [];
      const assigned: PanelHostView[] = [];
      for (const host of model.hosts) {
        const serving = index.servingNodes(host);
        if (
          serving.length > 0 &&
          serving.every((s) => s.isDisabled) &&
          serving.some((s) => s.uuid === node.uuid)
        ) {
          lastServer.push(host);
        } else if (host.nodeUuids.includes(node.uuid)) {
          assigned.push(host);
        }
      }
      if (lastServer.length > 0) {
        emit({
          code: 'last_server',
          subject: subjects.node(node),
          related: lastServer.slice(0, 10).map((host) => refs.host(host)),
          params: { count: lastServer.length },
        });
      }
      if (assigned.length > 0) {
        emit({
          code: 'assigned',
          severity: 'info',
          subject: subjects.node(node),
          related: assigned.slice(0, 10).map((host) => refs.host(host)),
          params: { count: assigned.length },
        });
      }
    }
  },
});

export const nodeVersionSkew = defineRule({
  id: 'node.version-skew',
  kind: 'node',
  defaultSeverity: 'warning',
  needs: ['nodes'],
  codes: ['node_version', 'xray_version', 'panel_line'],
  params: z.strictObject({
    checkNodeVersion: z
      .boolean()
      .default(true)
      .describe('Report a node whose version differs from the one most nodes run.'),
    checkXrayVersion: z
      .boolean()
      .default(true)
      .describe('Report a node whose Xray differs from the one most nodes run.'),
    sameLineAsPanel: z
      .boolean()
      .default(true)
      .describe(
        "Report a node whose major.minor is not the panel's (3.4.6 and 3.4.11 are the same line).",
      ),
  }),
  run({ model, emit }, { checkNodeVersion, checkXrayVersion, sameLineAsPanel }) {
    const known = (pick: (n: PanelNodeView) => string | null): string[] =>
      model.nodes.flatMap((node) => {
        const value = pick(node);
        return value === null || versionParts(value) === null ? [] : [value];
      });
    const commonNode = commonVersion(known((n) => n.nodeVersion));
    const commonXray = commonVersion(known((n) => n.xrayVersion));
    const panelLine =
      model.panelVersion === null
        ? null
        : (versionParts(model.panelVersion) ?? []).slice(0, 2).join('.');
    for (const node of model.nodes) {
      const subject = subjects.node(node);
      if (
        checkNodeVersion &&
        node.nodeVersion !== null &&
        commonNode !== null &&
        node.nodeVersion !== commonNode &&
        versionParts(node.nodeVersion) !== null
      ) {
        emit({
          code: 'node_version',
          subject,
          params: { version: node.nodeVersion, common: commonNode },
        });
      }
      if (
        checkXrayVersion &&
        node.xrayVersion !== null &&
        commonXray !== null &&
        node.xrayVersion !== commonXray &&
        versionParts(node.xrayVersion) !== null
      ) {
        emit({
          code: 'xray_version',
          subject,
          params: { version: node.xrayVersion, common: commonXray },
        });
      }
      if (sameLineAsPanel && node.nodeVersion !== null && panelLine !== null && panelLine !== '') {
        const line = (versionParts(node.nodeVersion) ?? []).slice(0, 2).join('.');
        if (line !== '' && line !== panelLine) {
          emit({
            code: 'panel_line',
            subject,
            params: { version: node.nodeVersion, panel: model.panelVersion },
          });
        }
      }
    }
  },
});

export const nodeAddressValid = defineRule({
  id: 'node.address-valid',
  kind: 'node',
  defaultSeverity: 'error',
  needs: ['nodes'],
  codes: ['invalid'],
  params: z.strictObject({}),
  run({ model, emit }) {
    for (const node of model.nodes) {
      if (addressKind(node.address) === 'invalid') {
        emit({
          code: 'invalid',
          subject: subjects.node(node),
          params: { address: clip(node.address) },
          fields: ['/address'],
        });
      }
    }
  },
});

export const nodeProfileAssigned = defineRule({
  id: 'node.profile-assigned',
  kind: 'node',
  defaultSeverity: 'warning',
  needs: ['nodes', 'configProfiles'],
  codes: ['none', 'missing_profile', 'no_inbounds'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const node of model.nodes) {
      const subject = subjects.node(node);
      const uuid = node.configProfile.uuid;
      if (uuid === null) {
        emit({ code: 'none', subject, fields: ['/configProfile'] });
      } else if (!index.profiles.has(uuid)) {
        emit({
          code: 'missing_profile',
          severity: 'error',
          subject,
          fields: ['/configProfile/activeConfigProfileUuid'],
        });
      } else if (node.configProfile.inbounds.length === 0) {
        emit({ code: 'no_inbounds', subject, fields: ['/configProfile/activeInbounds'] });
      }
    }
  },
});

export const nodePluginExists = defineRule({
  id: 'node.plugin-exists',
  kind: 'node',
  defaultSeverity: 'error',
  needs: ['nodes', 'nodePlugins'],
  codes: ['missing'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const node of model.nodes) {
      if (node.activePluginUuid !== null && !index.nodePlugins.has(node.activePluginUuid)) {
        emit({ code: 'missing', subject: subjects.node(node), fields: ['/activePluginUuid'] });
      }
    }
  },
});

export const nodeNamePattern = defineRule({
  id: 'node.name-pattern',
  kind: 'node',
  defaultSeverity: 'warning',
  needs: ['nodes'],
  codes: ['mismatch'],
  patternParams: ['pattern'],
  requires: ['pattern'],
  params: z.strictObject({
    pattern: patternParam(
      'The name of a node must match this pattern entirely. The rule does nothing until a pattern is set.',
    ),
  }),
  run({ model, emit, pattern: compile }, { pattern }) {
    if (pattern === null) {
      return;
    }
    const matcher = compile(pattern);
    for (const node of model.nodes) {
      if (!matcher.matches(node.name)) {
        emit({
          code: 'mismatch',
          subject: subjects.node(node),
          params: { name: clip(node.name), pattern: clip(pattern, 120) },
          fields: ['/name'],
        });
      }
    }
  },
});

export const NODE_RULES = [
  nodeHasHost,
  nodeDisabledReferenced,
  nodeVersionSkew,
  nodeAddressValid,
  nodeProfileAssigned,
  nodePluginExists,
  nodeNamePattern,
];
