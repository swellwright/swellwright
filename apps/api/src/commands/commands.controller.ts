import { Body, Controller, Inject, Req } from '@nestjs/common';
import {
  cancelCommandRunRoute,
  CommandOutputQuerySchema,
  type CommandOutputPage,
  CommandRunIdParamsSchema,
  CommandRunListQuerySchema,
  type CommandRunList,
  type CommandRunView,
  CommandTargetParamsSchema,
  createCommandRunRoute,
  type CreateCommandRunRequest,
  createScriptRoute,
  type CreateScriptRequest,
  deleteScriptRoute,
  getCommandOutputRoute,
  getCommandRunRoute,
  getScriptRoute,
  listCommandRunsRoute,
  listScriptsRoute,
  permissionsOf,
  type ScriptList,
  ScriptIdParamsSchema,
  type ScriptView,
  updateScriptRoute,
  type UpdateScriptRequest,
} from '@swellwright/contracts';
import type { Request } from 'express';

import { type AuthedRequest, requestMeta, requireAuth } from '../auth/context.js';
import { ContractRoute } from '../contract-route.js';
import { CommandRunsService } from './command-runs.service.js';
import { ScriptsService } from './scripts.service.js';

const actorOf = (req: AuthedRequest): { id: string; name: string } => {
  const { user } = requireAuth(req);
  return { id: user.id, name: user.username };
};

/** The script library and the runs (ADR 0038). The permissions and the step-up of every route are in the contract. */
@Controller()
export class CommandsController {
  constructor(
    @Inject(ScriptsService) private readonly scripts: ScriptsService,
    @Inject(CommandRunsService) private readonly runs: CommandRunsService,
  ) {}

  @ContractRoute(listScriptsRoute)
  listScripts(): Promise<ScriptList> {
    return this.scripts.list();
  }

  @ContractRoute(getScriptRoute)
  getScript(@Req() req: Request): Promise<ScriptView> {
    return this.scripts.get(ScriptIdParamsSchema.parse(req.params).id);
  }

  @ContractRoute(createScriptRoute)
  createScript(@Body() body: CreateScriptRequest, @Req() req: AuthedRequest): Promise<ScriptView> {
    return this.scripts.create(actorOf(req), body, requestMeta(req));
  }

  @ContractRoute(updateScriptRoute)
  updateScript(@Body() body: UpdateScriptRequest, @Req() req: AuthedRequest): Promise<ScriptView> {
    const { id } = ScriptIdParamsSchema.parse(req.params);
    return this.scripts.update(actorOf(req), id, body, requestMeta(req));
  }

  @ContractRoute(deleteScriptRoute)
  async deleteScript(@Req() req: AuthedRequest): Promise<void> {
    const { id } = ScriptIdParamsSchema.parse(req.params);
    await this.scripts.remove(actorOf(req), id, requestMeta(req));
  }

  @ContractRoute(createCommandRunRoute)
  createRun(
    @Body() body: CreateCommandRunRequest,
    @Req() req: AuthedRequest,
  ): Promise<CommandRunView> {
    const { user, grants } = requireAuth(req);
    return this.runs.create(
      actorOf(req),
      body,
      requestMeta(req),
      // A step-up route is for a session, so a token's grants never apply; the role's permissions do.
      grants ?? permissionsOf(user.role),
    );
  }

  @ContractRoute(listCommandRunsRoute)
  listRuns(@Req() req: Request): Promise<CommandRunList> {
    // Express exposes the query read-only and the interceptor only checks it: read it through the contract.
    return this.runs.list(CommandRunListQuerySchema.parse(req.query));
  }

  @ContractRoute(getCommandRunRoute)
  getRun(@Req() req: Request): Promise<CommandRunView> {
    return this.runs.get(CommandRunIdParamsSchema.parse(req.params).id);
  }

  @ContractRoute(getCommandOutputRoute)
  getOutput(@Req() req: Request): Promise<CommandOutputPage> {
    const { id, targetId } = CommandTargetParamsSchema.parse(req.params);
    return this.runs.output(id, targetId, CommandOutputQuerySchema.parse(req.query));
  }

  @ContractRoute(cancelCommandRunRoute)
  cancelRun(@Req() req: AuthedRequest): Promise<CommandRunView> {
    const { id } = CommandRunIdParamsSchema.parse(req.params);
    return this.runs.cancel(actorOf(req), id, requestMeta(req));
  }
}
