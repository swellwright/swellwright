import { Inject, Injectable } from '@nestjs/common';
import type {
  ConventionLastRun,
  ConventionRuleCatalog,
  ConventionRun,
  ImpactKind,
  ImpactReport,
  ImpactRequest,
  PanelResource,
  ReconciliationReport,
} from '@swellwright/contracts';
import {
  calculateImpact,
  describeRules,
  DnsLookup,
  type DnsQuery,
  ImpactError,
  type InventoryServer,
  lint,
  namesToResolve,
  reconcile,
} from '@swellwright/conventions';
import { validateTargetAddress } from '@swellwright/ssh';

import { type AuthContext } from '../auth/context.js';
import { can } from '../auth/guards.js';
import { WindowLimiter } from '../auth/rate-limit.js';
import { type AppConfig } from '../config.js';
import { CodedHttpException, RateLimitedException } from '../http.js';
import { PanelReaderService } from '../panel/panel-reader.service.js';
import { PanelService } from '../panel/panel.service.js';
import { CONFIG, DNS_QUERY } from '../tokens.js';
import type { Actor } from '../vault/vault.service.js';
import { InventoryReader } from './inventory.js';
import { ChecksMemory } from './memory.js';
import { ConventionPackService } from './pack.service.js';
import { toModel } from './panel-model.js';

/** The kind of object a change is for, and the kind of read it needs. */
const NEEDS: Record<ImpactKind, readonly PanelResource[]> = {
  configProfile: ['configProfiles', 'nodes'],
  internalSquad: ['internalSquads', 'configProfiles', 'nodes'],
  host: ['hosts'],
  node: ['nodes', 'configProfiles'],
  subscriptionTemplate: ['subscriptionTemplates'],
};

/**
 * The checks of the panel (ADR 0044): the convention linter, the reconciliation and the impact calculator. Each reads
 * what the panel reported through the memory of this server (the same reads as the pages of the console), runs a pure
 * function of the package `@swellwright/conventions`, and answers. Nothing here writes to the panel, and nothing is
 * sent to it but the reads of the client, which can only read. The convention pack decides what runs and with what.
 */
@Injectable()
export class ChecksService {
  private readonly reconcileLimiter: WindowLimiter;
  private readonly dns: DnsLookup;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(PanelReaderService) private readonly reader: PanelReaderService,
    @Inject(PanelService) private readonly panel: PanelService,
    @Inject(ConventionPackService) private readonly packs: ConventionPackService,
    @Inject(InventoryReader) private readonly inventory: InventoryReader,
    @Inject(ChecksMemory) private readonly memory: ChecksMemory,
    @Inject(DNS_QUERY) query: DnsQuery,
  ) {
    this.reconcileLimiter = new WindowLimiter(config.checks.rateLimitPerMinute, 60_000);
    // An address that a name resolves to is judged by the policy for servers: loopback, link-local and metadata
    // addresses are refused (they are never what a node is), and private ranges follow the setting for servers.
    const policy = { ...config.ssh.policy, allowHostnames: true };
    this.dns = new DnsLookup({
      query,
      allow: (address) => validateTargetAddress(address, policy).allowed,
      timeoutMs: config.checks.dnsTimeoutMs,
      concurrency: config.checks.dnsConcurrency,
      cacheMs: config.checks.dnsCacheMs,
      maxNames: config.checks.dnsMaxNames,
    });
  }

  // ---- the rules and the last run ---------------------------------------------------------------------------------

  async rules(): Promise<ConventionRuleCatalog> {
    return describeRules(await this.packs.active());
  }

  async last(): Promise<ConventionLastRun> {
    const row = await this.panel.row();
    const last = this.memory.last(row?.id ?? null);
    return last === null
      ? { ranAt: null, pack: null, summary: null }
      : { ranAt: last.ranAt, pack: last.pack, summary: last.summary };
  }

  // ---- the convention linter --------------------------------------------------------------------------------------

  async runConventions(actor: Actor, refresh: boolean): Promise<ConventionRun> {
    const read = await this.reader.readForChecks(actor, refresh);
    const pack = await this.packs.active();
    const model = toModel(read);
    const result = lint(model, pack);
    const ranAt = new Date().toISOString();
    this.memory.remember({
      connectionId: read.connectionId,
      ranAt,
      pack: pack.ref,
      summary: result.summary,
    });
    return {
      pack: pack.ref,
      ranAt,
      fetchedAt: read.fetchedAt,
      cached: read.cached,
      summary: result.summary,
      findings: result.findings,
      truncated: result.truncated,
      skipped: result.skipped,
      failed: result.failed,
      checked: {
        nodes: model.nodes.length,
        hosts: model.hosts.length,
        configProfiles: model.profiles.length,
        internalSquads: model.internalSquads.length,
        externalSquads: model.externalSquads.length,
        subscriptionTemplates: model.templates.length,
      },
    };
  }

  // ---- reconciliation ---------------------------------------------------------------------------------------------

  async reconcile(
    actor: Actor,
    auth: AuthContext,
    refresh: boolean,
  ): Promise<ReconciliationReport> {
    if (!this.reconcileLimiter.hit(actor.id)) {
      throw new RateLimitedException(60, 'Too many reconciliations. Try again in a minute.');
    }
    const read = await this.reader.readForChecks(actor, refresh);
    const missing = (['nodes', 'hosts'] as const).filter((kind) => read.unavailable.includes(kind));
    if (missing.length > 0) {
      throw new CodedHttpException(
        502,
        'panel_forbidden',
        `The token cannot read ${missing.join(' and ')}, which the reconciliation compares.`,
        { resources: missing },
      );
    }
    const pack = await this.packs.active();
    const model = toModel(read);
    // The inventory is compared only for someone who may read it: a role that sees the panel does not see the servers.
    const canSeeServers = can(auth, 'servers:read');
    const inventory: InventoryServer[] | null = canSeeServers ? await this.inventory.list() : null;
    if (refresh) {
      this.dns.forget();
    }
    const names = namesToResolve(model, pack, inventory);
    const looked = pack.reconciliation.dnsEnabled
      ? await this.dns.lookup(names)
      : {
          answers: new Map(),
          stats: {
            names: 0,
            resolved: 0,
            failed: 0,
            skipped: 0,
            capped: false,
            cached: 0,
            durationMs: 0,
          },
        };
    const result = reconcile({
      model,
      pack,
      dns: looked.answers,
      dnsSkipped: new Set(names.filter((name) => !looked.answers.has(name))),
      inventory,
    });
    const { reconciliation: settings } = pack;
    return {
      pack: pack.ref,
      ranAt: new Date().toISOString(),
      fetchedAt: read.fetchedAt,
      summary: result.summary,
      rows: result.rows,
      truncated: result.truncated,
      dns: {
        enabled: settings.dnsEnabled,
        names: looked.stats.names,
        resolved: looked.stats.resolved,
        failed: looked.stats.failed,
        skipped: looked.stats.skipped,
        capped: looked.stats.capped,
        cached: looked.stats.cached,
        durationMs: looked.stats.durationMs,
      },
      inventory: {
        available: inventory !== null,
        reason: inventory === null ? 'no_permission' : null,
        servers: inventory?.length ?? 0,
      },
      settings: {
        hostAddress: settings.hostAddress,
        hostSni: settings.hostSni,
        hostPort: settings.hostPort,
        dnsEnabled: settings.dnsEnabled,
        maxTtlSeconds: settings.maxTtlSeconds,
        matchBy: [...settings.matchBy],
      },
    };
  }

  // ---- the impact calculator --------------------------------------------------------------------------------------

  async impact(actor: Actor, request: ImpactRequest): Promise<ImpactReport> {
    const read = await this.reader.readForChecks(actor, false);
    const missing = NEEDS[request.kind].filter((kind) => read.unavailable.includes(kind));
    if (missing.length > 0) {
      throw new CodedHttpException(
        502,
        'panel_forbidden',
        `The token cannot read ${missing.join(' and ')}, which this calculation needs.`,
        { resources: missing },
      );
    }
    const pack = await this.packs.active();
    try {
      return calculateImpact({
        model: toModel(read),
        pack,
        kind: request.kind,
        uuid: request.uuid,
        change: request.change,
      });
    } catch (error) {
      if (error instanceof ImpactError) {
        throw error.code === 'not_found'
          ? new CodedHttpException(404, 'not_found', error.message)
          : new CodedHttpException(400, 'validation_failed', error.message);
      }
      throw error;
    }
  }
}
