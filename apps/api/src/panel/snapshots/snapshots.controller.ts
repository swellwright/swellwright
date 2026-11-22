import { Body, Controller, Inject, Req, type StreamableFile } from '@nestjs/common';
import {
  type CreatePanelSnapshotRequest,
  createPanelSnapshotRoute,
  deletePanelSnapshotRoute,
  diffPanelSnapshotRoute,
  exportPanelSnapshotRoute,
  getPanelSnapshotRoute,
  listPanelSnapshotsRoute,
  type PanelDiff,
  type PanelSnapshotList,
  type PanelSnapshotSummary,
} from '@swellwright/contracts';

import { type AuthedRequest, requestMeta, requireAuth } from '../../auth/context.js';
import { ContractRoute } from '../../contract-route.js';
import { PanelSnapshotsService } from './snapshots.service.js';

const actorOf = (req: AuthedRequest): { id: string; name: string } => {
  const { user } = requireAuth(req);
  return { id: user.id, name: user.username };
};

/** Snapshots of the connected panel and the diff between two of them (ADR 0043). */
@Controller()
export class PanelSnapshotsController {
  constructor(@Inject(PanelSnapshotsService) private readonly snapshots: PanelSnapshotsService) {}

  @ContractRoute(listPanelSnapshotsRoute)
  list(@Req() req: AuthedRequest): Promise<PanelSnapshotList> {
    return this.snapshots.list(listPanelSnapshotsRoute.request.query.parse(req.query));
  }

  @ContractRoute(createPanelSnapshotRoute)
  create(
    @Body() body: CreatePanelSnapshotRequest,
    @Req() req: AuthedRequest,
  ): Promise<PanelSnapshotSummary> {
    return this.snapshots.create(actorOf(req), body, requestMeta(req));
  }

  @ContractRoute(getPanelSnapshotRoute)
  get(@Req() req: AuthedRequest): Promise<PanelSnapshotSummary> {
    return this.snapshots.get(getPanelSnapshotRoute.request.params.parse(req.params).id);
  }

  @ContractRoute(deletePanelSnapshotRoute)
  async delete(@Req() req: AuthedRequest): Promise<void> {
    const { id } = deletePanelSnapshotRoute.request.params.parse(req.params);
    await this.snapshots.delete(actorOf(req), id, requestMeta(req));
  }

  @ContractRoute(diffPanelSnapshotRoute)
  diff(@Req() req: AuthedRequest): Promise<PanelDiff> {
    const { id } = diffPanelSnapshotRoute.request.params.parse(req.params);
    return this.snapshots.diff(
      actorOf(req),
      id,
      diffPanelSnapshotRoute.request.query.parse(req.query),
    );
  }

  @ContractRoute(exportPanelSnapshotRoute)
  export(@Req() req: AuthedRequest): Promise<StreamableFile> {
    return this.snapshots.export(exportPanelSnapshotRoute.request.params.parse(req.params).id);
  }
}
