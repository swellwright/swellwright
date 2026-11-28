import type { PackScope } from '@swellwright/contracts';

import type { Subject } from './model.js';
import { type CompiledPattern, compilePattern } from './safe-pattern.js';

/** Which objects a rule applies to: tags that must or must not be there, and patterns for the name. */
export interface CompiledScope {
  readonly source: PackScope;
  allows(subject: Subject, chargeWork?: (units: number) => void): boolean;
}

/** The scope of a rule or a pack, ready to ask. Throws `UnsafePatternError` for a pattern that is refused. */
export function compileScope(scope: PackScope | undefined): CompiledScope | null {
  if (scope === undefined) {
    return null;
  }
  const tags = new Set(scope.tags ?? []);
  const excludeTags = new Set(scope.excludeTags ?? []);
  const match: CompiledPattern | null =
    scope.match === undefined ? null : compilePattern(scope.match);
  const exclude: CompiledPattern | null =
    scope.exclude === undefined ? null : compilePattern(scope.exclude);
  if (tags.size === 0 && excludeTags.size === 0 && match === null && exclude === null) {
    return null;
  }
  return {
    source: scope,
    allows: (subject, chargeWork) => {
      if (tags.size > 0 && !subject.tags.some((tag) => tags.has(tag))) {
        return false;
      }
      if (subject.tags.some((tag) => excludeTags.has(tag))) {
        return false;
      }
      if (match !== null && !match.matches(subject.ref.name, chargeWork)) {
        return false;
      }
      return !exclude?.matches(subject.ref.name, chargeWork);
    },
  };
}
