// New in Swellwright (ADR 0047). The places an item of the attention feed can lead to are paths of the console, named by the
// contract. This file fails the build when one of them stops being a route of the console, so a link cannot rot.
import type { AttentionLink } from '@swellwright/contracts';

import type { ROUTES } from '../routes.js';

type RouteValue<T> = T extends string ? T : { [K in keyof T]: RouteValue<T[K]> }[keyof T];

/** `true` as long as every link of the contract is a path in `ROUTES`; otherwise this does not compile. */
export const LINKS_ARE_ROUTES: [AttentionLink] extends [RouteValue<typeof ROUTES>] ? true : never =
  true;
