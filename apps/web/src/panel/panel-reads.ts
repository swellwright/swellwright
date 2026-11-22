// New in Swellwright. One read per kind of panel object, under one query key each, so a page and the drawers and
// look-ups that need the same list share a single request (the panel's pages do the same with their query hooks).
import {
  listPanelConfigProfiles,
  listPanelExternalSquads,
  listPanelHosts,
  listPanelInternalSquads,
  listPanelNodes,
  listPanelSnippets,
  listPanelSubscriptionTemplates,
} from '../api.js';
import { panelKey, usePanelRead } from './panel-data.js';

export const useNodesRead = (enabled = true) =>
  usePanelRead(panelKey('nodes'), listPanelNodes, enabled);

export const useHostsRead = (enabled = true) =>
  usePanelRead(panelKey('hosts'), listPanelHosts, enabled);

export const useProfilesRead = (enabled = true) =>
  usePanelRead(panelKey('config-profiles'), listPanelConfigProfiles, enabled);

export const useInternalSquadsRead = (enabled = true) =>
  usePanelRead(panelKey('internal-squads'), listPanelInternalSquads, enabled);

export const useExternalSquadsRead = (enabled = true) =>
  usePanelRead(panelKey('external-squads'), listPanelExternalSquads, enabled);

export const useTemplatesRead = (enabled = true) =>
  usePanelRead(panelKey('subscription-templates'), listPanelSubscriptionTemplates, enabled);

export const useSnippetsRead = (enabled = true) =>
  usePanelRead(panelKey('snippets'), listPanelSnippets, enabled);
