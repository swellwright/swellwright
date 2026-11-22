import type { PanelInboundView, PanelNodeView } from '@swellwright/contracts';
import { z } from 'zod';

import { type ProfileInput, refs, subjects } from '../model.js';
import { isWildcardListen, listenOf, rawInboundOf, snippetNames, transportOf } from '../xray.js';
import { clip, defineRule, patternParam } from './framework.js';

// Rules about config profiles and their inbounds.

export const profileInboundTagUnique = defineRule({
  id: 'profile.inbound-tag-unique',
  kind: 'configProfile',
  defaultSeverity: 'error',
  needs: ['configProfiles'],
  codes: ['duplicate_in_profile', 'duplicate_across_profiles'],
  params: z.strictObject({}),
  run({ model, emit }) {
    const owners = new Map<string, Set<string>>();
    for (const profile of model.profiles) {
      const counts = new Map<string, number>();
      for (const inbound of profile.inbounds) {
        counts.set(inbound.tag, (counts.get(inbound.tag) ?? 0) + 1);
        owners.set(inbound.tag, new Set([...(owners.get(inbound.tag) ?? []), profile.uuid]));
      }
      for (const [tag, count] of counts) {
        if (count > 1) {
          emit({
            code: 'duplicate_in_profile',
            subject: subjects.profile(profile),
            key: tag,
            params: { tag, count },
            fields: ['/config/inbounds'],
          });
        }
      }
    }
    for (const profile of model.profiles) {
      for (const tag of new Set(profile.inbounds.map((inbound) => inbound.tag))) {
        const others = [...(owners.get(tag) ?? [])].filter((uuid) => uuid !== profile.uuid);
        const other =
          others.length === 0
            ? undefined
            : model.profiles.find((candidate) => candidate.uuid === others[0]);
        if (other !== undefined) {
          emit({
            code: 'duplicate_across_profiles',
            subject: subjects.profile(profile),
            key: tag,
            related: [refs.profile(other)],
            params: { tag, other: other.name },
            fields: ['/config/inbounds'],
          });
        }
      }
    }
  },
});

interface Clash {
  /** `tcp:443`: the transport and the port. */
  readonly key: string;
  readonly inbounds: readonly PanelInboundView[];
}

/** The groups of inbounds among `inbounds` that listen on one port of one transport on overlapping addresses. */
function clashesAmong(profile: ProfileInput, inbounds: readonly PanelInboundView[]): Clash[] {
  const groups = new Map<string, { inbound: PanelInboundView; listen: string }[]>();
  for (const inbound of inbounds) {
    if (inbound.port === null) {
      continue;
    }
    const key = `${transportOf(inbound)}:${String(inbound.port)}`;
    groups.set(key, [
      ...(groups.get(key) ?? []),
      { inbound, listen: listenOf(rawInboundOf(profile, inbound)) },
    ]);
  }
  const out: Clash[] = [];
  for (const [key, entries] of groups) {
    // Two inbounds on one port clash when their listen addresses overlap: a specific address and the same one, or any
    // address with anything.
    const clashing = entries.filter((entry, i) =>
      entries.some(
        (other, j) =>
          i !== j &&
          (isWildcardListen(entry.listen) ||
            isWildcardListen(other.listen) ||
            entry.listen === other.listen),
      ),
    );
    if (clashing.length >= 2) {
      out.push({ key, inbounds: clashing.map((entry) => entry.inbound) });
    }
  }
  return out;
}

/** Names for a message: the first few, and how many more. */
const namesOf = (names: readonly string[]): string =>
  clip(
    names.length <= 3
      ? names.join(', ')
      : `${names.slice(0, 3).join(', ')} and ${String(names.length - 3)} more`,
  );

export const profileInboundPortClash = defineRule({
  id: 'profile.inbound-port-clash',
  kind: 'configProfile',
  defaultSeverity: 'error',
  needs: ['configProfiles'],
  codes: ['clash', 'possible_clash'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    // Xray runs the inbounds a node has ACTIVE, and nothing else of the profile (a profile holds one inbound for each
    // node in the common layout: twelve inbounds on port 443 and twelve nodes with one each do not clash). So the
    // inbounds are compared node by node, over the active ones. Where no node has an inbound of the profile active
    // (nobody uses it, or the nodes could not be read), the clash is only possible, and is a warning.
    for (const profile of model.profiles) {
      const byUuid = new Map(profile.inbounds.map((inbound) => [inbound.uuid, inbound]));
      const serving = index
        .nodesOfProfile(profile.uuid)
        .map((node) => ({
          node,
          active: node.configProfile.inbounds.flatMap((entry) => {
            const known = byUuid.get(entry.uuid);
            return known === undefined ? [] : [known];
          }),
        }))
        .filter((entry) => entry.active.length > 0);

      if (serving.length === 0) {
        for (const clash of clashesAmong(profile, profile.inbounds)) {
          emit({
            code: 'possible_clash',
            severity: 'warning',
            subject: subjects.profile(profile),
            key: clash.key,
            related: clash.inbounds.slice(0, 10).map((inbound) => refs.inbound(inbound)),
            params: {
              port: clash.inbounds[0]?.port ?? null,
              tags: clip(clash.inbounds.map((inbound) => inbound.tag).join(', ')),
            },
            fields: ['/config/inbounds'],
          });
        }
        continue;
      }

      // The same clash on several nodes is one finding that names them all.
      const found = new Map<string, { clash: Clash; nodes: PanelNodeView[] }>();
      for (const { node, active } of serving) {
        for (const clash of clashesAmong(profile, active)) {
          const id = `${clash.key}:${clash.inbounds
            .map((inbound) => inbound.tag)
            .sort()
            .join(',')}`;
          const entry = found.get(id) ?? { clash, nodes: [] };
          entry.nodes.push(node);
          found.set(id, entry);
        }
      }
      for (const [id, { clash, nodes }] of found) {
        emit({
          code: 'clash',
          subject: subjects.profile(profile),
          key: id,
          related: [
            ...clash.inbounds.slice(0, 10).map((inbound) => refs.inbound(inbound)),
            ...nodes.slice(0, 5).map((node) => refs.node(node)),
          ],
          params: {
            port: clash.inbounds[0]?.port ?? null,
            tags: clip(clash.inbounds.map((inbound) => inbound.tag).join(', ')),
            nodes: namesOf(nodes.map((node) => node.name)),
          },
          fields: ['/config/inbounds'],
        });
      }
    }
  },
});

export const profileSnippetExists = defineRule({
  id: 'profile.snippet-exists',
  kind: 'configProfile',
  defaultSeverity: 'error',
  needs: ['configProfiles', 'snippets'],
  codes: ['missing'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const profile of model.profiles) {
      for (const name of snippetNames(profile.config)) {
        if (!index.snippets.has(name)) {
          emit({
            code: 'missing',
            subject: subjects.profile(profile),
            key: name,
            params: { snippet: clip(name) },
            fields: ['/config'],
          });
        }
      }
    }
  },
});

export const profileNamePattern = defineRule({
  id: 'profile.name-pattern',
  kind: 'configProfile',
  defaultSeverity: 'warning',
  needs: ['configProfiles'],
  codes: ['mismatch'],
  patternParams: ['pattern'],
  requires: ['pattern'],
  params: z.strictObject({
    pattern: patternParam(
      'The name of a config profile must match this pattern entirely. The rule does nothing until a pattern is set.',
    ),
  }),
  run({ model, emit, pattern: compile }, { pattern }) {
    if (pattern === null) {
      return;
    }
    const matcher = compile(pattern);
    for (const profile of model.profiles) {
      if (!matcher.matches(profile.name)) {
        emit({
          code: 'mismatch',
          subject: subjects.profile(profile),
          params: { name: clip(profile.name), pattern: clip(pattern, 120) },
          fields: ['/name'],
        });
      }
    }
  },
});

export const profileUnused = defineRule({
  id: 'profile.unused',
  kind: 'configProfile',
  defaultSeverity: 'info',
  needs: ['configProfiles', 'nodes'],
  codes: ['unused', 'no_inbounds'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const profile of model.profiles) {
      if (index.nodesOfProfile(profile.uuid).length === 0) {
        emit({ code: 'unused', subject: subjects.profile(profile) });
      }
      if (profile.inbounds.length === 0) {
        emit({
          code: 'no_inbounds',
          subject: subjects.profile(profile),
          fields: ['/config/inbounds'],
        });
      }
    }
  },
});

export const profileShared = defineRule({
  id: 'profile.shared',
  kind: 'configProfile',
  defaultSeverity: 'info',
  needs: ['configProfiles', 'nodes'],
  codes: ['shared'],
  params: z.strictObject({
    minNodes: z
      .number()
      .int()
      .min(2)
      .max(1000)
      .default(2)
      .describe('From how many nodes on a profile counts as shared.'),
  }),
  run({ model, index, emit }, { minNodes }) {
    for (const profile of model.profiles) {
      const nodes = index.nodesOfProfile(profile.uuid);
      if (nodes.length >= minNodes) {
        emit({
          code: 'shared',
          subject: subjects.profile(profile),
          related: nodes.slice(0, 10).map((node) => refs.node(node)),
          params: { count: nodes.length },
        });
      }
    }
  },
});

export const PROFILE_RULES = [
  profileInboundTagUnique,
  profileInboundPortClash,
  profileSnippetExists,
  profileNamePattern,
  profileUnused,
  profileShared,
];
