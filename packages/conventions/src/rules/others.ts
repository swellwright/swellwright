import type { PanelSubscriptionTemplateView } from '@swellwright/contracts';
import { z } from 'zod';

import { refs, subjects } from '../model.js';
import { clip, defineRule, patternParam } from './framework.js';

// Rules about squads, subscription templates and the connection itself.

export const squadInternalEmpty = defineRule({
  id: 'squad.internal-empty',
  kind: 'internalSquad',
  defaultSeverity: 'warning',
  needs: ['internalSquads'],
  codes: ['no_inbounds', 'no_members'],
  params: z.strictObject({}),
  run({ model, emit }) {
    for (const squad of model.internalSquads) {
      if (squad.inbounds.length === 0) {
        emit({
          code: 'no_inbounds',
          subject: subjects.internalSquad(squad),
          fields: ['/inbounds'],
        });
      }
      if (squad.membersCount === 0) {
        emit({ code: 'no_members', severity: 'info', subject: subjects.internalSquad(squad) });
      }
    }
  },
});

export const squadInboundExists = defineRule({
  id: 'squad.inbound-exists',
  kind: 'internalSquad',
  defaultSeverity: 'error',
  needs: ['internalSquads', 'configProfiles'],
  codes: ['missing'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const squad of model.internalSquads) {
      for (const inbound of squad.inbounds) {
        if (!index.inbounds.has(inbound.uuid)) {
          emit({
            code: 'missing',
            subject: subjects.internalSquad(squad),
            key: inbound.uuid,
            related: [refs.inbound(inbound)],
            params: { tag: inbound.tag },
            fields: ['/inbounds'],
          });
        }
      }
    }
  },
});

export const squadNamePattern = defineRule({
  id: 'squad.name-pattern',
  kind: 'internalSquad',
  defaultSeverity: 'warning',
  needs: ['internalSquads'],
  codes: ['mismatch'],
  patternParams: ['pattern'],
  requires: ['pattern'],
  params: z.strictObject({
    pattern: patternParam(
      'The name of a squad must match this pattern entirely. The rule does nothing until a pattern is set.',
    ),
    kinds: z
      .array(z.enum(['internal', 'external']))
      .min(1)
      .max(2)
      .default(['internal', 'external'])
      .describe('Which squads: `internal`, `external`.'),
  }),
  run({ model, emit, pattern: compile }, { pattern, kinds }) {
    if (pattern === null) {
      return;
    }
    const matcher = compile(pattern);
    const report = (subject: ReturnType<typeof subjects.internalSquad>): void => {
      if (!matcher.matches(subject.ref.name)) {
        emit({
          code: 'mismatch',
          subject,
          params: { name: clip(subject.ref.name), pattern: clip(pattern, 120) },
          fields: ['/name'],
        });
      }
    };
    if (kinds.includes('internal')) {
      for (const squad of model.internalSquads) {
        report(subjects.internalSquad(squad));
      }
    }
    if (kinds.includes('external') && !model.unavailable.has('externalSquads')) {
      for (const squad of model.externalSquads) {
        report(subjects.externalSquad(squad));
      }
    }
  },
});

export const squadExternalTemplateExists = defineRule({
  id: 'squad.external-template-exists',
  kind: 'externalSquad',
  defaultSeverity: 'error',
  needs: ['externalSquads', 'subscriptionTemplates'],
  codes: ['missing_template', 'type_mismatch'],
  params: z.strictObject({}),
  run({ model, index, emit }) {
    for (const squad of model.externalSquads) {
      for (const used of squad.templates) {
        const template = index.templates.get(used.templateUuid);
        if (template === undefined) {
          emit({
            code: 'missing_template',
            subject: subjects.externalSquad(squad),
            key: used.templateUuid,
            params: { type: used.templateType },
            fields: ['/templates'],
          });
        } else if (template.templateType !== used.templateType) {
          emit({
            code: 'type_mismatch',
            severity: 'warning',
            subject: subjects.externalSquad(squad),
            key: used.templateUuid,
            related: [refs.template(template)],
            params: {
              template: template.name,
              type: used.templateType,
              actual: template.templateType,
            },
            fields: ['/templates'],
          });
        }
      }
    }
  },
});

export const templateNamePattern = defineRule({
  id: 'template.name-pattern',
  kind: 'subscriptionTemplate',
  defaultSeverity: 'warning',
  needs: ['subscriptionTemplates'],
  codes: ['mismatch'],
  patternParams: ['pattern'],
  requires: ['pattern'],
  params: z.strictObject({
    pattern: patternParam(
      'The name of a subscription template must match this pattern entirely. The rule does nothing until a pattern is set.',
    ),
  }),
  run({ model, emit, pattern: compile }, { pattern }) {
    if (pattern === null) {
      return;
    }
    const matcher = compile(pattern);
    for (const template of model.templates) {
      if (!matcher.matches(template.name)) {
        emit({
          code: 'mismatch',
          subject: subjects.template(template),
          params: { name: clip(template.name), pattern: clip(pattern, 120) },
          fields: ['/name'],
        });
      }
    }
  },
});

const hasBody = (template: PanelSubscriptionTemplateView): boolean =>
  template.templateJson !== null ||
  (template.templateYaml !== null && template.templateYaml.trim() !== '');

export const templateBodyPresent = defineRule({
  id: 'template.body-present',
  kind: 'subscriptionTemplate',
  defaultSeverity: 'error',
  needs: ['subscriptionTemplates'],
  codes: ['unreadable', 'not_loaded'],
  params: z.strictObject({
    types: z
      .array(z.string().min(1).max(40))
      .max(30)
      .default(['XRAY_JSON', 'MIHOMO', 'STASH', 'CLASH', 'SINGBOX'])
      .describe('The template types that must have a body that parses (JSON or YAML).'),
  }),
  run({ model, emit }, { types }) {
    for (const template of model.templates) {
      if (!types.includes(template.templateType)) {
        continue;
      }
      const subject = subjects.template(template);
      // The list of templates of the panel carries no bodies (3.4.11): a template whose body was not read is not a
      // template without a body, and is never reported as one.
      if (!template.bodyLoaded) {
        emit({ code: 'not_loaded', severity: 'info', subject, params: { type: template.templateType } });
        continue;
      }
      if (!hasBody(template)) {
        const format =
          template.templateType === 'XRAY_JSON' || template.templateType === 'SINGBOX'
            ? 'JSON'
            : 'YAML';
        emit({
          code: 'unreadable',
          subject,
          params: { format, type: template.templateType },
          fields: [format === 'JSON' ? '/templateJson' : '/templateYaml'],
        });
      }
    }
  },
});

export const templateUnused = defineRule({
  id: 'template.unused',
  kind: 'subscriptionTemplate',
  defaultSeverity: 'info',
  needs: ['subscriptionTemplates', 'externalSquads', 'hosts'],
  codes: ['unused'],
  params: z.strictObject({
    ignoreNames: z
      .array(z.string().min(1).max(100))
      .max(20)
      .default(['Default'])
      .describe(
        'Template names that are never reported: the panel uses its "Default" template of each type on its own, for every squad and host that names none.',
      ),
  }),
  run({ model, emit }, { ignoreNames }) {
    const used = new Set<string>();
    for (const squad of model.externalSquads) {
      for (const template of squad.templates) {
        used.add(template.templateUuid);
      }
    }
    for (const host of model.hosts) {
      if (host.xrayJsonTemplateUuid !== null) {
        used.add(host.xrayJsonTemplateUuid);
      }
    }
    for (const template of model.templates) {
      if (!used.has(template.uuid) && !ignoreNames.includes(template.name)) {
        emit({ code: 'unused', subject: subjects.template(template) });
      }
    }
  },
});

export const panelTokenExpiry = defineRule({
  id: 'panel.token-expiry',
  kind: 'panel',
  defaultSeverity: 'warning',
  needs: [],
  codes: ['expiring', 'expired'],
  params: z.strictObject({
    warnDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(14)
      .describe('Warn this many days before the API token of the connection expires.'),
  }),
  run({ model, emit }, { warnDays }) {
    const token = model.token;
    if (token?.daysLeft === null || token === null) {
      return;
    }
    if (token.daysLeft < 0) {
      emit({ code: 'expired', severity: 'error', subject: subjects.panel() });
    } else if (token.daysLeft <= warnDays) {
      emit({ code: 'expiring', subject: subjects.panel(), params: { days: token.daysLeft } });
    }
  },
});

export const OTHER_RULES = [
  squadInternalEmpty,
  squadInboundExists,
  squadNamePattern,
  squadExternalTemplateExists,
  templateNamePattern,
  templateBodyPresent,
  templateUnused,
  panelTokenExpiry,
];
