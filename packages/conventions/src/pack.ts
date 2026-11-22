import {
  CONVENTION_PACK_FORMAT,
  CONVENTION_PACK_LIMITS,
  ConventionPackDocumentSchema,
  type CheckSeverity,
  type ConventionPackDocument,
  type ConventionPackValidation,
  type PackIssue,
  type PackRef,
  type PackRuleConfig,
  type ReconciliationCheck,
  type ReconciliationSettings,
  type ImpactSettings,
  type PackScope,
  HOST_ADDRESS_EXPECTATIONS,
  HOST_PORT_EXPECTATIONS,
  HOST_SNI_EXPECTATIONS,
  INVENTORY_MATCH_METHODS,
} from '@swellwright/contracts';
import { Document, parseDocument, YAMLMap, YAMLSeq, isMap, isPair, isScalar } from 'yaml';

import { RULES, RULES_BY_ID } from './catalogue.js';
import { canonicalJson, sha256 } from './json.js';
import { compileScope, type CompiledScope } from './scope.js';
import { patternProblem, UnsafePatternError } from './safe-pattern.js';
import type { Rule } from './rules/framework.js';
import { RULE_TEXTS } from './messages.js';

// A convention pack is data: a document that says which rules run, how severe they are, their parameters, whom they
// apply to, and what reconciliation and the impact calculator expect. This module reads one from text, checks it
// completely (the shape, every rule id, every parameter, every pattern), and turns it into what the engine runs.
// Nothing here is specific to any installation: the built-in pack holds the defaults of the rules and nothing else.

export const DEFAULT_RECONCILIATION = {
  hostAddress: 'node',
  hostSni: 'none',
  hostPort: 'none',
  dns: { enabled: true, maxTtlSeconds: 3600 },
  inventory: { matchBy: ['address', 'dns', 'hostname'], reportUnmanaged: true, reportExtra: true },
} as const satisfies ReconciliationSettings;

export const DEFAULT_IMPACT = {
  highRiskRestartNodes: 3,
  highRiskRestartShare: 0.5,
} as const satisfies ImpactSettings;

export interface ResolvedRule {
  readonly rule: Rule;
  readonly enabled: boolean;
  /** Replaces the severity of every finding of the rule; null keeps each finding's own. */
  readonly severity: CheckSeverity | null;
  /** The parameters with the defaults filled in. */
  readonly params: Record<string, unknown>;
  /** `undefined`: the rule has no scope of its own and the one of the pack applies. `null`: every object. */
  readonly scope: CompiledScope | null | undefined;
  readonly scopeSource: PackScope | undefined;
  readonly note: string | null;
  readonly inactive: 'disabled' | 'needs_params' | null;
}

export interface ResolvedReconciliation {
  readonly hostAddress: (typeof HOST_ADDRESS_EXPECTATIONS)[number];
  readonly hostSni: (typeof HOST_SNI_EXPECTATIONS)[number];
  readonly hostPort: (typeof HOST_PORT_EXPECTATIONS)[number];
  readonly dnsEnabled: boolean;
  readonly maxTtlSeconds: number;
  readonly matchBy: readonly (typeof INVENTORY_MATCH_METHODS)[number][];
  readonly reportUnmanaged: boolean;
  readonly reportExtra: boolean;
  readonly disabledChecks: ReadonlySet<ReconciliationCheck>;
  readonly scope: CompiledScope | null;
}

export interface ResolvedImpact {
  readonly highRiskRestartNodes: number;
  readonly highRiskRestartShare: number;
}

export interface ResolvedPack {
  readonly ref: PackRef;
  readonly document: ConventionPackDocument;
  readonly rules: ReadonlyMap<string, ResolvedRule>;
  readonly scope: CompiledScope | null;
  readonly reconciliation: ResolvedReconciliation;
  readonly impact: ResolvedImpact;
}

export const packHash = (document: ConventionPackDocument): string =>
  sha256(canonicalJson(document));

// ---- the built-in pack ------------------------------------------------------------------------------------------

/** The built-in pack: every rule, on, with its own defaults. It names nothing that belongs to an installation. */
export function builtInDocument(): ConventionPackDocument {
  const rules: Record<string, PackRuleConfig> = {};
  for (const rule of RULES) {
    const params: Record<string, unknown> = {};
    for (const info of rule.paramInfo) {
      if (info.default !== null) {
        params[info.name] = info.default;
      }
    }
    rules[rule.id] = { enabled: true, ...(Object.keys(params).length > 0 ? { params } : {}) };
  }
  return {
    format: CONVENTION_PACK_FORMAT,
    name: 'Built-in conventions',
    description:
      'The conventions every Remnawave fleet benefits from, with the defaults of each rule. Rules that need a pattern or a policy of your own do nothing until you give them one.',
    rules,
    reconciliation: {
      hostAddress: DEFAULT_RECONCILIATION.hostAddress,
      hostSni: DEFAULT_RECONCILIATION.hostSni,
      hostPort: DEFAULT_RECONCILIATION.hostPort,
      dns: { ...DEFAULT_RECONCILIATION.dns },
      inventory: {
        matchBy: [...DEFAULT_RECONCILIATION.inventory.matchBy],
        reportUnmanaged: DEFAULT_RECONCILIATION.inventory.reportUnmanaged,
        reportExtra: DEFAULT_RECONCILIATION.inventory.reportExtra,
      },
    },
    impact: { ...DEFAULT_IMPACT },
  };
}

/** A pack as YAML, with the rules explained by comments. Used for the built-in pack, to start an own one from. */
export function renderPackYaml(document: ConventionPackDocument): string {
  const yaml = new Document(document);
  const rules = yaml.get('rules', true);
  if (isMap(rules)) {
    for (const item of rules.items) {
      if (!isPair(item) || !isScalar(item.key) || typeof item.key.value !== 'string') {
        continue;
      }
      const rule = RULES_BY_ID.get(item.key.value);
      if (rule === undefined) {
        continue;
      }
      const [area, name] = rule.id.split('.') as [keyof typeof RULE_TEXTS, string];
      const texts = (
        RULE_TEXTS[area] as Record<string, { title: string; description: string } | undefined>
      )[name];
      item.key.commentBefore = ` ${texts?.title ?? rule.id} (default severity: ${rule.defaultSeverity})`;
    }
  }
  return yaml.toString({ lineWidth: 0 });
}

// ---- reading and checking ---------------------------------------------------------------------------------------

type PathPart = string | number | symbol;

/** `rules["host.remark-pattern"].params.pattern`: a key that is not a plain word is written in brackets. */
export function formatPath(path: readonly PathPart[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') {
      out += `[${String(part)}]`;
    } else {
      const text = String(part);
      out += /^[A-Za-z_][A-Za-z0-9_]*$/u.test(text)
        ? out === ''
          ? text
          : `.${text}`
        : `[${JSON.stringify(text)}]`;
    }
  }
  return out === '' ? '(document)' : out;
}

const issue = (
  path: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
  line: number | null = null,
  column: number | null = null,
): PackIssue => ({
  severity,
  path: path.slice(0, 300),
  message: message.slice(0, 500),
  line,
  column,
});

const MAX_DEPTH = 24;
const MAX_NODES = 50_000;

/** Whether a parsed document is nested too deeply or holds too much: hostile input is stopped before it is walked. */
function tooBig(value: unknown): boolean {
  let nodes = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    nodes += 1;
    if (nodes > MAX_NODES || current.depth > MAX_DEPTH) {
      return true;
    }
    if (typeof current.value === 'object' && current.value !== null) {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

/** Reads YAML (or JSON, which is YAML) into a plain value, or says what is wrong with the text. */
export function parsePackText(text: string): { value: unknown; issues: PackIssue[] } {
  if (text.length > CONVENTION_PACK_LIMITS.textChars) {
    return {
      value: undefined,
      issues: [
        issue(
          '(document)',
          `The pack is longer than ${String(CONVENTION_PACK_LIMITS.textChars)} characters.`,
        ),
      ],
    };
  }
  if (text.trim() === '') {
    return { value: undefined, issues: [issue('(document)', 'The pack is empty.')] };
  }
  // No anchors and aliases (a way to make a small text expand into a huge value), no custom tags, YAML 1.2.
  const parsed = parseDocument(text, {
    prettyErrors: true,
    uniqueKeys: true,
    version: '1.2',
    schema: 'core',
  });
  if (parsed.errors.length > 0) {
    return {
      value: undefined,
      issues: parsed.errors
        .slice(0, 10)
        .map((error) =>
          issue(
            '(document)',
            error.message.split('\n')[0] ?? 'Not valid YAML.',
            'error',
            error.linePos?.[0]?.line ?? null,
            error.linePos?.[0]?.col ?? null,
          ),
        ),
    };
  }
  let value: unknown;
  try {
    value = parsed.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return {
      value: undefined,
      issues: [issue('(document)', error instanceof Error ? error.message : 'Not valid YAML.')],
    };
  }
  if (tooBig(value)) {
    return {
      value: undefined,
      issues: [issue('(document)', 'The pack is nested too deeply or holds too many values.')],
    };
  }
  return { value, issues: [] };
}

function patternIssues(source: string | undefined, path: string): PackIssue[] {
  if (source === undefined) {
    return [];
  }
  const problem = patternProblem(source);
  return problem === null ? [] : [issue(path, `Pattern not accepted: ${problem}.`)];
}

function scopeIssues(scope: PackScope | undefined, path: string): PackIssue[] {
  return [
    ...patternIssues(scope?.match, `${path}.match`),
    ...patternIssues(scope?.exclude, `${path}.exclude`),
  ];
}

export interface CheckedPack {
  readonly result: ConventionPackValidation;
  readonly document: ConventionPackDocument | null;
}

/** The shape, the rule ids, the parameters and the patterns of a pack, checked; every problem is reported, not the first. */
export function checkPackValue(value: unknown): CheckedPack {
  const parsed = ConventionPackDocumentSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 50)
      .map((entry) => issue(formatPath(entry.path), entry.message));
    return { result: { valid: false, issues, name: null, rules: 0, hash: null }, document: null };
  }
  const document = parsed.data;
  const issues: PackIssue[] = [];
  issues.push(
    ...scopeIssues(document.scope, 'scope'),
    ...scopeIssues(document.reconciliation?.scope, 'reconciliation.scope'),
  );
  for (const [id, config] of Object.entries(document.rules ?? {})) {
    const path = formatPath(['rules', id]);
    const rule = RULES_BY_ID.get(id);
    if (rule === undefined) {
      issues.push(
        issue(
          path,
          `Unknown rule "${id}": it is ignored. A pack may be written for a newer release.`,
          'warning',
        ),
      );
      continue;
    }
    issues.push(...scopeIssues(config.scope, `${path}.scope`));
    const checked = rule.parseParams(config.params);
    if (!checked.ok) {
      for (const entry of checked.issues) {
        issues.push(
          issue(`${path}.params${entry.path === '' ? '' : `.${entry.path}`}`, entry.message),
        );
      }
      continue;
    }
    for (const name of rule.patternParams) {
      const source = checked.params[name];
      if (typeof source === 'string') {
        issues.push(...patternIssues(source, `${path}.params.${name}`));
      }
    }
  }
  const hasError = issues.some((entry) => entry.severity === 'error');
  return {
    result: {
      valid: !hasError,
      issues,
      name: document.name,
      rules: Object.keys(document.rules ?? {}).length,
      hash: hasError ? null : packHash(document),
    },
    document: hasError ? null : document,
  };
}

/** Text or a document, checked. */
export function checkPack(input: { yaml?: string | undefined; document?: unknown }): CheckedPack {
  if (input.yaml !== undefined) {
    const read = parsePackText(input.yaml);
    if (read.issues.length > 0) {
      return {
        result: { valid: false, issues: read.issues, name: null, rules: 0, hash: null },
        document: null,
      };
    }
    return checkPackValue(read.value);
  }
  return checkPackValue(input.document);
}

// ---- resolving --------------------------------------------------------------------------------------------------

function resolveReconciliation(
  settings: ReconciliationSettings | undefined,
): ResolvedReconciliation {
  const disabled = new Set<ReconciliationCheck>();
  for (const [check, setting] of Object.entries(settings?.checks ?? {})) {
    if (setting.enabled === false) {
      disabled.add(check as ReconciliationCheck);
    }
  }
  return {
    hostAddress: settings?.hostAddress ?? DEFAULT_RECONCILIATION.hostAddress,
    hostSni: settings?.hostSni ?? DEFAULT_RECONCILIATION.hostSni,
    hostPort: settings?.hostPort ?? DEFAULT_RECONCILIATION.hostPort,
    dnsEnabled: settings?.dns?.enabled ?? DEFAULT_RECONCILIATION.dns.enabled,
    maxTtlSeconds: settings?.dns?.maxTtlSeconds ?? DEFAULT_RECONCILIATION.dns.maxTtlSeconds,
    matchBy: settings?.inventory?.matchBy ?? DEFAULT_RECONCILIATION.inventory.matchBy,
    reportUnmanaged:
      settings?.inventory?.reportUnmanaged ?? DEFAULT_RECONCILIATION.inventory.reportUnmanaged,
    reportExtra: settings?.inventory?.reportExtra ?? DEFAULT_RECONCILIATION.inventory.reportExtra,
    disabledChecks: disabled,
    scope: compileScope(settings?.scope),
  };
}

/** A checked document as what the engine runs. Throws only for a document that was not checked first. */
export function resolvePack(
  document: ConventionPackDocument,
  source: 'built-in' | 'custom',
  version: number | null,
): ResolvedPack {
  const rules = new Map<string, ResolvedRule>();
  for (const rule of RULES) {
    const config = document.rules?.[rule.id];
    const checked = rule.parseParams(config?.params);
    if (!checked.ok) {
      throw new Error(`The parameters of ${rule.id} are not valid: resolve only a checked pack.`);
    }
    const enabled = config?.enabled ?? true;
    const needsParams = rule.requires.some(
      (name) => checked.params[name] === null || checked.params[name] === undefined,
    );
    rules.set(rule.id, {
      rule,
      enabled,
      severity: config?.severity ?? null,
      params: checked.params,
      scope: config?.scope === undefined ? undefined : compileScope(config.scope),
      scopeSource: config?.scope,
      note: config?.note ?? null,
      inactive: !enabled ? 'disabled' : needsParams ? 'needs_params' : null,
    });
  }
  return {
    ref: { source, version, name: document.name, hash: packHash(document) },
    document,
    rules,
    scope: compileScope(document.scope),
    reconciliation: resolveReconciliation(document.reconciliation),
    impact: {
      highRiskRestartNodes:
        document.impact?.highRiskRestartNodes ?? DEFAULT_IMPACT.highRiskRestartNodes,
      highRiskRestartShare:
        document.impact?.highRiskRestartShare ?? DEFAULT_IMPACT.highRiskRestartShare,
    },
  };
}

let builtIn: ResolvedPack | undefined;

/** The pack that runs when none was saved. */
export function builtInPack(): ResolvedPack {
  builtIn ??= resolvePack(builtInDocument(), 'built-in', null);
  return builtIn;
}

/** A stored document as a pack. A document that no longer passes the check (an older save, a newer release) is refused. */
export function loadPack(document: unknown, version: number): ResolvedPack | null {
  const checked = checkPackValue(document);
  if (checked.document === null) {
    return null;
  }
  try {
    return resolvePack(checked.document, 'custom', version);
  } catch (error) {
    if (error instanceof UnsafePatternError) {
      return null;
    }
    throw error;
  }
}

/** For tests and the catalogue: the YAMLMap type is used by callers that walk a rendered pack. */
export type { YAMLMap, YAMLSeq };
