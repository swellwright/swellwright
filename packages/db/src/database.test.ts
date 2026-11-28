import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  AccessMethod,
  ArtifactCheckState,
  ArtifactDestination,
  AuditOutcome,
  Database,
  DatabaseNotReadyError,
  Prisma,
  schemaProblem,
  SecretType,
  ServerState,
  SessionStage,
  shippedMigrations,
  UserRole,
} from './index.js';
import { createIsolatedDatabase } from './testing.js';

describe('shipped migrations', () => {
  it('lists the migrations of this package, oldest first', async () => {
    const names = await shippedMigrations();
    assert.ok(names.includes('20261118130000_create_users'));
    assert.deepEqual(names, [...names].sort());
  });

  it('ignores files and directories that are not migrations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-migrations-'));
    try {
      await mkdir(join(dir, '20260101000000_first'));
      await mkdir(join(dir, 'not_a_migration'));
      await mkdir(join(dir, '2026_bad'));
      const names = await shippedMigrations(new URL(`${pathToFileURL(dir).href}/`));
      assert.deepEqual(names, ['20260101000000_first']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('schema problem', () => {
  const shipped = ['20260101000000_a', '20260102000000_b'];

  it('is none when every shipped migration is applied and nothing else', () => {
    assert.equal(schemaProblem(shipped, new Set(shipped)), undefined);
  });

  it('reports pending migrations', () => {
    const problem = schemaProblem(shipped, new Set(['20260101000000_a']));
    assert.ok(problem instanceof DatabaseNotReadyError);
    assert.equal(problem.code, 'MIGRATIONS_PENDING');
  });

  it('reports an empty database as pending', () => {
    assert.equal(schemaProblem(shipped, new Set())?.code, 'MIGRATIONS_PENDING');
  });

  it('reports a database that is ahead of the code', () => {
    const problem = schemaProblem(shipped, new Set([...shipped, '20260103000000_c']));
    assert.equal(problem?.code, 'SCHEMA_AHEAD');
  });
});

// Real PostgreSQL with the migrations applied: CI (service container) or a local server, see CONTRIBUTING.md.
const databaseUrl = process.env['SW_TEST_DATABASE_URL'];

describe('users against a migrated database', { skip: !databaseUrl }, () => {
  const prefix = `t${randomBytes(4).toString('hex')}`;
  let db: Database;

  before(() => {
    db = new Database({ url: databaseUrl ?? '', poolSize: 2 });
  });

  after(async () => {
    await db.client.user.deleteMany({ where: { username: { startsWith: prefix } } });
    await db.close();
  });

  it('is ready: the schema matches the shipped migrations', async () => {
    await db.assertReady();
  });

  it('applies the documented defaults and a time-ordered UUID v7 id', async () => {
    const user = await db.client.user.create({
      data: { username: `${prefix}-defaults`, role: UserRole.operator },
    });
    assert.match(user.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(user.status, 'active');
    // A language is a choice (ADR 0026): nobody has chosen one yet, so the console follows the browser.
    assert.equal(user.language, null);
    assert.equal(user.theme, 'dark');
    assert.equal(user.email, null);
    assert.equal(user.lastLoginAt, null);
    assert.ok(user.createdAt instanceof Date);
  });

  it('moves updatedAt forward on update', async () => {
    const user = await db.client.user.create({
      data: { username: `${prefix}-updated`, role: UserRole.observer },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const changed = await db.client.user.update({
      where: { id: user.id },
      data: { displayName: 'Changed' },
    });
    assert.ok(changed.updatedAt.getTime() > user.updatedAt.getTime());
    assert.equal(changed.createdAt.getTime(), user.createdAt.getTime());
  });

  it('rejects a duplicate username and a duplicate email', async () => {
    const name = `${prefix}-unique`;
    const email = `${name}@example.invalid`;
    await db.client.user.create({ data: { username: name, email, role: UserRole.auditor } });
    const isUnique = (error: unknown): boolean =>
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
    await assert.rejects(
      db.client.user.create({ data: { username: name, role: UserRole.auditor } }),
      isUnique,
    );
    await assert.rejects(
      db.client.user.create({
        data: { username: `${name}-other`, email, role: UserRole.auditor },
      }),
      isUnique,
    );
  });

  it('removes the credential, recovery codes and sessions together with the user', async () => {
    const isolated = await createIsolatedDatabase(databaseUrl ?? '');
    try {
      const { client } = isolated.database;
      const user = await client.user.create({
        data: {
          username: `${prefix}-cascade`,
          role: UserRole.owner,
          credential: {
            create: {
              passwordHash: '$argon2id$placeholder',
              mfaSourceFailures: {
                create: {
                  sourceBucket: '192.0.2.1',
                  failures: 1,
                  windowEndsAt: new Date(Date.now() + 60_000),
                },
              },
            },
          },
          recoveryCodes: { create: [{ codeHash: 'a'.repeat(64) }, { codeHash: 'b'.repeat(64) }] },
          sessions: {
            create: [
              {
                tokenHash: 'c'.repeat(64),
                stage: SessionStage.active,
                expiresAt: new Date(Date.now() + 60_000),
                absoluteExpiresAt: new Date(Date.now() + 120_000),
                credentialEpoch: 0n,
                sourceBucket: 'unknown',
              },
            ],
          },
          passwordSourceFailures: {
            create: [
              {
                sourceBucket: '192.0.2.1',
                failures: 1,
                windowEndsAt: new Date(Date.now() + 60_000),
              },
            ],
          },
        },
      });
      assert.equal(await client.credential.count(), 1);
      assert.equal(await client.recoveryCode.count(), 2);
      assert.equal(await client.session.count(), 1);
      await client.user.delete({ where: { id: user.id } });
      assert.equal(await client.credential.count(), 0);
      assert.equal(await client.recoveryCode.count(), 0);
      assert.equal(await client.session.count(), 0);
      assert.equal(await client.passwordSourceFailure.count(), 0);
      assert.equal(await client.mfaSourceFailure.count(), 0);
    } finally {
      await isolated.drop();
    }
  });

  it('keeps one recovery code hash per user, and one session per token hash', async () => {
    const isolated = await createIsolatedDatabase(databaseUrl ?? '');
    try {
      const { client } = isolated.database;
      const user = await client.user.create({
        data: { username: `${prefix}-unique2`, role: UserRole.operator },
      });
      await client.recoveryCode.create({ data: { userId: user.id, codeHash: 'd'.repeat(64) } });
      await assert.rejects(
        client.recoveryCode.create({ data: { userId: user.id, codeHash: 'd'.repeat(64) } }),
      );
      const session = {
        userId: user.id,
        tokenHash: 'e'.repeat(64),
        stage: SessionStage.password_verified,
        expiresAt: new Date(),
        absoluteExpiresAt: new Date(),
        credentialEpoch: 0n,
        sourceBucket: 'unknown',
      };
      await client.session.create({ data: session });
      await assert.rejects(client.session.create({ data: session }));
    } finally {
      await isolated.drop();
    }
  });

  it('keeps the role set closed at the database level', async () => {
    await assert.rejects(
      db.client.$executeRaw`
        INSERT INTO users (id, username, role, updated_at)
        VALUES (gen_random_uuid(), ${`${prefix}-badrole`}, 'root'::user_role, now())`,
    );
  });

  it('keeps the audit log append-only, and keeps an event after its user is gone', async () => {
    const isolated = await createIsolatedDatabase(databaseUrl ?? '');
    try {
      const { client } = isolated.database;
      const user = await client.user.create({
        data: { username: `${prefix}-audited`, role: UserRole.operator },
      });
      const event = await client.auditEvent.create({
        data: {
          seq: 1n,
          occurredAt: new Date(),
          actorId: user.id,
          actorName: user.username,
          action: 'auth.login.succeeded',
          outcome: AuditOutcome.success,
          prevHash: '0'.repeat(64),
          hash: 'f'.repeat(64),
        },
      });
      assert.equal(event.details, '{}');
      const refused = (error: unknown): boolean =>
        error instanceof Error && error.message.includes('audit_events is append-only');
      await assert.rejects(
        client.auditEvent.update({ where: { seq: 1n }, data: { action: 'changed' } }),
        refused,
      );
      await assert.rejects(client.auditEvent.delete({ where: { seq: 1n } }), refused);
      await assert.rejects(client.auditEvent.deleteMany(), refused);
      // Raw SQL is not qualified by the client: name the schema of this test.
      await assert.rejects(
        client.$executeRawUnsafe(`TRUNCATE "${isolated.schema}"."audit_events"`),
        refused,
      );
      // No foreign key: removing the user neither fails nor removes the record.
      await client.user.delete({ where: { id: user.id } });
      const kept = await client.auditEvent.findUniqueOrThrow({ where: { seq: 1n } });
      assert.equal(kept.actorName, `${prefix}-audited`);
      // One hash, one place in the chain.
      await assert.rejects(
        client.auditEvent.create({
          data: {
            seq: 2n,
            occurredAt: new Date(),
            action: 'auth.logout',
            outcome: AuditOutcome.success,
            prevHash: 'f'.repeat(64),
            hash: 'f'.repeat(64),
          },
        }),
      );
    } finally {
      await isolated.drop();
    }
  });
});

describe('the server inventory against a migrated database', { skip: !databaseUrl }, () => {
  const FINGERPRINT = `SHA256:${'A'.repeat(43)}`;
  const secretData = (name: string, type: SecretType) => ({
    name,
    type,
    ciphertext: new Uint8Array([1]),
    wrappedDek: new Uint8Array([2]),
  });

  it('starts a server as a draft on port 22 and keeps its tags as a list', async () => {
    const isolated = await createIsolatedDatabase(databaseUrl ?? '');
    try {
      const { client } = isolated.database;
      const server = await client.server.create({
        data: { name: 'srv-a', address: '192.0.2.10', tags: ['edge', 'eu'] },
      });
      assert.equal(server.state, ServerState.draft);
      assert.equal(server.sshPort, 22);
      assert.equal(server.country, null);
      assert.deepEqual(server.tags, ['edge', 'eu']);
      const tagged = await client.server.findMany({ where: { tags: { has: 'eu' } } });
      assert.equal(tagged.length, 1);
      await assert.rejects(
        client.server.create({ data: { name: 'srv-a', address: '192.0.2.11' } }),
        (error: unknown) =>
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
      );
    } finally {
      await isolated.drop();
    }
  });

  it('refuses values the checks of the migration forbid', async () => {
    const isolated = await createIsolatedDatabase(databaseUrl ?? '');
    try {
      const { client } = isolated.database;
      await assert.rejects(
        client.server.create({ data: { name: 'p0', address: '192.0.2.1', sshPort: 0 } }),
      );
      await assert.rejects(
        client.server.create({ data: { name: 'p1', address: '192.0.2.1', sshPort: 65536 } }),
      );
      await assert.rejects(
        client.server.create({ data: { name: 'c1', address: '192.0.2.1', country: 'de' } }),
      );
      const server = await client.server.create({
        data: { name: 'ok', address: '192.0.2.1', country: 'DE', sshPort: 65535 },
      });
      await assert.rejects(
        client.serverHostKey.create({
          data: {
            serverId: server.id,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:short',
          },
        }),
      );
      const secret = await client.secret.create({
        data: secretData('pw', SecretType.ssh_password),
      });
      await assert.rejects(
        client.serverAccess.create({
          data: {
            serverId: server.id,
            method: AccessMethod.password,
            username: 'Root',
            secretId: secret.id,
          },
        }),
      );
    } finally {
      await isolated.drop();
    }
  });

  it('keeps a host key once per server and removes the children with the server', async () => {
    const isolated = await createIsolatedDatabase(databaseUrl ?? '');
    try {
      const { client } = isolated.database;
      const server = await client.server.create({ data: { name: 'srv', address: '192.0.2.20' } });
      const other = await client.server.create({ data: { name: 'srv2', address: '192.0.2.21' } });
      const key = { algorithm: 'ssh-ed25519', fingerprintSha256: FINGERPRINT };
      await client.serverHostKey.create({ data: { serverId: server.id, ...key } });
      await assert.rejects(client.serverHostKey.create({ data: { serverId: server.id, ...key } }));
      // The same key may be pinned on another server.
      await client.serverHostKey.create({ data: { serverId: other.id, ...key } });
      const hostKey = await client.serverHostKey.findFirstOrThrow({
        where: { serverId: server.id },
      });
      assert.equal(hostKey.source, 'manual');

      const secret = await client.secret.create({ data: secretData('key', SecretType.ssh_key) });
      await client.serverAccess.create({
        data: {
          serverId: server.id,
          method: AccessMethod.key,
          username: 'deploy',
          secretId: secret.id,
        },
      });
      await client.serverFact.create({
        data: { serverId: server.id, facts: { os: 'x' }, collectedAt: new Date(), source: 'ssh' },
      });
      await client.server.delete({ where: { id: server.id } });
      assert.equal(await client.serverHostKey.count({ where: { serverId: server.id } }), 0);
      assert.equal(await client.serverAccess.count(), 0);
      assert.equal(await client.serverFact.count(), 0);
      assert.equal(await client.serverHostKey.count(), 1, 'the other server keeps its key');
      assert.equal(await client.secret.count(), 1, 'a secret outlives the server that used it');
    } finally {
      await isolated.drop();
    }
  });

  it('refuses to delete a secret that an access entry or a sudo entry names', async () => {
    const isolated = await createIsolatedDatabase(databaseUrl ?? '');
    try {
      const { client } = isolated.database;
      const server = await client.server.create({ data: { name: 'srv', address: '192.0.2.30' } });
      const login = await client.secret.create({
        data: secretData('login', SecretType.ssh_password),
      });
      const sudo = await client.secret.create({
        data: secretData('sudo', SecretType.ssh_password),
      });
      const free = await client.secret.create({ data: secretData('free', SecretType.generic) });
      await client.serverAccess.create({
        data: {
          serverId: server.id,
          method: AccessMethod.password,
          username: 'root',
          secretId: login.id,
          sudoSecretId: sudo.id,
        },
      });
      const restricted = (error: unknown): boolean =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      await assert.rejects(client.secret.delete({ where: { id: login.id } }), restricted);
      await assert.rejects(client.secret.delete({ where: { id: sudo.id } }), restricted);
      await client.secret.delete({ where: { id: free.id } });
    } finally {
      await isolated.drop();
    }
  });
});

describe('the artifacts on servers against a migrated database', { skip: !databaseUrl }, () => {
  const SHA = 'a'.repeat(64);
  const base = {
    name: 'node-installer',
    version: '1.0.0',
    sha256: SHA,
    size: 100,
    remotePath: '/home/deploy/.swellwright/artifacts/node-installer/1.0.0/install.sh',
    pushedAt: new Date(),
  };

  it('keeps one copy of a version per server, goes with its server, and defaults to the home of the login', async () => {
    const isolated = await createIsolatedDatabase(databaseUrl ?? '');
    try {
      const { client } = isolated.database;
      const server = await client.server.create({ data: { name: 'srv', address: '192.0.2.10' } });
      const copy = await client.serverArtifact.create({ data: { serverId: server.id, ...base } });
      assert.equal(copy.destination, ArtifactDestination.user);
      assert.equal(copy.verifyState, null);
      assert.equal(copy.verifiedAt, null);
      await assert.rejects(
        client.serverArtifact.create({ data: { serverId: server.id, ...base } }),
        (error: unknown) =>
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
      );
      // Another version, and the same version on another server, are other copies.
      await client.serverArtifact.create({
        data: { serverId: server.id, ...base, version: '1.1.0' },
      });
      const other = await client.server.create({ data: { name: 'srv2', address: '192.0.2.11' } });
      await client.serverArtifact.create({ data: { serverId: other.id, ...base } });
      await client.server.delete({ where: { id: server.id } });
      assert.equal(await client.serverArtifact.count({ where: { serverId: server.id } }), 0);
      assert.equal(await client.serverArtifact.count({ where: { serverId: other.id } }), 1);
    } finally {
      await isolated.drop();
    }
  });

  it('refuses values the checks of the migration forbid', async () => {
    const isolated = await createIsolatedDatabase(databaseUrl ?? '');
    try {
      const { client } = isolated.database;
      const server = await client.server.create({ data: { name: 'srv', address: '192.0.2.10' } });
      const create = (data: Partial<Prisma.ServerArtifactUncheckedCreateInput>) =>
        client.serverArtifact.create({ data: { serverId: server.id, ...base, ...data } });
      for (const bad of [
        { name: 'Node' },
        { name: '-node' },
        { sha256: 'abc' },
        { sha256: 'A'.repeat(64) },
        { size: 0 },
        { remotePath: 'relative/path' },
        { remotePath: '/with\nnewline' },
        // A check that was done must say what it saw: a hash unless the file was missing.
        { verifiedAt: new Date(), verifyState: ArtifactCheckState.ok },
        { verifiedAt: new Date(), verifyState: ArtifactCheckState.missing, remoteSha256: SHA },
        { verifyState: ArtifactCheckState.ok, remoteSha256: SHA },
        { verifiedAt: new Date(), verifyState: ArtifactCheckState.differs, remoteSha256: 'xyz' },
      ]) {
        await assert.rejects(create(bad), JSON.stringify(bad));
      }
      const checked = await create({
        version: '2.0.0',
        verifiedAt: new Date(),
        verifyState: ArtifactCheckState.missing,
        destination: ArtifactDestination.system,
        remotePath: '/var/lib/swellwright/artifacts/node-installer/2.0.0/install.sh',
      });
      assert.equal(checked.remoteSha256, null);
      await create({
        version: '3.0.0',
        verifiedAt: new Date(),
        verifyState: ArtifactCheckState.differs,
        remoteSha256: 'b'.repeat(64),
      });
    } finally {
      await isolated.drop();
    }
  });
});
