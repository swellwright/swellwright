import { type DynamicModule, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DnsQuery } from '@swellwright/conventions';
import { Database } from '@swellwright/db';
import { type EnginePorts, StepRegistry, WorkflowRegistry } from '@swellwright/engine';

import { ArtifactsController } from './artifacts/artifacts.controller.js';
import { CatalogueService } from './artifacts/catalogue.service.js';
import { DistributionService } from './artifacts/distribution.service.js';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { AuthGuard, OriginGuard, PermissionGuard, StepUpGuard } from './auth/guards.js';
import { DEFAULT_PASSWORD_PARAMS, PasswordHasher, type PasswordParams } from './auth/password.js';
import { SecretBox } from './auth/secret-box.js';
import { SessionManagementService } from './auth/session-management.service.js';
import { SessionService } from './auth/session.service.js';
import { TokenService } from './auth/token.service.js';
import { TokensController } from './auth/tokens.controller.js';
import { SessionsController } from './auth/sessions.controller.js';
import { SetupController } from './auth/setup.controller.js';
import { SetupService } from './auth/setup.service.js';
import { BaselineController } from './baseline/baseline.controller.js';
import { BaselinesService } from './baseline/baselines.service.js';
import { CheckRunner } from './baseline/check-runner.service.js';
import { CheckRunsService } from './baseline/check-runs.service.js';
import { CheckScheduler } from './baseline/check-scheduler.service.js';
import { CommandRunner } from './commands/command-runner.service.js';
import { CommandRunsService } from './commands/command-runs.service.js';
import { CommandsController } from './commands/commands.controller.js';
import { ScriptsService } from './commands/scripts.service.js';
import { type AppConfig } from './config.js';
import { DashboardController } from './dashboard/dashboard.controller.js';
import { DashboardService } from './dashboard/dashboard.service.js';
import { enginePorts } from './engine/engine-ports.js';
import { type EngineTuning, EngineRunner } from './engine/engine-runner.js';
import { EngineRunsService } from './engine/engine-runs.service.js';
import { PrismaRunStore } from './engine/prisma-run-store.js';
import {
  CHECKS_CLOCK,
  CLOCK,
  CONFIG,
  DATABASE,
  DNS_QUERY,
  ENGINE_CATALOGUE,
  ENGINE_PORTS,
  ENGINE_TUNING,
  PASSWORD_HASHER,
  PLUGIN_NETWORK,
  RUN_STORE,
  SECRET_BOX,
  SNAPSHOT_CLOCK,
  VAULT_KDF,
} from './tokens.js';
import {
  DatabaseCheck,
  READINESS_CHECKS,
  type ReadinessCheck,
  ReadinessService,
  ValkeyCheck,
} from './readiness.js';
import { ChecksController } from './checks/checks.controller.js';
import { ChecksService } from './checks/checks.service.js';
import { nodeDnsQuery } from './checks/dns-query.js';
import { InventoryReader } from './checks/inventory.js';
import { ChecksMemory } from './checks/memory.js';
import { ConventionPackService } from './checks/pack.service.js';
import { PanelClients } from './panel/clients.js';
import { PanelConsoleController } from './panel/console/console.controller.js';
import { PanelConsoleService } from './panel/console/console.service.js';
import { PanelCache } from './panel/panel-cache.js';
import { PanelController } from './panel/panel.controller.js';
import { PanelMonitorService } from './panel/panel-monitor.service.js';
import { PanelReaderService } from './panel/panel-reader.service.js';
import { PanelService } from './panel/panel.service.js';
import { PanelSnapshotScheduler } from './panel/snapshots/snapshot-scheduler.service.js';
import { PanelSnapshotsController } from './panel/snapshots/snapshots.controller.js';
import { PanelSnapshotsService } from './panel/snapshots/snapshots.service.js';
import { PluginBroker } from './plugins/broker.js';
import { PluginNetwork } from './plugins/host/network.js';
import { PluginHostService } from './plugins/host/plugin-host.service.js';
import { PluginsController } from './plugins/plugins.controller.js';
import { PluginsService } from './plugins/plugins.service.js';
import { PluginRuntime } from './plugins/runtime.js';
import { RolesController } from './roles.controller.js';
import { ServerSshService } from './servers/server-ssh.service.js';
import { ServersController } from './servers/servers.controller.js';
import { ServersService } from './servers/servers.service.js';
import { SshService } from './servers/ssh.service.js';
import { SystemController } from './system.controller.js';
import { UpdatesService } from './system/updates.service.js';
import { InvitationService } from './users/invitation.service.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';
import type { KdfParams } from './vault/kdf.js';
import { VaultController } from './vault/vault.controller.js';
import { VaultService } from './vault/vault.service.js';

/** The run engine in a test: the steps and workflows it knows, and how its loop starts. Production has no steps yet. */
export interface EngineOptions {
  readonly steps?: StepRegistry<EnginePorts>;
  readonly workflows?: WorkflowRegistry<EnginePorts>;
  readonly tuning?: EngineTuning;
}

export interface AppOptions {
  /** Replaces the checks built from the configuration (tests). */
  readonly readinessChecks?: readonly ReadinessCheck[];
  /** Cheaper Argon2id parameters for tests; production always uses the defaults. */
  readonly passwordParams?: PasswordParams;
  /** A database to use instead of the one built from the configuration (tests with a schema of their own). */
  readonly database?: Database;
  /** Cheaper Argon2id parameters for the vault passphrase in tests; production uses the configuration. */
  readonly vaultKdf?: KdfParams;
  /** The core's door for plugin requests, replaced in tests so no real network is used. */
  readonly pluginNetwork?: PluginNetwork;
  /** The clock of the update check (milliseconds since the epoch), so that tests need not wait a day. */
  readonly clock?: () => number;
  /** Answers the DNS questions of the reconciliation, replaced in tests so that no real name is looked up. */
  readonly dnsQuery?: DnsQuery;
  /** The clock of the panel snapshots (their time, the job's interval, the retention by day), so that tests need not wait. */
  readonly snapshotClock?: () => number;
  /** The clock of the baseline checks' schedule (when a run is queued, when a server is due), so that tests need not wait. */
  readonly checksClock?: () => number;
  /** The steps and workflows of the run engine (empty in production until the workflows are decided) and its tuning. */
  readonly engine?: EngineOptions;
}

function checksFrom(config: AppConfig, database: Database | undefined): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  if (database) {
    checks.push(new DatabaseCheck(database));
  }
  if (config.valkeyUrl) {
    checks.push(new ValkeyCheck(config.valkeyUrl));
  }
  return checks;
}

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
    @Inject(DATABASE) private readonly database: Database | undefined,
  ) {}

  static register(config: AppConfig, options: AppOptions = {}): DynamicModule {
    // The pool is created lazily by the client, so building it here does not connect.
    const database =
      options.database ??
      (config.databaseUrl ? new Database({ url: config.databaseUrl }) : undefined);
    return {
      module: AppModule,
      controllers: [
        SystemController,
        SetupController,
        AuthController,
        TokensController,
        SessionsController,
        RolesController,
        AuditController,
        UsersController,
        VaultController,
        PluginsController,
        ServersController,
        CommandsController,
        ArtifactsController,
        PanelController,
        ChecksController,
        PanelSnapshotsController,
        BaselineController,
        PanelConsoleController,
        DashboardController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DATABASE, useValue: database },
        {
          provide: READINESS_CHECKS,
          useValue: options.readinessChecks ?? checksFrom(config, database),
        },
        ReadinessService,
        { provide: CLOCK, useValue: options.clock ?? (() => Date.now()) },
        UpdatesService,
        {
          provide: PASSWORD_HASHER,
          useValue: new PasswordHasher(options.passwordParams ?? DEFAULT_PASSWORD_PARAMS),
        },
        { provide: SECRET_BOX, useValue: new SecretBox(config.authKey) },
        SessionService,
        TokenService,
        SessionManagementService,
        AuditService,
        AuthService,
        SetupService,
        InvitationService,
        UsersService,
        ServersService,
        SshService,
        ServerSshService,
        ScriptsService,
        CommandRunner,
        CommandRunsService,
        CatalogueService,
        DistributionService,
        PanelClients,
        PanelCache,
        PanelService,
        PanelReaderService,
        PanelConsoleService,
        PanelMonitorService,
        ChecksMemory,
        ConventionPackService,
        InventoryReader,
        ChecksService,
        {
          provide: DNS_QUERY,
          useValue:
            options.dnsQuery ?? nodeDnsQuery(config.checks.dnsServers, config.checks.dnsTimeoutMs),
        },
        { provide: SNAPSHOT_CLOCK, useValue: options.snapshotClock ?? (() => Date.now()) },
        PanelSnapshotsService,
        PanelSnapshotScheduler,
        { provide: CHECKS_CLOCK, useValue: options.checksClock ?? (() => Date.now()) },
        BaselinesService,
        CheckRunner,
        CheckRunsService,
        CheckScheduler,
        DashboardService,
        {
          provide: RUN_STORE,
          useValue: database ? new PrismaRunStore(database.client) : undefined,
        },
        {
          provide: ENGINE_CATALOGUE,
          useValue: {
            steps: options.engine?.steps ?? new StepRegistry<EnginePorts>(),
            workflows: options.engine?.workflows ?? new WorkflowRegistry<EnginePorts>(),
          },
        },
        {
          provide: ENGINE_PORTS,
          useFactory: (vault: VaultService): EnginePorts => enginePorts(vault),
          inject: [VaultService],
        },
        { provide: ENGINE_TUNING, useValue: options.engine?.tuning ?? {} },
        EngineRunner,
        EngineRunsService,
        PluginRuntime,
        PluginBroker,
        PluginsService,
        PluginHostService,
        { provide: PLUGIN_NETWORK, useValue: options.pluginNetwork ?? new PluginNetwork() },
        { provide: VAULT_KDF, useValue: options.vaultKdf ?? config.vaultKdf },
        VaultService,
        // Guards run in this order: the origin check, the session, the role's permission, the step-up.
        { provide: APP_GUARD, useClass: OriginGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_GUARD, useClass: StepUpGuard },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.readiness.close();
    await this.database?.close();
  }
}
