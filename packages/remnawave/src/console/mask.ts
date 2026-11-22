import { type Masked, type MaskOptions, maskSecrets, maskText } from '../mask.js';

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

function optionsFor(profile: ConsoleMaskProfile, key: MaskOptions['fingerprintKey']): MaskOptions {
  return profile === 'personal'
    ? {
        fingerprintKey: key,
        extraSecretKeys: [...CONSOLE_ACCESS_KEYS, ...CONSOLE_PERSONAL_KEYS],
        people: 'off',
      }
    : { fingerprintKey: key, extraSecretKeys: CONSOLE_ACCESS_KEYS };
}

/** Masks a parsed JSON answer. The input is not changed. */
export function maskConsoleJson(
  value: unknown,
  profile: ConsoleMaskProfile,
  fingerprintKey?: MaskOptions['fingerprintKey'],
): Masked<unknown> {
  return maskSecrets(value, optionsFor(profile, fingerprintKey));
}

/** Masks an answer that is text and not JSON (a page, YAML): the rules for values in text only. */
export function maskConsoleText(
  value: string,
  profile: ConsoleMaskProfile,
  fingerprintKey?: MaskOptions['fingerprintKey'],
): Masked<string> {
  return maskText(value, optionsFor(profile, fingerprintKey));
}
