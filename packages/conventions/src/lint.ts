import {
  CHECK_OBJECT_KINDS,
  CONVENTION_PACK_LIMITS,
  type CheckSeverity,
  type ConventionFinding,
  type ConventionRuleCatalog,
  type ConventionRuleInfo,
  type ConventionSummary,
  type PanelResource,
  RECONCILIATION_CHECKS,
} from '@swellwright/contracts';

import { RULES } from './catalogue.js';
import { message, MESSAGES } from './messages.js';
import { ModelIndex, type PanelModel } from './model.js';
import { type ResolvedPack } from './pack.js';
import { compilePattern, type CompiledPattern } from './safe-pattern.js';
import type { FindingInput, RuleContext } from './rules/framework.js';
import type { ConventionRuleCatalog as Catalog } from '@swellwright/contracts';

// The linter: runs the rules of a pack over a model and collects what they say. A rule that cannot run (the token
// could not read what it needs) is listed as skipped; a rule that throws is listed as failed and the others go on, so
// one bad rule never hides the rest. The result is a pure function of the model and the pack.

const SEVERITY_RANK: Record<CheckSeverity, number> = { error: 0, warning: 1, info: 2 };
const KIND_RANK = new Map<string, number>(CHECK_OBJECT_KINDS.map((kind, index) => [kind, index]));

export interface LintResult {
  readonly findings: ConventionFinding[];
  readonly summary: ConventionSummary;
  /** More findings than the limit: the summary counts them all, the list holds the first ones. */
  readonly truncated: boolean;
  readonly skipped: { ruleId: string; missing: PanelResource[] }[];
  readonly failed: { ruleId: string; message: string }[];
}

export interface LintOptions {
  /** The most findings to keep in the list. The summary counts every one. */
  readonly limit?: number;
}

const idOf = (ruleId: string, input: FindingInput): string =>
  [
    ruleId,
    input.code,
    input.subject.ref.kind,
    input.subject.ref.uuid ?? input.subject.ref.name,
    input.key,
  ]
    .filter((part) => part !== undefined)
    .join(':')
    .slice(0, 400);

function compareFindings(a: ConventionFinding, b: ConventionFinding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (KIND_RANK.get(a.object.kind) ?? 99) - (KIND_RANK.get(b.object.kind) ?? 99) ||
    a.object.name.localeCompare(b.object.name, 'en') ||
    a.ruleId.localeCompare(b.ruleId, 'en') ||
    a.id.localeCompare(b.id, 'en')
  );
}

export function lint(model: PanelModel, pack: ResolvedPack, options: LintOptions = {}): LintResult {
  const limit = options.limit ?? CONVENTION_PACK_LIMITS.findings;
  const index = new ModelIndex(model);
  const patterns = new Map<string, CompiledPattern>();
  const findings: ConventionFinding[] = [];
  const byRule: Record<string, number> = {};
  const counts: Record<CheckSeverity, number> = { error: 0, warning: 0, info: 0 };
  const objects = new Set<string>();
  const skipped: LintResult['skipped'] = [];
  const failed: LintResult['failed'] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    const resolved = pack.rules.get(rule.id);
    if (resolved?.inactive !== null) {
      continue;
    }
    const missing = rule.needs.filter((need) => model.unavailable.has(need));
    if (missing.length > 0) {
      skipped.push({ ruleId: rule.id, missing: [...missing] });
      continue;
    }
    const scope = resolved.scope === undefined ? pack.scope : resolved.scope;
    const context: RuleContext = {
      model,
      index,
      pattern: (source) => {
        let compiled = patterns.get(source);
        if (compiled === undefined) {
          compiled = compilePattern(source);
          patterns.set(source, compiled);
        }
        return compiled;
      },
      emit: (input) => {
        if (scope !== null && !scope.allows(input.subject)) {
          return;
        }
        const severity = resolved.severity ?? input.severity ?? rule.defaultSeverity;
        const id = idOf(rule.id, input);
        if (seen.has(id)) {
          return;
        }
        seen.add(id);
        counts[severity] += 1;
        byRule[rule.id] = (byRule[rule.id] ?? 0) + 1;
        objects.add(
          `${input.subject.ref.kind}:${input.subject.ref.uuid ?? input.subject.ref.name}`,
        );
        if (findings.length >= limit) {
          return;
        }
        const params = input.params ?? {};
        const messageKey = `findings.${rule.id}.${input.code}`;
        findings.push({
          id,
          ruleId: rule.id,
          code: input.code,
          severity,
          object: input.subject.ref,
          related: [...(input.related ?? [])].slice(0, 20),
          message: message(messageKey, params).slice(0, 1000),
          messageKey,
          params,
          fields: [...(input.fields ?? [])].slice(0, 20),
          fix: input.fix ?? null,
        });
      },
    };
    try {
      rule.run(context, resolved.params);
    } catch (error) {
      failed.push({
        ruleId: rule.id,
        message: (error instanceof Error ? error.message : 'The rule failed.').slice(0, 300),
      });
    }
  }
  findings.sort(compareFindings);
  const total = counts.error + counts.warning + counts.info;
  return {
    findings,
    summary: { ...counts, total, objects: objects.size, byRule },
    truncated: total > findings.length,
    skipped,
    failed,
  };
}

/** The catalogue of rules with the settings a pack gives them: what `GET /panel/checks/rules` answers. */
export function describeRules(pack: ResolvedPack): ConventionRuleCatalog {
  const rules: ConventionRuleInfo[] = RULES.map((rule) => {
    const resolved = pack.rules.get(rule.id);
    const scopeSource = resolved?.scope === undefined ? pack.document.scope : resolved.scopeSource;
    return {
      id: rule.id,
      kind: rule.kind,
      title: message(`rules.${rule.id}.title`, {}),
      description: message(`rules.${rule.id}.description`, {}),
      defaultSeverity: rule.defaultSeverity,
      needs: [...rule.needs],
      codes: [...rule.codes],
      params: rule.paramInfo.map((info) => ({ ...info })),
      effective: {
        enabled: resolved?.enabled ?? true,
        severity: resolved?.severity ?? rule.defaultSeverity,
        params: resolved?.params ?? {},
        scope:
          scopeSource === undefined || Object.keys(scopeSource).length === 0 ? null : scopeSource,
        active: resolved?.inactive === null,
        inactive: resolved?.inactive ?? null,
        note: resolved?.note ?? null,
      },
    };
  });
  const catalog: Catalog = {
    pack: pack.ref,
    rules,
    reconciliationChecks: RECONCILIATION_CHECKS.map((id) => ({
      id,
      title: message(`reconciliation.checks.${id}.title`, {}),
      description: message(`reconciliation.checks.${id}.description`, {}),
      enabled: !pack.reconciliation.disabledChecks.has(id),
    })),
  };
  return catalog;
}

/** The texts of the rules as a table of keys, for the tests that keep the console's texts in step. */
export const RULE_TEXT_KEYS = Object.keys(MESSAGES.rules);
