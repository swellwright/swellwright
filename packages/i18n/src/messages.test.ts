import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LANGUAGES, type Language } from './languages.js';
import { NAMESPACES, resources } from './messages.js';

/** The plural endings i18next puts after a key; the categories a language needs come from Intl. */
const PLURAL_ENDING = /_(zero|one|two|few|many|other)$/u;

interface Entry {
  /** The key without a plural ending, with the namespace in front: `errors.rateLimited`. */
  readonly base: string;
  /** The plural category, or undefined for a plain key. */
  readonly category: string | undefined;
  readonly text: string;
}

function flatten(value: unknown, path: string[] = []): Entry[] {
  if (typeof value === 'string') {
    const last = path.at(-1) ?? '';
    const ending = PLURAL_ENDING.exec(last);
    const base = [...path.slice(0, -1), ending ? last.replace(PLURAL_ENDING, '') : last].join('.');
    return [{ base, category: ending?.[1], text: value }];
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => flatten(child, [...path, key]));
  }
  throw new Error(`Not a text or a group of texts: ${path.join('.')}`);
}

function entriesOf(language: Language): Entry[] {
  return flatten(resources[language]);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/gu)].map((m) => m[1] ?? '').sort();
}

function byBase(entries: readonly Entry[]): Map<string, Entry[]> {
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    grouped.set(entry.base, [...(grouped.get(entry.base) ?? []), entry]);
  }
  return grouped;
}

describe('the texts of the console', () => {
  it('has the same namespaces in every language', () => {
    for (const language of LANGUAGES) {
      assert.deepEqual(Object.keys(resources[language]), NAMESPACES, language);
    }
  });

  it('has the same keys in every language', () => {
    const source = [...byBase(entriesOf('en')).keys()].sort();
    for (const language of LANGUAGES) {
      const keys = [...byBase(entriesOf(language)).keys()].sort();
      assert.deepEqual(
        keys.filter((key) => !source.includes(key)),
        [],
        `${language} has keys English lacks`,
      );
      assert.deepEqual(
        source.filter((key) => !keys.includes(key)),
        [],
        `${language} lacks keys English has`,
      );
    }
  });

  it('has every plural form its language needs, and only those', () => {
    for (const language of LANGUAGES) {
      const needed = new Intl.PluralRules(language).resolvedOptions().pluralCategories.sort();
      for (const [base, entries] of byBase(entriesOf(language))) {
        const given = entries.flatMap((e) => (e.category ? [e.category] : [])).sort();
        if (given.length === 0) {
          continue;
        }
        assert.equal(
          entries.length,
          given.length,
          `${language}: ${base} mixes plain and plural keys`,
        );
        assert.deepEqual(
          given,
          needed,
          `${language}: ${base} needs the forms ${needed.join(', ')}`,
        );
      }
    }
  });

  it('uses the same placeholders in every language', () => {
    const source = byBase(entriesOf('en'));
    for (const language of LANGUAGES) {
      for (const [base, entries] of byBase(entriesOf(language))) {
        const expected = new Set((source.get(base) ?? []).flatMap((e) => placeholders(e.text)));
        for (const entry of entries) {
          const given = new Set(placeholders(entry.text));
          // A plural form may leave out the number (`One server` instead of `{{count}} server`).
          for (const name of given) {
            assert.ok(
              expected.has(name),
              `${language}: ${base} uses {{${name}}}, English does not`,
            );
          }
        }
        const used = new Set(entries.flatMap((e) => placeholders(e.text)));
        for (const name of expected) {
          assert.ok(used.has(name), `${language}: ${base} never uses {{${name}}}`);
        }
      }
    }
  });

  it('declines a word that follows a count: such a text has plural forms', () => {
    // "{{count}} servers" reads "1 servers" without plural forms, and Russian needs three. A label before the number
    // ("Servers: {{count}}") and these words, which do not change with the number, need none.
    const invariable: Record<Language, readonly string[]> = {
      en: ['d', 'h', 'min', 's', 'more', 'not', 'of'],
      ru: ['д', 'ч', 'мин', 'с', 'из'],
    };
    for (const language of LANGUAGES) {
      for (const entry of entriesOf(language)) {
        if (entry.category !== undefined) {
          continue;
        }
        for (const match of entry.text.matchAll(/\{\{\s*count\s*\}\}\s+(\p{L}+)/gu)) {
          assert.ok(
            invariable[language].includes(match[1] ?? ''),
            `${language}: ${entry.base} puts "${match[1] ?? ''}" after {{count}} but has no plural forms`,
          );
        }
      }
    }
  });

  it('says the number in a "one" form that is not only for one', () => {
    // Russian picks "one" for 21, 31, 101...: a "one" form without the number would say "one" for all of them.
    for (const language of LANGUAGES) {
      if (new Intl.PluralRules(language).select(21) !== 'one') {
        continue;
      }
      for (const entry of entriesOf(language)) {
        if (entry.category === 'one') {
          assert.ok(
            placeholders(entry.text).includes('count'),
            `${language}: ${entry.base}_one does not say {{count}}, yet it is used for 21 too`,
          );
        }
      }
    }
  });

  it('has no empty text', () => {
    for (const language of LANGUAGES) {
      for (const entry of entriesOf(language)) {
        assert.ok(entry.text.trim().length > 0, `${language}: ${entry.base} is empty`);
      }
    }
  });

  it('has translated every text of any length: Russian that equals English is a copy', () => {
    // Names and short technical words (TOTP, API) may be the same in both; a sentence may not.
    const english = new Map(entriesOf('en').map((e) => [`${e.base}/${e.category ?? ''}`, e.text]));
    for (const entry of entriesOf('ru')) {
      const source = english.get(`${entry.base}/${entry.category ?? ''}`);
      if (source !== undefined && source.length > 14) {
        assert.notEqual(entry.text, source, `ru: ${entry.base} is not translated`);
      }
    }
  });
});
