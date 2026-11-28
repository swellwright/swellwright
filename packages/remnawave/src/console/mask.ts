import { stringify as stringifyYaml } from 'yaml';

import {
  type Masked,
  type MaskOptions,
  maskSecrets,
  maskText,
  maskTextFailClosed,
  readYamlDocuments,
} from '../mask.js';

// What the API console hides in an answer of the panel (ADR 0046): the secrets every masked view hides, plus what the
// operations it can reach add. Two profiles. The first is for every answer: the access material of a user (a short
// UUID, a subscription link, the identity inside a connection link), which works as a credential for as long as it is
// valid, and the addresses of administrators in the panel's settings. The second is for the operations that are about
// people (`user_data`): their names, mail addresses, messenger ids, device identifiers, addresses and agents, and
// every UUID, so that a list of users can be read for its shape and its numbers and not for who is in it. The numeric
// `id` of a user stays: it is what the panel itself addresses a user by, and it is not personal on its own.

/** Masked wherever they appear, in every answer. Compared without case and separators. */
export const CONSOLE_ACCESS_KEYS: readonly string[] = [
  'shortUuid',
  'subscriptionUuid',
  'subscriptionUrl',
  'subUrl',
  'vlessUuid',
  'trojanPassword',
  'ssPassword',
  'links',
  'ssConfLinks',
  'connectionKeys',
  'enabledKeys',
  'hiddenKeys',
  'disabledKeys',
  'allowedEmails',
  // The Telegram accounts allowed to sign in to the panel (`oauth2Settings.telegram.allowedIds`): personal ids of its
  // administrators, like `allowedEmails`.
  'allowedIds',
  'allowedTelegramIds',
];

/** Masked as well in the answers about people. */
export const CONSOLE_PERSONAL_KEYS: readonly string[] = [
  'uuid',
  'userUuid',
  'username',
  'email',
  'telegramId',
  'description',
  'hwid',
  'deviceModel',
  'osVersion',
  'platform',
  'userAgent',
  'requestIp',
  'ip',
  'ips',
  'ipAddress',
  'userIp',
  'clientIp',
  'remoteIp',
  'sourceIp',
  'tag',
  'tags',
];

export type ConsoleMaskProfile = 'standard' | 'personal';

function optionsFor(
  profile: ConsoleMaskProfile,
  key: MaskOptions['fingerprintKey'],
  scrubDecodedYaml?: MaskOptions['scrubDecodedYaml'],
): MaskOptions {
  return profile === 'personal'
    ? {
        fingerprintKey: key,
        extraSecretKeys: [...CONSOLE_ACCESS_KEYS, ...CONSOLE_PERSONAL_KEYS],
        people: 'off',
        scrubDecodedYaml,
      }
    : { fingerprintKey: key, extraSecretKeys: CONSOLE_ACCESS_KEYS, scrubDecodedYaml };
}

/** Masks a parsed JSON answer. The input is not changed. */
export function maskConsoleJson(
  value: unknown,
  profile: ConsoleMaskProfile,
  fingerprintKey?: MaskOptions['fingerprintKey'],
  scrubDecodedYaml?: MaskOptions['scrubDecodedYaml'],
): Masked<unknown> {
  return maskSecrets(value, optionsFor(profile, fingerprintKey, scrubDecodedYaml));
}

const isContainer = (value: unknown): value is object =>
  value !== null && typeof value === 'object';

/**
 * Masks an answer that is text and not JSON. A clean YAML stream of at most `MAX_YAML_CHARS` (a subscription in a
 * client's format; several documents too) is read with bounds and masked by the names in it like a JSON answer, and
 * written again without its comments. Anything else (a larger text, a repeated key, a syntax error, a page) fails
 * closed: it is shown as `UNREADABLE_DOCUMENT`, unless it is a trivial text (one line without `:` or `=`, such as an
 * error sentence or a number), which gets the rules for values.
 */
export function maskConsoleText(
  value: string,
  profile: ConsoleMaskProfile,
  fingerprintKey?: MaskOptions['fingerprintKey'],
  scrubDecodedYaml?: MaskOptions['scrubDecodedYaml'],
): Masked<string> {
  const options = optionsFor(profile, fingerprintKey, scrubDecodedYaml);
  const documents = readYamlDocuments(value);
  if (documents?.some(isContainer) === true) {
    let count = 0;
    const parts = documents.map((document) => {
      // A document that is one text (`PASSWORD=...`, a block scalar) is a text without structure: the fail-closed rule.
      const masked = isContainer(document)
        ? maskSecrets(document, options)
        : typeof document === 'string'
          ? maskTextFailClosed(document, options)
          : { value: document, count: 0 };
      count += masked.count;
      return stringifyYaml(masked.value, { lineWidth: 0 });
    });
    if (count > 0 || value.includes('#') || documents.length > 1) {
      // The names of a mapping are not values to the structured masker: a key that is a URL with credentials in it is
      // caught by the value rules over the written text.
      const shaped = maskText(parts.join('---\n'), options);
      return { value: shaped.value, count: count + shaped.count };
    }
    // A clean document with nothing to hide keeps its text; the value rules still read all of it, names included.
    return maskText(value, options);
  }
  return maskTextFailClosed(value, options);
}
