import type { PanelResource } from '@swellwright/contracts';
import type { PanelModel } from '@swellwright/conventions';

import type { ChecksRead } from '../panel/panel-reader.service.js';

/** What the reader returned, as the value the checks work on. */
export function toModel(read: ChecksRead, now = new Date()): PanelModel {
  return {
    panelVersion: read.panelVersion,
    nodes: read.nodes,
    hosts: read.hosts,
    profiles: read.profiles,
    internalSquads: read.internalSquads,
    externalSquads: read.externalSquads,
    templates: read.templates,
    snippets: read.snippets,
    nodePlugins: read.nodePlugins,
    subscriptionSettings: null,
    token: read.token,
    unavailable: new Set<PanelResource>(read.unavailable),
    now,
  };
}
