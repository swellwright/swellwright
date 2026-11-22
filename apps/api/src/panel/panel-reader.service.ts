import { Inject, Injectable } from '@nestjs/common';
import type {
  PanelApiTokenView,
  PanelConfigProfileSummary,
  PanelConfigProfileView,
  PanelExternalSquadView,
  PanelHostView,
  PanelInfraView,
  PanelInternalSquadView,
  PanelNodePluginView,
  PanelNodeView,
  PanelOverview,
  PanelSnippetView,
  PanelSubscriptionSettingsView,
  PanelSubscriptionTemplateView,
} from '@swellwright/contracts';
import {
  type PanelHealth,
  PanelError,
  type PanelReader,
  type PanelSystemVersion,
  type PanelUserCounts,
} from '@swellwright/remnawave';

import { WindowLimiter } from '../auth/rate-limit.js';
import { type AppConfig } from '../config.js';
import { CodedHttpException, RateLimitedException } from '../http.js';
import { CONFIG } from '../tokens.js';
import { type Actor, VaultService } from '../vault/vault.service.js';
import { PanelClients } from './clients.js';
import { type ConnectionRow, tokenInfo, viewOf, warningsOf } from './connection-view.js';
import { PanelCache } from './panel-cache.js';
import { panelException } from './panel-errors.js';
import { PanelService } from './panel.service.js';

/** What a read answers with: the objects, when they were read, and whether this server's memory had them. */
export interface Read<T> {
  readonly value: T;
  readonly fetchedAt: string;
  readonly cached: boolean;
}

interface Options {
  /** Ask the panel again instead of answering from memory. Counts against the refresh limit of the user. */
  readonly refresh?: boolean;
  /** The limit was counted already by the caller (the overview reads many kinds for one refresh). */
  readonly counted?: boolean;
  /** Kept in memory (the default), or read every time. */
  readonly cache?: boolean;
  /** A 404 from the panel means that there is no such object of this kind. */
  readonly notFoundIsObject?: string;
}

/**
 * The reads of the panel (ADR 0041): from the short memory of this server when it has the answer, from the panel
 * when not or when asked, with one request in flight per kind however many callers want it, and a limit on how often
 * a person may force a new read. The token is taken from the vault for one request and dropped. Failures come out as
 * the API errors of `panel-errors.ts`, and the ones that say the panel is down or refuses us update the state of the
 * connection.
 */
@Injectable()
export class PanelReaderService {
  private readonly refreshLimiter: WindowLimiter;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PanelService) private readonly panel: PanelService,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(PanelClients) private readonly clients: PanelClients,
    @Inject(PanelCache) private readonly cache: PanelCache,
  ) {
    this.refreshLimiter = new WindowLimiter(config.panel.refreshRateLimitPerMinute, 60_000);
  }

  private limitRefresh(actor: Actor): void {
    if (!this.refreshLimiter.hit(actor.id)) {
      throw new RateLimitedException(
        60,
        'Too many forced reads of the panel. Try again in a minute, or read without refresh.',
      );
    }
  }

  private async usable(): Promise<ConnectionRow> {
    const row = await this.panel.requireRow();
    if (row.state === 'unsupported') {
      throw new CodedHttpException(
        409,
        'panel_unsupported_version',
        row.lastErrorMessage ?? 'The panel runs a version this release does not support.',
        { version: row.panelVersion },
      );
    }
    return row;
  }

  private async load<T>(
    key: string,
    actor: Actor,
    loader: (client: PanelReader) => Promise<T>,
    options: Options = {},
  ): Promise<Read<T>> {
    const row = await this.usable();
    this.cache.forConnection(row.id);
    const ttl = options.cache === false ? 0 : this.config.panel.cacheTtlMs;
    if (options.refresh === true) {
      if (options.counted !== true) {
        this.limitRefresh(actor);
      }
    } else {
      const hit = this.cache.fresh(key, ttl, Date.now());
      if (hit) {
        return {
          value: hit.value as T,
          fetchedAt: new Date(hit.fetchedAt).toISOString(),
          cached: true,
        };
      }
    }
    const fetched = await this.cache.joinOrStart(row.id, key, () =>
      this.fetch(row, key, loader, options),
    );
    return { value: fetched.value, fetchedAt: new Date(fetched.at).toISOString(), cached: false };
  }

  private async fetch<T>(
    row: ConnectionRow,
    key: string,
    loader: (client: PanelReader) => Promise<T>,
    options: Options,
  ): Promise<{ value: T; at: number }> {
    const token = await this.vault.readForPanel(row.tokenSecretId);
    const client = this.clients.create({ baseUrl: row.baseUrl, trustedCa: row.trustedCa }, token);
    let value: T;
    try {
      value = await loader(client);
    } catch (error) {
      if (error instanceof PanelError) {
        await this.panel.noteReadFailure(row, error);
        throw panelException(
          error,
          options.notFoundIsObject === undefined
            ? {}
            : { notFoundIsObject: options.notFoundIsObject },
        );
      }
      throw error;
    } finally {
      client.close();
    }
    const at = Date.now();
    if (options.cache !== false) {
      this.cache.put(row.id, key, value, at);
    }
    await this.panel.noteReadSuccess(row);
    return { value, at };
  }

  // ---- the kinds ---------------------------------------------------------------------------------------------------

  nodes(actor: Actor, refresh: boolean): Promise<Read<PanelNodeView[]>> {
    return this.load('nodes', actor, (c) => c.nodes(), { refresh });
  }

  hosts(actor: Actor, refresh: boolean): Promise<Read<PanelHostView[]>> {
    return this.load('hosts', actor, (c) => c.hosts(), { refresh });
  }

  configProfiles(actor: Actor, refresh: boolean): Promise<Read<PanelConfigProfileSummary[]>> {
    return this.load('configProfiles', actor, (c) => c.configProfiles(), { refresh });
  }

  configProfile(
    actor: Actor,
    uuid: string,
    refresh: boolean,
  ): Promise<Read<PanelConfigProfileView>> {
    return this.load(`configProfile:${uuid}`, actor, (c) => c.configProfile(uuid), {
      refresh,
      notFoundIsObject: 'config profile',
    });
  }

  /** Not kept in memory: it is read when it is asked for, and counts as a forced read. */
  computedConfig(actor: Actor, uuid: string): Promise<Read<PanelConfigProfileView>> {
    return this.load(`computedConfig:${uuid}`, actor, (c) => c.computedConfig(uuid), {
      refresh: true,
      cache: false,
      notFoundIsObject: 'config profile',
    });
  }

  internalSquads(actor: Actor, refresh: boolean): Promise<Read<PanelInternalSquadView[]>> {
    return this.load('internalSquads', actor, (c) => c.internalSquads(), { refresh });
  }

  externalSquads(actor: Actor, refresh: boolean): Promise<Read<PanelExternalSquadView[]>> {
    return this.load('externalSquads', actor, (c) => c.externalSquads(), { refresh });
  }

  subscriptionTemplates(
    actor: Actor,
    refresh: boolean,
  ): Promise<Read<PanelSubscriptionTemplateView[]>> {
    return this.load('subscriptionTemplates', actor, (c) => c.subscriptionTemplates(), { refresh });
  }

  subscriptionSettings(
    actor: Actor,
    refresh: boolean,
  ): Promise<Read<PanelSubscriptionSettingsView>> {
    return this.load('subscriptionSettings', actor, (c) => c.subscriptionSettings(), { refresh });
  }

  snippets(actor: Actor, refresh: boolean): Promise<Read<PanelSnippetView[]>> {
    return this.load('snippets', actor, (c) => c.snippets(), { refresh });
  }

  nodePlugins(actor: Actor, refresh: boolean): Promise<Read<PanelNodePluginView[]>> {
    return this.load('nodePlugins', actor, (c) => c.nodePlugins(), { refresh });
  }

  infra(actor: Actor, refresh: boolean): Promise<Read<PanelInfraView>> {
    return this.load('infra', actor, (c) => c.infra(), { refresh });
  }

  apiTokens(actor: Actor, refresh: boolean): Promise<Read<PanelApiTokenView[]>> {
    return this.load('apiTokens', actor, (c) => c.apiTokens(), { refresh });
  }

  // ---- the overview ------------------------------------------------------------------------------------------------

  /**
   * Version, health, counts. A count the token may not read is null; a panel that does not answer, refuses the
   * token or asks to slow down fails the whole overview, since nothing in it can be known then.
   */
  async overview(actor: Actor, refresh: boolean): Promise<PanelOverview> {
    const row = await this.usable();
    if (refresh) {
      this.limitRefresh(actor);
    }
    const options: Options = { refresh, counted: true };
    const settled = await Promise.allSettled([
      this.load<PanelSystemVersion>('version', actor, (c) => c.version(), options),
      this.load<PanelHealth>('health', actor, (c) => c.health(), options),
      this.load<PanelUserCounts>('userCounts', actor, (c) => c.userCounts(), options),
      this.load('nodes', actor, (c) => c.nodes(), options),
      this.load('hosts', actor, (c) => c.hosts(), options),
      this.load('configProfiles', actor, (c) => c.configProfiles(), options),
      this.load('internalSquads', actor, (c) => c.internalSquads(), options),
      this.load('externalSquads', actor, (c) => c.externalSquads(), options),
      this.load('subscriptionTemplates', actor, (c) => c.subscriptionTemplates(), options),
      this.load('snippets', actor, (c) => c.snippets(), options),
      this.load('nodePlugins', actor, (c) => c.nodePlugins(), options),
    ]);
    // What a missing scope or a changed shape of one resource costs is that resource; anything else is the panel.
    for (const outcome of settled) {
      if (outcome.status === 'rejected' && !isPartial(outcome.reason)) {
        throw outcome.reason;
      }
    }
    const value = (index: number): unknown => {
      const outcome = settled[index];
      return outcome?.status === 'fulfilled' ? (outcome.value as Read<unknown>).value : null;
    };
    const version = value(0) as PanelSystemVersion | null;
    const health = value(1) as PanelHealth | null;
    const users = value(2) as PanelUserCounts | null;
    const nodes = value(3) as PanelNodeView[] | null;
    const count = (index: number): number | null => {
      const items = value(index) as unknown[] | null;
      return items === null ? null : items.length;
    };
    const connection = viewOf(row, new Date());
    const token = tokenInfo(row, new Date());
    const fetchedAt = new Date().toISOString();
    return {
      connection: {
        state: connection.state,
        baseUrl: row.baseUrl,
        panelVersion: version?.version ?? row.panelVersion,
        versionSupport: connection.versionSupport,
      },
      system:
        version === null
          ? null
          : {
              version: version.version,
              build: { time: version.buildTime, number: version.buildNumber },
              health: health === null ? 'unknown' : 'ok',
              instances: health?.instances ?? 0,
              uptimeSeconds: health?.uptimeSeconds ?? null,
            },
      counts: {
        nodes: count(3),
        hosts: count(4),
        configProfiles: count(5),
        internalSquads: count(6),
        externalSquads: count(7),
        subscriptionTemplates: count(8),
        snippets: count(9),
        nodePlugins: count(10),
      },
      nodes:
        nodes === null
          ? null
          : {
              online: nodes.filter((n) => n.state === 'online').length,
              connecting: nodes.filter((n) => n.state === 'connecting').length,
              offline: nodes.filter((n) => n.state === 'offline').length,
              disabled: nodes.filter((n) => n.state === 'disabled').length,
            },
      users:
        users === null
          ? null
          : { total: users.total, byStatus: { ...users.byStatus }, onlineNow: users.onlineNow },
      token,
      warnings: warningsOf(row, connection.capabilities, token),
      fetchedAt,
    };
  }
}

/** The failures that only take one count out of the overview. */
function isPartial(error: unknown): boolean {
  return (
    error instanceof CodedHttpException &&
    (error.apiCode === 'panel_forbidden' || error.apiCode === 'panel_contract_changed')
  );
}
