import { randomBytes } from 'node:crypto';

import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type ArtifactCheck,
  type ArtifactDestination,
  type ArtifactManifest,
  type ArtifactPushResult,
  type ArtifactVerification,
  artifactFileMode,
  type PushArtifactRequest,
  type ServerArtifact,
  type ServerArtifactList,
} from '@swellwright/contracts';
import { type Database, type ServerArtifact as ServerArtifactRow } from '@swellwright/db';
import {
  type SftpClient,
  type SshConnection,
  SshHashMismatchError,
  shellQuote,
} from '@swellwright/ssh';
import semver from 'semver';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { WindowLimiter } from '../auth/rate-limit.js';
import { type AppConfig } from '../config.js';
import { CodedHttpException, RateLimitedException } from '../http.js';
import { type Actor } from '../servers/servers.service.js';
import { ServersService } from '../servers/servers.service.js';
import { isLoginFailure, SshService, type SshSession } from '../servers/ssh.service.js';
import { CONFIG, DATABASE } from '../tokens.js';
import { CatalogueService } from './catalogue.service.js';
import {
  checkedRemotePath,
  chmodCommand,
  identify,
  inspectRemote,
  installCommand,
  type Identity,
  type RemoteLayout,
  remoteLayout,
  removeDirCommand,
  removeFileCommand,
} from './remote.js';

/** The quick commands (who am I, may I use sudo, one hash) never wait longer than this, whatever the command timeout is. */
const QUICK_TIMEOUT_MS = 30_000;

const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2003';

/** The failures that mean "the server was asked and did not play along": they are recorded; refusals before that are not. */
function isRecordedFailure(error: unknown): error is CodedHttpException {
  return (
    error instanceof CodedHttpException &&
    (error.apiCode === 'host_key_mismatch' ||
      error.apiCode === 'artifact_hash_mismatch' ||
      error.apiCode === 'sudo_unavailable' ||
      isLoginFailure(error.apiCode))
  );
}

const failureCodeOf = (error: unknown): string =>
  error instanceof CodedHttpException ? error.apiCode : 'internal_error';

const hashMismatch = (
  expected: string,
  actual: string,
  stage: 'upload' | 'final',
): CodedHttpException =>
  new CodedHttpException(
    502,
    'artifact_hash_mismatch',
    stage === 'upload'
      ? `What arrived on the server hashes to ${actual}, not to ${expected}. The upload was thrown away and nothing was put in place.`
      : `The copy in its place on the server hashes to ${actual}, not to ${expected}. It was removed.`,
    { expected, actual, stage },
  );

const ignoreFailure = (): undefined => undefined;

type Operation = 'push' | 'verify' | 'remove';

interface Pushed {
  readonly result: 'pushed' | 'unchanged';
  readonly layout: RemoteLayout;
}

/**
 * Putting artifacts on servers and keeping an eye on them (ADR 0039). A push hashes the file of the catalogue (a file
 * that is not what its manifest says is never sent), uploads it over SFTP under a temporary name, has the server
 * hash what arrived, renames it into place and has the server hash it once more; a failure leaves nothing at the
 * place of the file. What was pushed is kept per server, so a copy can be checked later and removed.
 */
@Injectable()
export class DistributionService {
  private readonly logger = new Logger('Artifacts');
  private readonly limiter: WindowLimiter;
  /** One operation per server at a time: two would race on the same directories. */
  private readonly busy = new Map<string, Operation>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ServersService) private readonly servers: ServersService,
    @Inject(SshService) private readonly ssh: SshService,
    @Inject(CatalogueService) private readonly catalogue: CatalogueService,
  ) {
    this.limiter = new WindowLimiter(config.artifacts.rateLimitPerMinute, 60_000);
  }

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  private get quickMs(): number {
    return Math.min(QUICK_TIMEOUT_MS, this.config.ssh.commandTimeoutMs);
  }

  /** A person may start only so many of these a minute: the API must not be a way to hammer a server. */
  private limit(actor: Actor): void {
    if (!this.limiter.hit(actor.id)) {
      throw new RateLimitedException(60, 'Too many artifact operations. Try again in a minute.');
    }
  }

  /** Runs `work` as the only operation on this server, or says that another one is running. */
  private async exclusive<T>(
    serverId: string,
    operation: Operation,
    work: () => Promise<T>,
  ): Promise<T> {
    const running = this.busy.get(serverId);
    if (running !== undefined) {
      throw new CodedHttpException(
        409,
        'artifact_busy',
        `Another artifact operation (${running}) is running on this server. Try again when it has finished.`,
      );
    }
    this.busy.set(serverId, operation);
    try {
      return await work();
    } finally {
      this.busy.delete(serverId);
    }
  }

  /**
   * Logs in with the access entries by priority until one is accepted and runs `operation` on it. An entry the server
   * does not accept is skipped; any other failure ends the attempt.
   */
  private async withLogin<T>(
    info: Awaited<ReturnType<ServersService['connectionInfo']>>,
    operation: (session: SshSession) => Promise<T>,
  ): Promise<T> {
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
      try {
        return await this.ssh.withAccess(
          { address: info.address, port: info.port, hostKeyTypes: info.hostKeyTypes },
          info.fingerprints,
          entry,
          operation,
        );
      } catch (error) {
        if (error instanceof CodedHttpException && error.apiCode === 'secret_expired') {
          // The entry names a secret that expired (nothing was sent with it): the next entry may work (ADR 0042).
          expired = error;
          tried.push(`${entry.id}:${error.apiCode}`);
          continue;
        }
        if (
          error instanceof CodedHttpException &&
          (error.apiCode === 'ssh_auth_failed' || error.apiCode === 'ssh_key_invalid')
        ) {
          expired = null;
          tried.push(`${entry.id}:${error.apiCode}`);
          continue;
        }
        throw error;
      }
    }
    if (expired !== null && tried.every((entry) => entry.endsWith(':secret_expired'))) {
      throw expired;
    }
    throw new CodedHttpException(
      502,
      'ssh_auth_failed',
      'The server accepted none of the access entries.',
      { tried },
    );
  }

  /** Root does not need sudo; anyone else does, and it must work. The login that cannot become root cannot write the system directory. */
  private async rootOptions(
    session: SshSession,
    identity: Identity,
  ): Promise<{ readonly sudo: { password?: string } }> {
    const sudo = session.sudoPassword === undefined ? {} : { password: session.sudoPassword };
    if (identity.uid !== 0) {
      const probe = await session.connection.exec('true', { sudo, timeoutMs: this.quickMs });
      if (probe.code !== 0) {
        throw new CodedHttpException(
          409,
          'sudo_unavailable',
          'This needs root. The login is not root and sudo does not work for it (it is not installed, refuses the login or asks for a password that is not stored).',
        );
      }
    }
    return { sudo };
  }

  // --- reading ----------------------------------------------------------------------------------------------------

  private async view(rows: readonly ServerArtifactRow[]): Promise<ServerArtifact[]> {
    const ids = [
      ...new Set(rows.flatMap((row) => (row.pushedById === null ? [] : [row.pushedById]))),
    ];
    const users =
      ids.length === 0
        ? []
        : await this.db.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, username: true },
          });
    const names = new Map(users.map((user) => [user.id, user.username]));
    return rows.map((row) => ({
      name: row.name,
      version: row.version,
      sha256: row.sha256,
      size: row.size,
      destination: row.destination,
      remotePath: row.remotePath,
      pushedAt: row.pushedAt.toISOString(),
      pushedBy: row.pushedById === null ? null : (names.get(row.pushedById) ?? null),
      verify:
        row.verifiedAt !== null && row.verifyState !== null
          ? {
              state: row.verifyState,
              verifiedAt: row.verifiedAt.toISOString(),
              remoteSha256: row.remoteSha256,
            }
          : null,
      catalogue: this.catalogue.stateOf(row.name, row.version),
    }));
  }

  /** What was pushed to a server. Reading never connects to it. */
  async list(serverId: string): Promise<ServerArtifactList> {
    const server = await this.db.server.findUnique({
      where: { id: serverId },
      select: { id: true },
    });
    if (!server) {
      throw new NotFoundException('There is no such server.');
    }
    const rows = await this.db.serverArtifact.findMany({ where: { serverId } });
    // By name, then by version as versions compare (1.10.0 after 1.9.0), which the database cannot do.
    rows.sort((a, b) =>
      a.name === b.name ? semver.compare(a.version, b.version) : a.name < b.name ? -1 : 1,
    );
    return { artifacts: await this.view(rows) };
  }

  // --- push -------------------------------------------------------------------------------------------------------

  /** Pushes an artifact to a server. See the class description. */
  async push(
    actor: Actor,
    serverId: string,
    request: PushArtifactRequest,
    meta: RequestMeta,
  ): Promise<{ result: ArtifactPushResult; created: boolean }> {
    this.limit(actor);
    const destination: ArtifactDestination = request.destination ?? 'user';
    // The file is read and hashed now, before anything is sent; a file that is not what its manifest says never leaves.
    const verified = await this.catalogue.readVerified(request.name, request.version, actor);
    const { manifest } = verified;
    const info = await this.servers.connectionInfo(serverId);
    const existing = await this.db.serverArtifact.findUnique({
      where: {
        serverId_name_version: { serverId, name: manifest.name, version: manifest.version },
      },
    });
    if (existing && existing.destination !== destination) {
      throw new CodedHttpException(
        409,
        'artifact_destination_conflict',
        `${manifest.name} ${manifest.version} is on this server at the "${existing.destination}" destination. Remove that copy first, then push it to "${destination}".`,
      );
    }
    const started = performance.now();
    return this.exclusive(serverId, 'push', async () => {
      let pushed: Pushed;
      try {
        pushed = await this.withLogin(info, (session) =>
          this.pushOnSession(session, destination, manifest, verified.bytes),
        );
      } catch (error) {
        if (isRecordedFailure(error)) {
          await this.audit.note({
            action: 'artifact.pushed',
            outcome: 'failure',
            actor,
            object: { type: 'server', id: serverId },
            details: this.details(manifest, destination, info.name, {
              error_code: error.apiCode,
            }),
            meta,
          });
        }
        throw error;
      }
      const now = new Date();
      try {
        const row = await this.db.$transaction(async (tx) => {
          const keep = {
            verifiedAt: now,
            verifyState: 'ok' as const,
            remoteSha256: manifest.sha256,
          };
          const saved =
            pushed.result === 'unchanged' && existing
              ? await tx.serverArtifact.update({ where: { id: existing.id }, data: keep })
              : await tx.serverArtifact.upsert({
                  where: {
                    serverId_name_version: {
                      serverId,
                      name: manifest.name,
                      version: manifest.version,
                    },
                  },
                  create: {
                    serverId,
                    name: manifest.name,
                    version: manifest.version,
                    sha256: manifest.sha256,
                    size: manifest.size,
                    destination,
                    remotePath: pushed.layout.path,
                    pushedAt: now,
                    pushedById: actor.id,
                    ...keep,
                  },
                  update: {
                    sha256: manifest.sha256,
                    size: manifest.size,
                    destination,
                    remotePath: pushed.layout.path,
                    pushedAt: now,
                    pushedById: actor.id,
                    ...keep,
                  },
                });
          await this.audit.record(
            {
              action: 'artifact.pushed',
              outcome: 'success',
              actor,
              object: { type: 'server', id: serverId },
              details: this.details(manifest, destination, info.name, {
                result: pushed.result,
                remote_path: pushed.layout.path.slice(0, 200),
              }),
              meta,
            },
            tx,
          );
          return saved;
        });
        const [shown] = await this.view([row]);
        if (!shown) {
          throw new Error('A pushed artifact must have a view.');
        }
        return {
          result: {
            result: pushed.result,
            artifact: shown,
            durationMs: Math.round(performance.now() - started),
          },
          created: pushed.result === 'pushed',
        };
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw new NotFoundException('The server was deleted while the artifact was pushed.');
        }
        throw error;
      }
    });
  }

  private details(
    manifest: ArtifactManifest,
    destination: ArtifactDestination,
    serverName: string,
    more: Record<string, string | number | boolean | null>,
  ): Record<string, string | number | boolean | null> {
    return {
      artifact: manifest.name,
      version: manifest.version,
      server_name: serverName.slice(0, 64),
      sha256_prefix: manifest.sha256.slice(0, 12),
      destination,
      ...more,
    };
  }

  /** The work on a logged-in connection: look, upload, check, put in place, check again. */
  private async pushOnSession(
    session: SshSession,
    destination: ArtifactDestination,
    manifest: ArtifactManifest,
    bytes: Buffer,
  ): Promise<Pushed> {
    const { connection } = session;
    const identity = await identify(connection, this.quickMs);
    const layout = remoteLayout(
      destination,
      identity.home,
      manifest.name,
      manifest.version,
      manifest.file,
    );
    const mode = artifactFileMode(manifest.interpreter);
    const root = destination === 'system' ? await this.rootOptions(session, identity) : undefined;
    const sftp = await connection.sftp();
    try {
      const have = await inspectRemote(connection, sftp, layout.path, this.quickMs, root);
      if (have.state === 'file' && have.sha256 === manifest.sha256) {
        return { result: 'unchanged', layout };
      }
      if (have.state === 'other') {
        throw new CodedHttpException(
          502,
          'ssh_failed',
          `There is something that is not a file at ${layout.path} on the server. Nothing was changed.`,
        );
      }
      if (destination === 'user') {
        await this.uploadForUser(connection, sftp, layout, manifest, mode, bytes);
      } else if (root) {
        await this.uploadForSystem(connection, sftp, layout, identity, manifest, mode, bytes, root);
      }
      return { result: 'pushed', layout };
    } finally {
      sftp.close();
    }
  }

  /** Leftovers of an upload that was cut (the connection died before the temporary file could be deleted). */
  private async sweep(
    connection: SshConnection,
    directory: string,
    patterns: string[],
  ): Promise<void> {
    const words = patterns.map((pattern) => `${shellQuote(directory)}/${pattern}`).join(' ');
    await connection.exec(`rm -f -- ${words}`, { timeoutMs: this.quickMs }).catch(ignoreFailure);
  }

  private async put(
    sftp: SftpClient,
    bytes: Buffer,
    path: string,
    mode: number,
    manifest: ArtifactManifest,
  ): Promise<void> {
    try {
      await sftp.put(bytes, path, {
        mode,
        expectedSha256: manifest.sha256,
        verify: 'auto',
      });
    } catch (error) {
      if (error instanceof SshHashMismatchError) {
        // The temporary file is already gone: the SSH layer deletes it before it reports a mismatch.
        throw hashMismatch(error.expected, error.actual, 'upload');
      }
      throw error;
    }
  }

  private async uploadForUser(
    connection: SshConnection,
    sftp: SftpClient,
    layout: RemoteLayout,
    manifest: ArtifactManifest,
    mode: number,
    bytes: Buffer,
  ): Promise<void> {
    // Private to the login: nobody else needs to read or change what Swellwright keeps in a home directory.
    await sftp.mkdir(layout.dir, { recursive: true, mode: 0o700 });
    await this.sweep(connection, layout.dir, ['*.swellwright-*.part']);
    await this.put(sftp, bytes, layout.path, mode, manifest);
    // The umask of the login may have narrowed the mode that was asked for; the mode is exact, not "at most".
    const changed = await connection.exec(chmodCommand(mode, layout.path), {
      timeoutMs: this.quickMs,
    });
    if (changed.code !== 0) {
      await sftp.remove(layout.path, { ignoreMissing: true }).catch(ignoreFailure);
      throw new CodedHttpException(
        502,
        'ssh_failed',
        'The server could not set the mode of the file.',
      );
    }
    await this.confirmInPlace(connection, sftp, layout, manifest);
  }

  private async uploadForSystem(
    connection: SshConnection,
    sftp: SftpClient,
    layout: RemoteLayout,
    identity: Identity,
    manifest: ArtifactManifest,
    mode: number,
    bytes: Buffer,
    root: { readonly sudo: { password?: string } },
  ): Promise<void> {
    // The upload goes to the login's own home first (the login cannot write the system directory), is checked there,
    // and is then installed as root next to its final place and renamed over it.
    const staging = `${identity.home.endsWith('/') ? identity.home.slice(0, -1) : identity.home}/.swellwright/incoming`;
    const token = randomBytes(6).toString('hex');
    const staged = `${staging}/${token}-${manifest.file}.swellwright-staged`;
    const temporary = `${layout.dir}/.${manifest.file}.swellwright-${token}.part`;
    await sftp.mkdir(staging, { recursive: true, mode: 0o700 });
    await this.sweep(connection, staging, ['*.swellwright-staged', '*.swellwright-*.part']);
    // A temporary file of an installation that was cut off sits next to the final place, owned by root.
    await connection
      .exec(`rm -f -- ${shellQuote(layout.dir)}/.*.swellwright-*.part`, {
        ...root,
        timeoutMs: this.quickMs,
      })
      .catch(ignoreFailure);
    try {
      await this.put(sftp, bytes, staged, 0o600, manifest);
      const installed = await connection.exec(
        installCommand({ staged, dir: layout.dir, temporary, final: layout.path, mode }),
        { ...root, timeoutMs: this.config.ssh.commandTimeoutMs },
      );
      if (installed.code !== 0) {
        // Nothing may stay behind in the system directory.
        await connection
          .exec(removeFileCommand(temporary), { ...root, timeoutMs: this.quickMs })
          .catch(ignoreFailure);
        throw new CodedHttpException(
          502,
          'ssh_failed',
          'The server could not install the file in the system directory.',
        );
      }
      await this.confirmInPlace(connection, sftp, layout, manifest, root);
    } finally {
      await sftp.remove(staged, { ignoreMissing: true }).catch(ignoreFailure);
    }
  }

  /** The second hash: the file in its place, read by the server. A copy that is not right is removed. */
  private async confirmInPlace(
    connection: SshConnection,
    sftp: SftpClient,
    layout: RemoteLayout,
    manifest: ArtifactManifest,
    root?: { readonly sudo: { password?: string } },
  ): Promise<void> {
    const now = await inspectRemote(connection, sftp, layout.path, this.quickMs, root);
    if (now.state === 'file' && now.sha256 === manifest.sha256) {
      return;
    }
    if (root) {
      await connection
        .exec(removeFileCommand(layout.path), { ...root, timeoutMs: this.quickMs })
        .catch(ignoreFailure);
    } else {
      await sftp.remove(layout.path, { ignoreMissing: true }).catch(ignoreFailure);
    }
    throw hashMismatch(manifest.sha256, now.state === 'file' ? now.sha256 : 'nothing', 'final');
  }

  // --- verify -----------------------------------------------------------------------------------------------------

  /** The record of every copy asked about, or 404. */
  private async copies(serverId: string, name: string, version: string | undefined) {
    const rows = await this.db.serverArtifact.findMany({
      where: { serverId, name, ...(version === undefined ? {} : { version }) },
      orderBy: { version: 'asc' },
    });
    if (rows.length === 0) {
      const server = await this.db.server.findUnique({
        where: { id: serverId },
        select: { id: true },
      });
      throw new NotFoundException(
        server ? 'This artifact was not pushed to this server.' : 'There is no such server.',
      );
    }
    return rows;
  }

  /** The place of a recorded copy, or a refusal when the record does not have the shape a push makes. */
  private placeOf(row: ServerArtifactRow): RemoteLayout {
    const layout = checkedRemotePath(row.remotePath, row.destination, row.name, row.version);
    if (!layout) {
      this.logger.error(
        `the recorded path of ${row.name} ${row.version} does not match the layout`,
      );
      throw new ConflictException(
        'The recorded path of this copy does not have the shape a push makes. Nothing was touched; push it again.',
      );
    }
    return layout;
  }

  /** Hashes the copies on the server and compares them with the catalogue. */
  async verify(
    actor: Actor,
    serverId: string,
    name: string,
    version: string | undefined,
    meta: RequestMeta,
  ): Promise<ArtifactVerification> {
    this.limit(actor);
    const rows = await this.copies(serverId, name, version);
    const places = rows.map((row) => ({ row, layout: this.placeOf(row) }));
    const info = await this.servers.connectionInfo(serverId);
    return this.exclusive(serverId, 'verify', async () => {
      let found: { row: ServerArtifactRow; check: ArtifactCheck }[];
      try {
        found = await this.withLogin(info, (session) => this.checkCopies(session, places));
      } catch (error) {
        if (isRecordedFailure(error)) {
          await this.audit.note({
            action: 'artifact.verified',
            outcome: 'failure',
            actor,
            object: { type: 'server', id: serverId },
            details: {
              artifact: name,
              version: version ?? null,
              server_name: info.name.slice(0, 64),
              error_code: error.apiCode,
            },
            meta,
          });
        }
        throw error;
      }
      const verifiedAt = new Date();
      await this.db.$transaction(async (tx) => {
        for (const { row, check } of found) {
          await tx.serverArtifact.updateMany({
            where: { id: row.id },
            data: {
              verifiedAt,
              verifyState: check.state,
              remoteSha256: check.actualSha256,
            },
          });
          await this.audit.record(
            {
              action: 'artifact.verified',
              outcome: check.state === 'ok' ? 'success' : 'failure',
              actor,
              object: { type: 'server', id: serverId },
              details: {
                artifact: row.name,
                version: row.version,
                server_name: info.name.slice(0, 64),
                sha256_prefix: check.expectedSha256.slice(0, 12),
                state: check.state,
                actual_prefix: check.actualSha256?.slice(0, 12) ?? null,
                catalogue: check.catalogue,
              },
              meta,
            },
            tx,
          );
        }
      });
      const results = found.map(({ check }) => check);
      return {
        verifiedAt: verifiedAt.toISOString(),
        ok: results.every((check) => check.state === 'ok'),
        results,
      };
    });
  }

  private async checkCopies(
    session: SshSession,
    places: readonly { row: ServerArtifactRow; layout: RemoteLayout }[],
  ): Promise<{ row: ServerArtifactRow; check: ArtifactCheck }[]> {
    const sftp = await session.connection.sftp();
    // A copy in the system directory is looked at as root: the login may not be able to reach that directory at all
    // (a root-only parent). Without a working sudo the login looks for itself, as it could before.
    let asRoot: { readonly sudo: { password?: string } } | null | undefined;
    const rootFor = async (
      destination: ArtifactDestination,
    ): Promise<{ readonly sudo: { password?: string } } | undefined> => {
      if (destination !== 'system') {
        return undefined;
      }
      if (asRoot === undefined) {
        try {
          asRoot = await this.rootOptions(
            session,
            await identify(session.connection, this.quickMs),
          );
        } catch (error) {
          if (!(error instanceof CodedHttpException) || error.apiCode !== 'sudo_unavailable') {
            throw error;
          }
          asRoot = null;
        }
      }
      return asRoot ?? undefined;
    };
    try {
      const out: { row: ServerArtifactRow; check: ArtifactCheck }[] = [];
      for (const { row, layout } of places) {
        // What it must hash to: the catalogue's value; the pushed value when the catalogue no longer has the version.
        const expected = this.catalogue.declaredSha256(row.name, row.version) ?? row.sha256;
        const copy = await inspectRemote(
          session.connection,
          sftp,
          layout.path,
          this.quickMs,
          await rootFor(row.destination),
        );
        const actual = copy.state === 'file' ? copy.sha256 : null;
        out.push({
          row,
          check: {
            version: row.version,
            state: copy.state === 'missing' ? 'missing' : actual === expected ? 'ok' : 'differs',
            expectedSha256: expected,
            actualSha256: actual,
            catalogue: this.catalogue.stateOf(row.name, row.version),
          },
        });
      }
      return out;
    } finally {
      sftp.close();
    }
  }

  // --- remove -----------------------------------------------------------------------------------------------------

  /** Deletes a copy from the server and forgets it. */
  async remove(
    actor: Actor,
    serverId: string,
    name: string,
    version: string,
    meta: RequestMeta,
  ): Promise<void> {
    this.limit(actor);
    const [row] = await this.copies(serverId, name, version);
    if (!row) {
      throw new NotFoundException('This artifact was not pushed to this server.');
    }
    const layout = this.placeOf(row);
    const info = await this.servers.connectionInfo(serverId);
    await this.exclusive(serverId, 'remove', async () => {
      try {
        await this.withLogin(info, (session) => this.removeOnSession(session, row, layout));
      } catch (error) {
        if (isRecordedFailure(error)) {
          await this.audit.note({
            action: 'artifact.removed',
            outcome: 'failure',
            actor,
            object: { type: 'server', id: serverId },
            details: {
              artifact: row.name,
              version: row.version,
              server_name: info.name.slice(0, 64),
              destination: row.destination,
              error_code: failureCodeOf(error),
            },
            meta,
          });
        }
        throw error;
      }
      await this.db.$transaction(async (tx) => {
        await tx.serverArtifact.deleteMany({ where: { id: row.id } });
        await this.audit.record(
          {
            action: 'artifact.removed',
            outcome: 'success',
            actor,
            object: { type: 'server', id: serverId },
            details: {
              artifact: row.name,
              version: row.version,
              server_name: info.name.slice(0, 64),
              sha256_prefix: row.sha256.slice(0, 12),
              destination: row.destination,
              remote_path: layout.path.slice(0, 200),
            },
            meta,
          },
          tx,
        );
      });
    });
  }

  private async removeOnSession(
    session: SshSession,
    row: ServerArtifactRow,
    layout: RemoteLayout,
  ): Promise<void> {
    const { connection } = session;
    if (row.destination === 'user') {
      const sftp = await connection.sftp();
      try {
        await sftp.remove(layout.path, { ignoreMissing: true });
        // The directories this push made, if nothing else is in them: an empty directory refuses to go otherwise.
        await sftp.rmdir(layout.dir).catch(ignoreFailure);
        await sftp.rmdir(layout.nameDir).catch(ignoreFailure);
      } finally {
        sftp.close();
      }
      return;
    }
    const identity = await identify(connection, this.quickMs);
    const root = await this.rootOptions(session, identity);
    const removed = await connection.exec(removeFileCommand(layout.path), {
      ...root,
      timeoutMs: this.quickMs,
    });
    if (removed.code !== 0) {
      throw new CodedHttpException(
        502,
        'ssh_failed',
        'The server could not remove the file from the system directory.',
      );
    }
    for (const directory of [layout.dir, layout.nameDir]) {
      await connection
        .exec(removeDirCommand(directory), { ...root, timeoutMs: this.quickMs })
        .catch(ignoreFailure);
    }
  }
}
