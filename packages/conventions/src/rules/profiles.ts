import type { PanelInboundView } from '@swellwright/contracts';
import { z } from 'zod';

import { refs, subjects } from '../model.js';
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

export const profileInboundPortClash = defineRule({
  id: 'profile.inbound-port-clash',
  kind: 'configProfile',
  defaultSeverity: 'error',
  needs: ['configProfiles'],
  codes: ['clash'],
  params: z.strictObject({}),
  run({ model, emit }) {
    for (const profile of model.profiles) {
      const groups = new Map<string, { inbound: PanelInboundView; listen: string }[]>();
      for (const inbound of profile.inbounds) {
        if (inbound.port === null) {
          continue;
        }
        const key = `${transportOf(inbound)}:${String(inbound.port)}`;
        groups.set(key, [
          ...(groups.get(key) ?? []),
          { inbound, listen: listenOf(rawInboundOf(profile, inbound)) },
        ]);
      }
      for (const [key, entries] of groups) {
        // Two inbounds on one port clash when their listen addresses overlap: a specific address and the same one, or
        // any address with anything.
        const clashing = entries.filter((entry, i) =>
          entries.some(
            (other, j) =>
              i !== j &&
              (isWildcardListen(entry.listen) ||
                isWildcardListen(other.listen) ||
                entry.listen === other.listen),
          ),
        );
        if (clashing.length < 2) {
          continue;
        }
        emit({
          code: 'clash',
          subject: subjects.profile(profile),
          key,
          related: clashing.slice(0, 10).map((entry) => refs.inbound(entry.inbound)),
          params: {
            port: clashing[0]?.inbound.port ?? null,
            tags: clip(clashing.map((entry) => entry.inbound.tag).join(', ')),
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
