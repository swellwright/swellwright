import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { RULES_BY_ID } from './catalogue.js';
import { lint } from './lint.js';
import { checkPack, resolvePack } from './pack.js';
import { healthyFleet } from './test-model.js';

// The example pack of `examples/conventions` is documentation that a person pastes into the editor, so it is kept valid
// here: a rule that is renamed or a parameter that changes breaks this test and not the first person who tries the file.

const EXAMPLE = fileURLToPath(
  new URL('../../../examples/conventions/convention-pack.example.yaml', import.meta.url),
);

describe('the example pack', () => {
  const yaml = readFileSync(EXAMPLE, 'utf8');

  it('is a valid pack with no issue at all, not even a warning', () => {
    const checked = checkPack({ yaml });
    assert.equal(checked.result.valid, true, JSON.stringify(checked.result.issues));
    assert.deepEqual(checked.result.issues, []);
    assert.equal(checked.result.name, 'Example conventions');
  });

  it('names only rules that exist, and sets every pattern parameter it names', () => {
    const checked = checkPack({ yaml });
    assert.ok(checked.document !== null);
    for (const id of Object.keys(checked.document.rules ?? {})) {
      assert.ok(RULES_BY_ID.has(id), id);
    }
  });

  it('can run over a fleet, and shows what a pack changes', () => {
    const checked = checkPack({ yaml });
    assert.ok(checked.document !== null);
    const pack = resolvePack(checked.document, 'custom', 1);
    const run = lint(healthyFleet(), pack);
    // The healthy fleet is called "Node 1" and so on: the example's naming rules say so.
    assert.ok(run.findings.some((finding) => finding.ruleId === 'node.name-pattern'));
    // The rule that the example switches off does not run.
    assert.ok(run.findings.every((finding) => finding.ruleId !== 'profile.shared'));
  });

  it('holds nothing that belongs to an installation', () => {
    // Documentation addresses (RFC 5737 and RFC 2606) are the only kind of address a published example may carry.
    const addresses = yaml.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu) ?? [];
    for (const address of addresses) {
      assert.match(address, /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./u, address);
    }
    assert.doesNotMatch(yaml, /(?:^|[^a-z])(?:token|password|secret)\s*:/iu);
  });
});
