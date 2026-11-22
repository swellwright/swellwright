// New in Swellwright (ADR 0044): the calls of the Checks page. Every answer is checked against the contract, so a server
// that drifts fails loudly. The checks only read; the one call that changes anything is the change of the pack.
import {
  type ConventionLastRun,
  ConventionLastRunSchema,
  type ConventionPackValidation,
  ConventionPackValidationSchema,
  type ConventionPackVersionList,
  ConventionPackVersionListSchema,
  type ConventionPackView,
  ConventionPackViewSchema,
  type ConventionRuleCatalog,
  ConventionRuleCatalogSchema,
  type ConventionRun,
  ConventionRunSchema,
  type ImpactKind,
  type ImpactReport,
  ImpactReportSchema,
  type ImpactRequest,
  type ImpactTarget,
  ImpactTargetSchema,
  type ReconciliationReport,
  ReconciliationReportSchema,
  type SaveConventionPackRequest,
  type ValidateConventionPackRequest,
} from '@swellwright/contracts';

import { send } from '../api.js';

const refreshQuery = (refresh: boolean): string => (refresh ? '?refresh=true' : '');

export const getConventionRules = (): Promise<ConventionRuleCatalog> =>
  send('GET', '/panel/checks/rules', undefined, ConventionRuleCatalogSchema);

/** Runs the linter. `refresh` asks the panel again instead of the memory of the server (rate limited). */
export const runConventionChecks = (refresh = false): Promise<ConventionRun> =>
  send('GET', `/panel/checks/convention${refreshQuery(refresh)}`, undefined, ConventionRunSchema);

/** What the last run found: from the memory of the server, nothing is run and the panel is not asked. */
export const getLastConventionRun = (): Promise<ConventionLastRun> =>
  send('GET', '/panel/checks/convention/last', undefined, ConventionLastRunSchema);

export const getConventionPack = (version?: number): Promise<ConventionPackView> =>
  send(
    'GET',
    `/panel/checks/convention-pack${version === undefined ? '' : `?version=${String(version)}`}`,
    undefined,
    ConventionPackViewSchema,
  );

export const listConventionPackVersions = (): Promise<ConventionPackVersionList> =>
  send('GET', '/panel/checks/convention-pack/versions', undefined, ConventionPackVersionListSchema);

/** The same checks as saving, without saving: the issues with their lines and paths. */
export const validateConventionPack = (
  request: ValidateConventionPackRequest,
): Promise<ConventionPackValidation> =>
  send('POST', '/panel/checks/convention-pack/validate', request, ConventionPackValidationSchema);

/** Saves the pack as a new version (`panel:write`, needs a fresh code). */
export const saveConventionPack = (
  request: SaveConventionPackRequest,
): Promise<ConventionPackView> =>
  send('PUT', '/panel/checks/convention-pack', request, ConventionPackViewSchema);

/** Goes back to the built-in pack; the saved versions stay in the history (`panel:write`, needs a fresh code). */
export const resetConventionPack = (): Promise<void> =>
  send('DELETE', '/panel/checks/convention-pack', undefined, undefined);

export const runReconciliation = (refresh = false): Promise<ReconciliationReport> =>
  send(
    'GET',
    `/panel/checks/reconciliation${refreshQuery(refresh)}`,
    undefined,
    ReconciliationReportSchema,
  );

/** An object in the form a change is written against, with its secrets masked. */
export const getImpactTarget = (kind: ImpactKind, uuid: string): Promise<ImpactTarget> =>
  send('GET', `/panel/impact/target?kind=${kind}&uuid=${uuid}`, undefined, ImpactTargetSchema);

/** The dry run: what the change would do. Nothing is sent to the panel. */
export const calculateImpact = (request: ImpactRequest): Promise<ImpactReport> =>
  send('POST', '/panel/impact', request, ImpactReportSchema);
