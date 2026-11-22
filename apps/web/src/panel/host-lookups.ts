// New in Swellwright. The names that the pages of hosts and squads show instead of uuids: the config profiles and their
// inbounds, the nodes, the internal squads and the subscription templates. They come from the same reads as the pages
// of those objects, so a list that was opened already costs nothing; a list the token cannot read leaves the uuid.
import { useMemo } from 'react';

import {
  useExternalSquadsRead,
  useInternalSquadsRead,
  useNodesRead,
  useProfilesRead,
  useTemplatesRead,
} from './panel-reads.js';

export interface PanelNames {
  profiles: ReadonlyMap<string, string>;
  inbounds: ReadonlyMap<string, string>;
  nodes: ReadonlyMap<string, string>;
  internalSquads: ReadonlyMap<string, string>;
  externalSquads: ReadonlyMap<string, string>;
  templates: ReadonlyMap<string, string>;
}

/** Looks the names up; `of` falls back to the uuid itself. */
export function usePanelNames(): PanelNames & {
  of: (map: ReadonlyMap<string, string>, id: string) => string;
} {
  const profiles = useProfilesRead();
  const nodes = useNodesRead();
  const internal = useInternalSquadsRead();
  const external = useExternalSquadsRead();
  const templates = useTemplatesRead();

  const profileList = profiles.query.data?.configProfiles;
  const nodeList = nodes.query.data?.nodes;
  const internalList = internal.query.data?.internalSquads;
  const externalList = external.query.data?.externalSquads;
  const templateList = templates.query.data?.templates;

  return useMemo(
    () => ({
      profiles: new Map((profileList ?? []).map((profile) => [profile.uuid, profile.name])),
      inbounds: new Map(
        (profileList ?? []).flatMap((profile) =>
          profile.inbounds.map((inbound) => [inbound.uuid, inbound.tag] as const),
        ),
      ),
      nodes: new Map((nodeList ?? []).map((node) => [node.uuid, node.name])),
      internalSquads: new Map((internalList ?? []).map((squad) => [squad.uuid, squad.name])),
      externalSquads: new Map((externalList ?? []).map((squad) => [squad.uuid, squad.name])),
      templates: new Map((templateList ?? []).map((template) => [template.uuid, template.name])),
      of: (map: ReadonlyMap<string, string>, id: string) => map.get(id) ?? id,
    }),
    [profileList, nodeList, internalList, externalList, templateList],
  );
}
