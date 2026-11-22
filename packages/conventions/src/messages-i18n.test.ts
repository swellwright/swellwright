import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resources } from '@swellwright/i18n';

import { RULES } from './catalogue.js';
import { MESSAGES } from './messages.js';

// The English texts of the engine are the `message` fields of the API; the console shows the same keys from its own
// texts, in the language of the user. These tests keep the two apart in no way: every text exists in both, the English
// ones are the same, and every placeholder of a text is in its translation.

type Tree = { readonly [key: string]: string | Tree };

function flatten(tree: Tree, path: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') {
      out.set([...path, key].join('.'), value);
    } else {
      for (const [inner, text] of flatten(value, [...path, key])) {
        out.set(inner, text);
      }
    }
  }
  return out;
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/gu)]
    .flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
    .sort();

/** What the engine says: its texts, and the descriptions of the parameters of every rule. */
function engineTexts(): Map<string, string> {
  const texts = flatten(MESSAGES as unknown as Tree);
  for (const rule of RULES) {
    for (const param of rule.paramInfo) {
      texts.set(`rules.${rule.id}.params.${param.name}`, param.description);
    }
  }
  return texts;
}

/** What the console has under the keys of the engine (everything in the namespace but `ui`). */
function consoleTexts(language: 'en' | 'ru'): Map<string, string> {
  const { ui: _ui, ...engine } = resources[language].checks as unknown as Tree & { ui: Tree };
  return flatten(engine as Tree);
}

describe('the texts of the engine and the console', () => {
  it('are the same in English, key for key and word for word', () => {
    const engine = engineTexts();
    const console = consoleTexts('en');
    assert.deepEqual([...console.keys()].sort(), [...engine.keys()].sort());
    for (const [key, text] of engine) {
      assert.equal(console.get(key), text, key);
    }
  });

  it('exist in Russian under every key, with every placeholder', () => {
    const english = consoleTexts('en');
    const russian = consoleTexts('ru');
    assert.deepEqual([...russian.keys()].sort(), [...english.keys()].sort());
    for (const [key, text] of english) {
      const translated = russian.get(key) ?? '';
      assert.notEqual(translated, '', key);
      assert.deepEqual(placeholders(translated), placeholders(text), key);
    }
  });

  it('have a title, a description and a message for every rule and every code', () => {
    const english = consoleTexts('en');
    for (const rule of RULES) {
      assert.ok(english.has(`rules.${rule.id}.title`), rule.id);
      assert.ok(english.has(`rules.${rule.id}.description`), rule.id);
      for (const code of rule.codes) {
        assert.ok(english.has(`findings.${rule.id}.${code}`), `${rule.id}/${code}`);
      }
    }
  });
});
