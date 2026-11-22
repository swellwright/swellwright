import { HOST_RULES } from './rules/hosts.js';
import { NODE_RULES } from './rules/nodes.js';
import { PROFILE_RULES } from './rules/profiles.js';
import { OTHER_RULES } from './rules/others.js';
import type { Rule } from './rules/framework.js';

/** Every rule of the built-in set, in the order the console lists them. */
export const RULES: readonly Rule[] = [
  ...HOST_RULES,
  ...NODE_RULES,
  ...PROFILE_RULES,
  ...OTHER_RULES,
];

export const RULES_BY_ID: ReadonlyMap<string, Rule> = new Map(RULES.map((rule) => [rule.id, rule]));

if (RULES_BY_ID.size !== RULES.length) {
  throw new Error('Two rules share an id.');
}
for (const rule of RULES) {
  // The texts are nested by the two halves of the id (`host.address-policy`), so an id has exactly one dot.
  if (!/^[a-z]+\.[a-z][a-z-]*[a-z]$/u.test(rule.id)) {
    throw new Error(`The rule id ${rule.id} is not <area>.<name>.`);
  }
}
