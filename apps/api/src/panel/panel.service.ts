import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type ConnectPanelRequest,
  type ConnectPanelWithTokenRequest,
  type PanelConnectionView,
  type PanelTestResult,
} from '@swellwright/contracts';
import { type Database, Prisma } from '@swellwright/db';
import {
  PanelAuthError,
  PanelError,
  PanelTimeoutError,
  PanelUnavailableError,
  type PanelProbe,
  probePanel,
} from '@swellwright/remnawave';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { WindowLimiter } from '../auth/rate-limit.js';
import { type AppConfig } from '../config.js';
import { CodedHttpException, RateLimitedException } from '../http.js';
import { CONFIG, DATABASE } from '../tokens.js';
import { type Actor, VaultService } from '../vault/vault.service.js';
import { PanelClients } from './clients.js';
import {
  type Assessment,
  assessProbe,
  capabilitiesOf,
  type ConnectionRow,
  type StoredState,
  viewOf,
} from './connection-view.js';
import { PanelCache } from './panel-cache.js';
import { lastErrorOf, panelException } from './panel-errors.js';
import { tokenExpiry } from './token-expiry.js';

/** An arbitrary constant: one transaction at a time may replace or remove the connection. */
const PANEL_LOCK_KEY = 7_761_244;

const WITH_SECRET = {
  tokenSecret: { select: { id: true, name: true } },
} satisfies Prisma.PanelConnectionInclude;

/** A PEM block of a certificate, as the one thing a trusted authority may be given as. */
const CERTIFICATE_PEM = /^-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----$/u;

/** The seam for the background check: no person, no request. */
const BACKGROUND_META: Pick<RequestMeta, 'ip' | 'requestId'> = {
  ip: undefined,
  requestId: undefined,
};

/**
 * The connection to a Remnawave panel (ADR 0041): connecting with a token that is in the vault or one that is not yet,
 * testing it, removing it, and keeping the state current. The panel is asked first and nothing is stored when it
 * refuses. The token is read from the vault for one piece of work, never returned, never logged, never cached. Every
 * change is recorded in the audit chain in the same transaction.
 */
@Injectable()
export class PanelService {
  private readonly logger = new Logger('Panel');
  private readonly testLimiter: WindowLimiter;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(PanelClients) private readonly clients: PanelClients,
    @Inject(PanelCache) private readonly cache: PanelCache,
  ) {
    this.testLimiter = new WindowLimiter(config.panel.testRateLimitPerMinute, 60_000);
  }

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  private limit(actor: Actor): void {
    if (!this.testLimiter.hit(actor.id)) {
      throw new RateLimitedException(60, 'Too many connection attempts. Try again in a minute.');
    }
  }

  // ---- reading the connection -------------------------------------------------------------------------------------

  async row(): Promise<ConnectionRow | null> {
    const row = await this.db.panelConnection.findFirst({
      orderBy: { createdAt: 'desc' },
      include: WITH_SECRET,
    });
    return row;
  }

  /** The connection, or the answer "nothing is connected" (409). */
  async requireRow(): Promise<ConnectionRow> {
    const row = await this.row();
    if (!row) {
      throw new CodedHttpException(
        409,
        'panel_not_connected',
        'No Remnawave panel is connected. Connect one first.',
      );
    }
    return row;
  }

  async get(): Promise<PanelConnectionView> {
    return viewOf(await this.row(), new Date());
  }

  // ---- connecting --------------------------------------------------------------------------------------------------

  private checkCa(value: string | null | undefined): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const text = value.trim();
    if (!CERTIFICATE_PEM.test(text)) {
      throw new CodedHttpException(
        400,
        'bad_request',
        'The certificate authority must be PEM text of a certificate (-----BEGIN CERTIFICATE-----).',
      );
    }
    return text;
  }

  /** Asks the panel with a token. The client lives for this call only. */
  private async ask(baseUrl: string, token: string, trustedCa: string | null): Promise<PanelProbe> {
    const client = this.clients.create({ baseUrl, trustedCa }, token);
    try {
      return await probePanel(client);
    } finally {
      client.close();
    }
  }

  /** The error a failed probe is reported as; the caller decides whether it is thrown or kept. */
  private failureOf(probe: PanelProbe): Error {
    const error = probe.fatal;
    if (!error) {
      throw new Error('A probe without a fatal error has no failure.');
    }
    return panelException(error);
  }

  private async recordRefusal(
    actor: Actor | null,
    baseUrl: string,
    probe: PanelProbe,
    meta: RequestMeta,
  ): Promise<void> {
    const error = probe.fatal;
    await this.audit.note({
      action: 'panel.connected',
      outcome: 'failure',
      actor,
      object: { type: 'panel', id: 'connection' },
      details: {
        base_url: baseUrl.slice(0, 200),
        error_code: error?.code ?? null,
        panel_version: probe.version?.version.slice(0, 64) ?? null,
      },
      meta,
    });
  }

  /** Connects with a token that is in the vault already. */
  async connect(
    actor: Actor,
    request: ConnectPanelRequest,
    meta: RequestMeta,
  ): Promise<PanelConnectionView> {
    this.limit(actor);
    const baseUrl = this.clients.check(request.baseUrl);
    const trustedCa = this.checkCa(request.trustedCa);
    const secret = await this.db.secret.findUnique({
      where: { id: request.tokenSecretId },
      select: { id: true, type: true, name: true },
    });
    if (!secret) {
      throw new NotFoundException('There is no such secret.');
    }
    if (secret.type !== 'panel_token') {
      throw new ConflictException(
        `The secret "${secret.name}" is not of the kind "panel_token". Choose a secret that holds the API token of the panel.`,
      );
    }
    const token = await this.vault.readForPanel(secret.id);
    const probe = await this.ask(baseUrl, token, trustedCa);
    if (probe.fatal) {
      await this.recordRefusal(actor, baseUrl, probe, meta);
      throw this.failureOf(probe);
    }
    const row = await this.db.$transaction(async (tx) =>
      this.replace(tx, actor, meta, { baseUrl, trustedCa, secretId: secret.id, token, probe }),
    );
    this.afterConnect(row, probe);
    return viewOf(row, new Date());
  }

  /**
   * Connects with a token that is not in the vault yet. The panel is asked with it first; only when it answers is the
   * token sealed into the vault and the connection saved, in one transaction.
   */
  async connectWithToken(
    actor: Actor,
    request: ConnectPanelWithTokenRequest,
    meta: RequestMeta,
  ): Promise<PanelConnectionView> {
    this.limit(actor);
    const baseUrl = this.clients.check(request.baseUrl);
    const trustedCa = this.checkCa(request.trustedCa);
    // Better a 423 now than a token that was tried and cannot be kept.
    this.vault.requireOpen();
    const probe = await this.ask(baseUrl, request.token, trustedCa);
    if (probe.fatal) {
      await this.recordRefusal(actor, baseUrl, probe, meta);
      throw this.failureOf(probe);
    }
    const saved: { row?: ConnectionRow } = {};
    await this.vault.createWithin(
      actor,
      { name: request.secretName, type: 'panel_token', value: request.token },
      meta,
      async (tx, secret) => {
        saved.row = await this.replace(tx, actor, meta, {
          baseUrl,
          trustedCa,
          secretId: secret.id,
          token: request.token,
          probe,
        });
      },
    );
    if (!saved.row) {
      throw new Error('The connection was not saved.');
    }
    this.afterConnect(saved.row, probe);
    return viewOf(saved.row, new Date());
  }

  /** Replaces the one connection (inside the transaction the caller has) and records it. */
  private async replace(
    tx: Prisma.TransactionClient,
    actor: Actor,
    meta: RequestMeta,
    input: {
      baseUrl: string;
      trustedCa: string | null;
      secretId: string;
      token: string;
      probe: PanelProbe;
    },
  ): Promise<ConnectionRow> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PANEL_LOCK_KEY})`;
    const now = new Date();
    const assessment = assessProbe(input.probe);
    const capabilities = capabilitiesOf(input.probe, now);
    const previous = await tx.panelConnection.deleteMany();
    const row = await tx.panelConnection.create({
      data: {
        baseUrl: input.baseUrl,
        tokenSecretId: input.secretId,
        state: assessment.state,
        panelVersion: input.probe.version?.version.slice(0, 64) ?? null,
        capabilities:
          capabilities === null ? Prisma.JsonNull : (capabilities as Prisma.InputJsonValue),
        trustedCa: input.trustedCa,
        tokenExpiresAt: tokenExpiry(input.token),
        lastCheckedAt: now,
        lastErrorCode: assessment.lastError?.code ?? null,
        lastErrorMessage: assessment.lastError?.message ?? null,
        createdById: actor.id,
      },
      include: WITH_SECRET,
    });
    await this.audit.record(
      {
        action: 'panel.connected',
        outcome: 'success',
        actor,
        object: { type: 'panel', id: row.id },
        details: {
          base_url: input.baseUrl.slice(0, 200),
          panel_version: row.panelVersion,
          state: row.state,
          secret_id: input.secretId,
          replaced: previous.count > 0,
          own_ca: input.trustedCa !== null,
        },
        meta,
      },
      tx,
    );
    return row;
  }

  /** What is kept from the first probe, so that the pages that open next do not ask the panel again. */
  private afterConnect(row: ConnectionRow, probe: PanelProbe): void {
    this.cache.reset();
    this.cache.forConnection(row.id);
    this.seed(row.id, probe);
  }

  private seed(connectionId: string, probe: PanelProbe): void {
    const at = Date.now();
    const { data, system, version } = probe;
    this.cache.forConnection(connectionId);
    const put = (key: string, value: unknown): void => {
      if (value !== undefined && value !== null) {
        this.cache.put(connectionId, key, value, at);
      }
    };
    for (const [key, value] of Object.entries(data)) {
      put(key, value);
    }
    put('health', system.health);
    put('userCounts', system.userCounts);
    put('version', version);
  }

  // ---- testing and the background check ----------------------------------------------------------------------------

  /** Asks the panel again and keeps what it says as the state of the connection. A panel that does not answer is a result. */
  async test(actor: Actor, meta: RequestMeta): Promise<PanelTestResult> {
    this.limit(actor);
    const row = await this.requireRow();
    const token = await this.vault.readForPanel(row.tokenSecretId);
    const probe = await this.ask(row.baseUrl, token, row.trustedCa);
    const assessment = assessProbe(probe);
    const updated = await this.save(row, probe, assessment, {
      audit: { actor, meta, kind: 'tested' },
    });
    if (!probe.fatal) {
      this.seed(updated.id, probe);
    }
    return {
      ok: assessment.state === 'connected' || assessment.state === 'degraded',
      connection: viewOf(updated, new Date()),
      latencyMs: Math.round(probe.latencyMs),
    };
  }

  /**
   * One round of the background check: the same probe as a test, and a note in the audit chain only when the state
   * changed. Does nothing when no panel is connected or the vault is sealed (the token cannot be read). Never throws.
   */
  async check(): Promise<void> {
    try {
      const row = await this.row();
      if (!row) {
        return;
      }
      let token: string;
      try {
        token = await this.vault.readForPanel(row.tokenSecretId);
      } catch {
        // Sealed vault or a token that is gone: nothing to check with, and nothing to say about the panel.
        return;
      }
      const probe = await this.ask(row.baseUrl, token, row.trustedCa);
      const assessment = assessProbe(probe);
      const updated = await this.save(row, probe, assessment, { audit: null });
      if (!probe.fatal) {
        this.seed(updated.id, probe);
      }
      if (assessment.state !== row.state) {
        await this.noteStateChange(
          row.id,
          row.state,
          assessment.state,
          assessment.lastError?.code ?? null,
        );
      }
    } catch (error) {
      this.logger.warn(
        `the check of the panel failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async noteStateChange(
    id: string,
    from: StoredState,
    to: StoredState,
    errorCode: string | null,
  ): Promise<void> {
    // A line in the log too: a person watching the log learns that the panel went away or came back.
    this.logger.log(
      `the connection to the panel changed state: ${from} to ${to}${errorCode === null ? '' : ` (${errorCode})`}`,
    );
    await this.audit.note({
      action: 'panel.state.changed',
      outcome: 'success',
      actor: null,
      object: { type: 'panel', id },
      details: { from, to, error_code: errorCode },
      meta: BACKGROUND_META,
    });
  }

  /** Writes what a probe found onto the connection (and a `panel.tested` record when a person asked). */
  private async save(
    row: ConnectionRow,
    probe: PanelProbe,
    assessment: Assessment,
    options: { audit: { actor: Actor; meta: RequestMeta; kind: 'tested' } | null },
  ): Promise<ConnectionRow> {
    const now = new Date();
    const capabilities = capabilitiesOf(probe, now);
    const write = async (tx: Prisma.TransactionClient): Promise<ConnectionRow> => {
      const updated = await tx.panelConnection.update({
        where: { id: row.id },
        data: {
          state: assessment.state,
          // A probe that could not ask (the panel is down) keeps what was known before.
          ...(probe.version === null ? {} : { panelVersion: probe.version.version.slice(0, 64) }),
          ...(capabilities === null ? {} : { capabilities }),
          lastCheckedAt: now,
          lastErrorCode: assessment.lastError?.code ?? null,
          lastErrorMessage: assessment.lastError?.message ?? null,
        },
        include: WITH_SECRET,
      });
      if (options.audit) {
        await this.audit.record(
          {
            action: 'panel.tested',
            outcome:
              assessment.state === 'connected' || assessment.state === 'degraded'
                ? 'success'
                : 'failure',
            actor: options.audit.actor,
            object: { type: 'panel', id: row.id },
            details: {
              state: assessment.state,
              panel_version: updated.panelVersion,
              error_code: assessment.lastError?.code ?? null,
              latency_ms: Math.round(probe.latencyMs),
            },
            meta: options.audit.meta,
          },
          tx,
        );
      }
      return updated;
    };
    try {
      return await this.db.$transaction(write);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        // Disconnected or replaced while the panel was being asked.
        throw new CodedHttpException(
          409,
          'panel_not_connected',
          'The connection changed meanwhile.',
        );
      }
      throw error;
    }
  }

  // ---- what reads tell about the connection ------------------------------------------------------------------------

  /** A read failed in a way that says something about the connection as a whole: the state follows. */
  async noteReadFailure(row: ConnectionRow, error: unknown): Promise<void> {
    let to: StoredState | null = null;
    if (error instanceof PanelAuthError) {
      to = 'unauthorized';
    } else if (error instanceof PanelUnavailableError || error instanceof PanelTimeoutError) {
      to = 'unreachable';
    }
    if (to === null || to === row.state || !(error instanceof PanelError)) {
      return;
    }
    await this.setState(row, to, lastErrorOf(error));
  }

  /** A read worked after the connection was reported as down: it is usable again, as far as the last probe knew. */
  async noteReadSuccess(row: ConnectionRow): Promise<void> {
    if (row.state !== 'unreachable' && row.state !== 'unauthorized') {
      return;
    }
    const capabilities = viewOf(row, new Date()).capabilities;
    const limited =
      capabilities !== null &&
      Object.entries(capabilities.resources).some(
        ([resource, state]) => resource !== 'apiTokens' && state !== 'ok',
      );
    await this.setState(row, limited ? 'degraded' : 'connected', null);
  }

  private async setState(
    row: ConnectionRow,
    to: StoredState,
    lastError: { code: string; message: string } | null,
  ): Promise<void> {
    const changed = await this.db.panelConnection.updateMany({
      where: { id: row.id, state: row.state },
      data: {
        state: to,
        lastCheckedAt: new Date(),
        lastErrorCode: lastError?.code ?? null,
        lastErrorMessage: lastError?.message ?? null,
      },
    });
    if (changed.count === 1) {
      await this.noteStateChange(row.id, row.state, to, lastError?.code ?? null);
    }
  }

  // ---- disconnecting -----------------------------------------------------------------------------------------------

  async disconnect(actor: Actor, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PANEL_LOCK_KEY})`;
      const rows = await tx.panelConnection.findMany({ select: { id: true, baseUrl: true } });
      const first = rows[0];
      if (!first) {
        throw new NotFoundException('No panel is connected.');
      }
      await tx.panelConnection.deleteMany();
      await this.audit.record(
        {
          action: 'panel.disconnected',
          outcome: 'success',
          actor,
          object: { type: 'panel', id: first.id },
          details: { base_url: first.baseUrl.slice(0, 200) },
          meta,
        },
        tx,
      );
    });
    this.cache.reset();
  }
}
