import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AccessVerification,
  AcceptHostKeyRequest,
  HostKeyAccepted,
  HostKeyScan,
  ServerFactsRecord,
} from '@swellwright/contracts';
import { type Database, type Prisma } from '@swellwright/db';
import { type SshConnection, shellQuote } from '@swellwright/ssh';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { WindowLimiter } from '../auth/rate-limit.js';
import { type AppConfig } from '../config.js';
import { CodedHttpException, RateLimitedException } from '../http.js';
import { CONFIG, DATABASE } from '../tokens.js';
import { type FactsScript, loadFactsScript } from './facts/script.js';
import { parseFacts } from './facts/parse-facts.js';
import { type Actor, factsView, ServersService } from './servers.service.js';
import { isLoginFailure, SshService, type SshSession } from './ssh.service.js';

/** The quick probes (who am I, may I sudo) never wait longer than this, whatever the command timeout is. */
const PROBE_TIMEOUT_MS = 20_000;
/** The facts script prints a few kilobytes; anything near this is not it. */
const FACTS_MAX_OUTPUT_BYTES = 256 * 1024;

const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2003';

/** The errors that mean "the server was asked and did not play along": they are recorded, the others are refusals. */
function isRecordedFailure(error: unknown): error is CodedHttpException {
  return (
    error instanceof CodedHttpException &&
    (error.apiCode === 'host_key_mismatch' ||
      error.apiCode === 'facts_unreadable' ||
      isLoginFailure(error.apiCode))
  );
}

const failureCodeOf = (error: unknown): string =>
  error instanceof CodedHttpException ? error.apiCode : 'internal_error';

type SudoState = AccessVerification['sudo'];

/**
 * What a person can do with a server over SSH (ADR 0037): read its host key and pin it after confirming the
 * fingerprint, try an access entry, collect its facts. Every operation is rate limited per user, applies the address
 * policy through `SshService`, and leaves an audit record that says what was asked and how it ended (never a secret).
 */
@Injectable()
export class ServerSshService {
  private readonly limiter: WindowLimiter;
  private readonly refreshing = new Map<string, Promise<ServerFactsRecord>>();
  private readonly script: FactsScript;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ServersService) private readonly servers: ServersService,
    @Inject(SshService) private readonly ssh: SshService,
  ) {
    this.limiter = new WindowLimiter(config.ssh.rateLimitPerMinute, 60_000);
    // Read now, so that a build without the script fails at start and not at the first refresh.
    this.script = loadFactsScript();
  }

  /** The quick probes never wait longer than the command timeout either. */
  private get probeMs(): number {
    return Math.min(PROBE_TIMEOUT_MS, this.config.ssh.commandTimeoutMs);
  }

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /** A person may start only so many connections a minute: the API must not be a way to hammer a server. */
  private limit(actor: Actor): void {
    if (!this.limiter.hit(actor.id)) {
      throw new RateLimitedException(60, 'Too many SSH operations. Try again in a minute.');
    }
  }

  async scan(actor: Actor, id: string, meta: RequestMeta): Promise<HostKeyScan> {
    this.limit(actor);
    const info = await this.servers.connectionInfo(id);
    let key;
    try {
      key = await this.ssh.scanHostKey(info.address, info.port, info.hostKeyTypes);
    } catch (error) {
      await this.audit.note({
        action: 'server.host_key.scanned',
        outcome: 'failure',
        actor,
        object: { type: 'server', id },
        details: { error_code: failureCodeOf(error) },
        meta,
      });
      throw error;
    }
    const pinned = (await this.servers.get(id)).hostKeys;
    const status = pinned.some((known) => known.fingerprintSha256 === key.fingerprintSha256)
      ? 'pinned'
      : pinned.length === 0
        ? 'new'
        : 'differs';
    await this.audit.note({
      action: 'server.host_key.scanned',
      outcome: 'success',
      actor,
      object: { type: 'server', id },
      details: { algorithm: key.algorithm, fingerprint: key.fingerprintSha256, status },
      meta,
    });
    return {
      address: info.address,
      port: info.port,
      algorithm: key.algorithm,
      fingerprintSha256: key.fingerprintSha256,
      status,
      pinned,
    };
  }

  /** Asks the server again and pins its key only if it is exactly the one the person confirmed. */
  async accept(
    actor: Actor,
    id: string,
    request: AcceptHostKeyRequest,
    meta: RequestMeta,
  ): Promise<HostKeyAccepted & { created: boolean }> {
    this.limit(actor);
    const info = await this.servers.connectionInfo(id);
    let key;
    try {
      key = await this.ssh.scanHostKey(info.address, info.port, info.hostKeyTypes);
    } catch (error) {
      await this.audit.note({
        action: 'server.host_key.scanned',
        outcome: 'failure',
        actor,
        object: { type: 'server', id },
        details: { error_code: failureCodeOf(error), purpose: 'accept' },
        meta,
      });
      throw error;
    }
    if (key.fingerprintSha256 !== request.fingerprintSha256) {
      await this.audit.note({
        action: 'server.host_key.scanned',
        outcome: 'failure',
        actor,
        object: { type: 'server', id },
        details: {
          error_code: 'host_key_mismatch',
          purpose: 'accept',
          confirmed: request.fingerprintSha256,
          fingerprint: key.fingerprintSha256,
        },
        meta,
      });
      throw new CodedHttpException(
        409,
        'host_key_mismatch',
        'The server now shows another host key than the one that was confirmed. Nothing was pinned: scan it again and check the new fingerprint.',
        { expected: [request.fingerprintSha256], actual: key.fingerprintSha256 },
      );
    }
    const {
      key: pinned,
      created,
      replaced,
    } = await this.servers.acceptScannedKey(actor, id, key, request.replace === true, meta);
    return { key: pinned, replaced, created };
  }

  /**
   * Who am I and may I use sudo. The sudo check goes through the same wrapper every later operation uses: the stored
   * password on standard input when there is one, otherwise `sudo -n`.
   */
  private async probeSudo(
    connection: SshConnection,
    sudoPassword: string | undefined,
  ): Promise<SudoState> {
    const result = await connection.exec('true', {
      sudo: sudoPassword === undefined ? {} : { password: sudoPassword },
      timeoutMs: this.probeMs,
    });
    if (result.code === 0) {
      return 'ok';
    }
    const text = result.stderr.toLowerCase();
    if (result.code === 127 || text.includes('not found')) {
      return 'unavailable';
    }
    if (sudoPassword === undefined && text.includes('password is required')) {
      return 'password_required';
    }
    return 'failed';
  }

  private async probe(
    session: SshSession,
    started: number,
  ): Promise<Omit<AccessVerification, 'verifiedAt'>> {
    const { connection, sudoPassword } = session;
    const user = await connection.exec('id -un', { timeoutMs: this.probeMs });
    const uid = await connection.exec('id -u', { timeoutMs: this.probeMs });
    const uidText = uid.stdout.trim();
    if (uid.code !== 0 || !/^[0-9]{1,10}$/u.test(uidText)) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        remoteUser: null,
        isRoot: null,
        sudo: 'unavailable',
        error: {
          code: 'ssh_failed',
          message:
            'The login works, but the server did not run the check commands. A restricted shell or a forced command can cause this.',
        },
      };
    }
    const name = user.code === 0 ? user.stdout.trim() : '';
    const isRoot = uidText === '0';
    const sudo: SudoState = isRoot ? 'not_needed' : await this.probeSudo(connection, sudoPassword);
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      remoteUser: /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}\$?$/u.test(name) ? name : null,
      isRoot,
      sudo,
    };
  }

  /**
   * Tries an access entry. A login that does not work is the answer (`ok: false`), not an error; what stops the
   * attempt before it starts (nothing pinned, the address policy, a sealed vault) and a host key that is not the pinned
   * one are errors. The outcome is kept on the entry and recorded, in one transaction.
   */
  async verify(
    actor: Actor,
    id: string,
    accessId: string,
    meta: RequestMeta,
  ): Promise<AccessVerification> {
    this.limit(actor);
    const info = await this.servers.connectionInfo(id);
    const entry = info.access.find((candidate) => candidate.id === accessId);
    if (!entry) {
      throw new NotFoundException('There is no such access entry on this server.');
    }
    const started = performance.now();
    let outcome: Omit<AccessVerification, 'verifiedAt'> | null = null;
    let refused: CodedHttpException | null = null;
    try {
      outcome = await this.ssh.withAccess(
        { address: info.address, port: info.port, hostKeyTypes: info.hostKeyTypes },
        info.fingerprints,
        entry,
        (session) => this.probe(session, started),
      );
    } catch (error) {
      if (!isRecordedFailure(error)) {
        throw error;
      }
      if (error.apiCode === 'host_key_mismatch') {
        refused = error;
      } else if (isLoginFailure(error.apiCode)) {
        outcome = {
          ok: false,
          latencyMs: Math.round(performance.now() - started),
          remoteUser: null,
          isRoot: null,
          sudo: 'unavailable',
          error: { code: error.apiCode, message: error.message },
        };
      } else {
        throw error;
      }
    }
    const ok = outcome?.ok ?? false;
    // One moment for the answer, the entry and the record.
    const verifiedAt = new Date();
    await this.db.$transaction(async (tx) => {
      await tx.serverAccess.updateMany({
        where: { id: accessId, serverId: id },
        data: { lastVerifiedAt: verifiedAt, lastVerifyOk: ok },
      });
      await this.audit.record(
        {
          action: 'server.access.verified',
          outcome: ok ? 'success' : 'failure',
          actor,
          object: { type: 'server', id },
          details: {
            access_id: accessId,
            ok,
            error_code: refused?.apiCode ?? outcome?.error?.code ?? null,
            remote_user: outcome?.remoteUser ?? null,
            is_root: outcome?.isRoot ?? null,
            sudo: outcome?.sudo ?? null,
            latency_ms: outcome?.latencyMs ?? null,
          },
          meta,
        },
        tx,
      );
    });
    if (refused) {
      throw refused;
    }
    if (!outcome) {
      throw new Error('A verification must have a result or an error.');
    }
    return { ...outcome, verifiedAt: verifiedAt.toISOString() };
  }

  /** Collects the facts of a server. One refresh per server at a time: a second request joins the one that runs. */
  async refreshFacts(actor: Actor, id: string, meta: RequestMeta): Promise<ServerFactsRecord> {
    this.limit(actor);
    const running = this.refreshing.get(id);
    if (running) {
      return running;
    }
    const started = this.runRefresh(actor, id, meta).finally(() => {
      this.refreshing.delete(id);
    });
    this.refreshing.set(id, started);
    return started;
  }

  private async runRefresh(
    actor: Actor,
    id: string,
    meta: RequestMeta,
  ): Promise<ServerFactsRecord> {
    const info = await this.servers.connectionInfo(id);
    if (info.access.length === 0) {
      throw new CodedHttpException(
        409,
        'no_access_entry',
        'This server has no way to log in. Add an access entry first.',
      );
    }
    const tried: string[] = [];
    let expired: CodedHttpException | null = null;
    for (const entry of info.access) {
      const started = performance.now();
      try {
        const collected = await this.ssh.withAccess(
          { address: info.address, port: info.port, hostKeyTypes: info.hostKeyTypes },
          info.fingerprints,
          entry,
          (session) => this.collect(session),
        );
        return await this.storeFacts(actor, id, entry.id, collected, started, meta);
      } catch (error) {
        if (error instanceof CodedHttpException && error.apiCode === 'secret_expired') {
          // The entry names a secret that expired: nothing was sent with it; the next entry may work.
          expired = error;
          tried.push(`${entry.id}:${error.apiCode}`);
          continue;
        }
        if (
          error instanceof CodedHttpException &&
          (error.apiCode === 'ssh_auth_failed' || error.apiCode === 'ssh_key_invalid')
        ) {
          // This entry does not log in; the next one may.
          expired = null;
          tried.push(`${entry.id}:${error.apiCode}`);
          continue;
        }
        if (isRecordedFailure(error)) {
          await this.recordRefreshFailure(actor, id, entry.id, error.apiCode, meta);
        }
        throw error;
      }
    }
    if (expired !== null && tried.every((entry) => entry.endsWith(':secret_expired'))) {
      // Every entry was refused for an expired secret: nothing was attempted, so there is nothing to record.
      throw expired;
    }
    await this.recordRefreshFailure(actor, id, null, 'ssh_auth_failed', meta);
    throw new CodedHttpException(
      502,
      'ssh_auth_failed',
      'The server accepted none of the access entries.',
      { tried },
    );
  }

  private async collect(session: SshSession) {
    const { connection, sudoPassword } = session;
    const timeoutMs = this.config.ssh.commandTimeoutMs;
    const uid = await connection.exec('id -u', { timeoutMs: this.probeMs });
    const isRoot = uid.code === 0 && uid.stdout.trim() === '0';
    let sudo: SudoState = isRoot ? 'not_needed' : 'unavailable';
    if (!isRoot) {
      sudo = await this.probeSudo(connection, sudoPassword);
    }
    const viaSudo = sudo === 'ok';
    const startedAt = Date.now();
    const result = await connection.exec(`sh -c ${shellQuote(this.script.text)}`, {
      timeoutMs,
      maxOutputBytes: FACTS_MAX_OUTPUT_BYTES,
      ...(viaSudo ? { sudo: sudoPassword === undefined ? {} : { password: sudoPassword } } : {}),
    });
    const finishedAt = Date.now();
    const parsed = parseFacts(result.stdout, {
      // The server read its clock somewhere in the middle of the run.
      receivedAtMs: Math.round((startedAt + finishedAt) / 2),
      viaSudo,
      truncated: result.stdoutTruncated,
    });
    if (!parsed.recognised) {
      throw new CodedHttpException(
        502,
        'facts_unreadable',
        `The server answered, but not with the output of the facts script (exit status ${String(result.code)}). A restricted shell, a forced command or a login banner can cause this.`,
      );
    }
    return { facts: parsed.facts, sudo };
  }

  private async storeFacts(
    actor: Actor,
    id: string,
    accessId: string,
    collected: Awaited<ReturnType<ServerSshService['collect']>>,
    started: number,
    meta: RequestMeta,
  ): Promise<ServerFactsRecord> {
    const collectedAt = new Date();
    try {
      await this.db.$transaction(async (tx) => {
        const data = {
          facts: collected.facts as Prisma.InputJsonObject,
          collectedAt,
          source: 'ssh',
          scriptSha256: this.script.sha256,
        };
        await tx.serverFact.upsert({
          where: { serverId: id },
          create: { serverId: id, ...data },
          update: data,
        });
        await this.audit.record(
          {
            action: 'server.facts.refreshed',
            outcome: 'success',
            actor,
            object: { type: 'server', id },
            details: {
              access_id: accessId,
              collected_as: collected.facts.collectedAs,
              sudo: collected.sudo,
              script_sha256: this.script.sha256,
              warnings: collected.facts.warnings.length,
              duration_ms: Math.round(performance.now() - started),
            },
            meta,
          },
          tx,
        );
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new NotFoundException('The server was deleted while its facts were collected.');
      }
      throw error;
    }
    const view = factsView({
      facts: collected.facts as Prisma.JsonValue,
      collectedAt,
      source: 'ssh',
      scriptSha256: this.script.sha256,
    });
    if (!view) {
      throw new Error('The facts view must exist for facts that were just stored.');
    }
    return view;
  }

  private async recordRefreshFailure(
    actor: Actor,
    id: string,
    accessId: string | null,
    code: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.record({
      action: 'server.facts.refreshed',
      outcome: 'failure',
      actor,
      object: { type: 'server', id },
      details: { access_id: accessId, error_code: code },
      meta,
    });
  }

  getFacts(id: string): Promise<ServerFactsRecord> {
    return this.servers.getFacts(id);
  }
}
