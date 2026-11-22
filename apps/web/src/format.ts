// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/utils/time-utils/format-time.util.ts
// (the `TIME_FIRST_DATETIME` and `NUMERIC_DATETIME` templates) and its `dayjs` locale setup. Changes: a hook per
// template that follows the language of the console; an invalid value is an en dash, the console's mark for "nothing".
import dayjs from 'dayjs';
// The panel loads the locales it has languages for; the console has English (dayjs's own) and Russian. A new language
// of the console needs its `dayjs/locale/<code>` here, or its dates come out in English.
import 'dayjs/locale/ru';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** The panel's `TIME_FIRST_DATETIME`: the time with seconds first, then the date (`14:30:00, 5 March 2026`). */
const TIME_FIRST_DATETIME = 'HH:mm:ss, D MMMM YYYY';
/** The panel's `FULL_DATE`: a date without the time (`5 March 2026`). */
const FULL_DATE = 'D MMMM YYYY';
/** The panel's `NUMERIC_DATETIME`: `05.03.2026 14:30:00`, the same in every language. */
const NUMERIC_DATETIME = 'DD.MM.YYYY HH:mm:ss';

type Moment = string | number | Date;

function formatMoment(value: Moment, language: string, template: string): string {
  const moment = dayjs(value);
  if (!moment.isValid()) {
    return '–';
  }
  // `dayjs` takes `ru-RU` as `ru` and a language it does not know as English.
  return moment.locale(language).format(template);
}

/** Kept for callers that ask for a style: there is one format, the panel's, so both give the same text. */
type DateTimeStyle = 'short' | 'medium';

/**
 * Formats a date and time the way the panel does, in the language of the console: `14:30:00, 5 March 2026` or
 * `14:30:00, 5 марта 2026` (the panel's `TIME_FIRST_DATETIME`, checked against its tables). Use this instead of a
 * formatter made once at the top of a file: that one does not follow a change of language.
 *
 * The panel has one format for every place a moment is shown, so the `style` that earlier versions took changes
 * nothing; it stays so that the callers keep compiling.
 */
export function useDateTime(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for the callers, see above
  _style: DateTimeStyle = 'medium',
): (value: Moment) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => (value) => formatMoment(value, language, TIME_FIRST_DATETIME), [language]);
}

/** A time of day without the date (`14:30:00`), for a card that shows the date on its own line. */
export function useTimeOfDay(): (value: Moment) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => (value) => formatMoment(value, language, 'HH:mm:ss'), [language]);
}

/** A date without the time, as the panel's `FULL_DATE` (`5 March 2026`, `5 марта 2026`). */
export function useFullDate(): (value: Moment) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => (value) => formatMoment(value, language, FULL_DATE), [language]);
}

/** A moment as numbers (`05.03.2026 14:30:00`), as the panel's build information shows its build time. */
export function useNumericDateTime(): (value: Moment) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => (value) => formatMoment(value, language, NUMERIC_DATETIME), [language]);
}

/** Formats a whole number with the separators of the console's language. */
export function useNumber(): (value: number) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => {
    const format = new Intl.NumberFormat(language);
    return (value) => format.format(value);
  }, [language]);
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** Formats a size in bytes in binary units with the separators of the console's language (`1.92 GiB`, two decimals as the panel prints sizes). */
export function useBytes(): (bytes: number) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => {
    const format = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
    return (bytes) => {
      let value = Math.max(0, bytes);
      let unit = 0;
      while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${format.format(value)} ${BYTE_UNITS[unit] ?? 'B'}`;
    };
  }, [language]);
}
