// New in Swellwright (ADR 0047). What a person hid from the "Needs attention" card, kept in this browser only: the server
// keeps no dismissals (the feed is a projection of what it knows). An item is hidden together with its fingerprint, so
// it comes back when the facts behind it change (another count, another name), not when it merely gets older. The memory
// is kept per user: two people who share a browser do not hide things from each other.
import { useCallback, useState } from 'react';

import type { AttentionItem } from '@swellwright/contracts';

const KEY = 'sw-dashboard-hidden-v1';
const keyOf = (userId: string): string => `${KEY}:${userId}`;
/** More than this many remembered items is not a list a person made: the oldest are dropped. */
const MAX_REMEMBERED = 200;

type Hidden = Readonly<Record<string, string>>;

/** The remembered items, or nothing when the browser has no storage or what is stored is not a record of texts. */
function read(userId: string): Hidden {
  try {
    const raw = window.localStorage.getItem(keyOf(userId));
    if (raw === null) {
      return {};
    }
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length <= 16,
      ),
    );
  } catch {
    return {};
  }
}

function write(userId: string, value: Hidden): void {
  try {
    window.localStorage.setItem(keyOf(userId), JSON.stringify(value));
  } catch {
    // private window, storage blocked or full: the items are hidden until the page is left, which is all that is promised
  }
}

export interface HiddenAttention {
  /** Whether this item was hidden in this browser (and its facts have not changed since). */
  isHidden: (item: AttentionItem) => boolean;
  hide: (item: AttentionItem) => void;
  /** Shows everything again. */
  clear: () => void;
}

export function useHiddenAttention(userId: string): HiddenAttention {
  const [hidden, setHidden] = useState<Hidden>(() => read(userId));
  const hide = useCallback(
    (item: AttentionItem) => {
      setHidden((previous) => {
        const next = Object.fromEntries(
          [...Object.entries({ ...previous, [item.id]: item.fingerprint })].slice(-MAX_REMEMBERED),
        );
        write(userId, next);
        return next;
      });
    },
    [userId],
  );
  const clear = useCallback(() => {
    write(userId, {});
    setHidden({});
  }, [userId]);
  const isHidden = useCallback(
    (item: AttentionItem) => hidden[item.id] === item.fingerprint,
    [hidden],
  );
  return { isHidden, hide, clear };
}
