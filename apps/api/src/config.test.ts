import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from './config.js';

describe('configuration', () => {
  it('has safe defaults: loopback only, no dependencies, response validation on', () => {
    const c = loadConfig({}, '1.2.3');
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.port, 3000);
    assert.equal(c.databaseUrl, undefined);
    assert.equal(c.valkeyUrl, undefined);
    assert.equal(c.validateResponses, true);
    assert.equal(c.version, '1.2.3');
  });

  it('turns response validation off in production unless asked for', () => {
    assert.equal(loadConfig({ NODE_ENV: 'production' }, 'v').validateResponses, false);
    assert.equal(
      loadConfig({ NODE_ENV: 'production', SW_VALIDATE_RESPONSES: 'true' }, 'v').validateResponses,
      true,
    );
  });

  it('treats empty values as not set', () => {
    const c = loadConfig({ SW_DATABASE_URL: '', SW_VALKEY_URL: '' }, 'v');
    assert.equal(c.databaseUrl, undefined);
    assert.equal(c.valkeyUrl, undefined);
  });

  it('prefers SW_VERSION and reads the commit', () => {
    const c = loadConfig({ SW_VERSION: '9.9.9', SW_COMMIT: 'abc1234' }, '1.2.3');
    assert.equal(c.version, '9.9.9');
    assert.equal(c.commit, 'abc1234');
  });

  it('reads what the build recorded and builds the commit link from the repository', () => {
    const none = loadConfig({}, 'v');
    assert.deepEqual(none.build, { time: null, number: null });
    assert.deepEqual(none.git, { branch: null, commit: null, commitUrl: null });
    const c = loadConfig(
      {
        SW_BUILD_TIME: '2026-11-19T10:00:00Z',
        SW_BUILD_NUMBER: ' 42 ',
        SW_GIT_BRANCH: 'main',
        SW_GIT_COMMIT: '0123456789abcdef0123456789abcdef01234567',
      },
      'v',
    );
    assert.deepEqual(c.build, { time: '2026-11-19T10:00:00Z', number: '42' });
    assert.equal(c.git.branch, 'main');
    assert.equal(
      c.git.commitUrl,
      'https://github.com/swellwright/swellwright/commit/0123456789abcdef0123456789abcdef01234567',
    );
    const fork = loadConfig({ SW_GIT_COMMIT: 'abc1234', SW_REPOSITORY: 'someone/fork' }, 'v');
    assert.equal(fork.git.commitUrl, 'https://github.com/someone/fork/commit/abc1234');
    assert.equal(fork.repositoryUrl, 'https://github.com/someone/fork');
  });

  it('treats empty build values as not set and builds no link from text that is not a hash', () => {
    const empty = loadConfig(
      { SW_BUILD_TIME: '', SW_BUILD_NUMBER: '  ', SW_GIT_BRANCH: '', SW_GIT_COMMIT: '' },
      'v',
    );
    assert.deepEqual(empty.build, { time: null, number: null });
    assert.deepEqual(empty.git, { branch: null, commit: null, commitUrl: null });
    const odd = loadConfig({ SW_GIT_COMMIT: 'not a hash/../x' }, 'v');
    assert.equal(odd.git.commit, 'not a hash/../x');
    assert.equal(odd.git.commitUrl, null);
    assert.equal(loadConfig({ SW_GIT_BRANCH: 'x'.repeat(400) }, 'v').git.branch?.length, 255);
  });

  it('uses SW_COMMIT for the revision when SW_GIT_COMMIT is missing, except the image placeholder', () => {
    assert.equal(loadConfig({ SW_COMMIT: 'abc1234' }, 'v').git.commit, 'abc1234');
    assert.equal(
      loadConfig({ SW_COMMIT: 'abc1234', SW_GIT_COMMIT: 'def5678' }, 'v').git.commit,
      'def5678',
    );
    assert.equal(loadConfig({ SW_COMMIT: 'unknown' }, 'v').git.commit, null);
    assert.equal(
      loadConfig({ SW_COMMIT: 'unknown' }, 'v').commit,
      'unknown',
      'commit is unchanged',
    );
  });

  it('rejects an invalid port and a malformed URL with a readable message', () => {
    assert.throws(() => loadConfig({ SW_HTTP_PORT: '70000' }, 'v'), /SW_HTTP_PORT/u);
    assert.throws(() => loadConfig({ SW_DATABASE_URL: 'not a url' }, 'v'), /SW_DATABASE_URL/u);
  });
});

describe('sign-in configuration', () => {
  const DB = 'postgresql://sw:pw@127.0.0.1:5432/sw';
  const KEY = Buffer.alloc(32, 9).toString('base64');

  it('makes a temporary authentication key outside production and says so', () => {
    const a = loadConfig({}, 'v');
    const b = loadConfig({}, 'v');
    assert.equal(a.authKey.length, 32);
    assert.equal(a.authKeyEphemeral, true);
    assert.notDeepEqual(a.authKey, b.authKey);
  });

  it('reads a configured key', () => {
    const c = loadConfig({ SW_AUTH_KEY: KEY }, 'v');
    assert.equal(c.authKeyEphemeral, false);
    assert.deepEqual(c.authKey, Buffer.alloc(32, 9));
  });

  it('rejects a key of the wrong size without printing it', () => {
    const short = Buffer.alloc(16, 9).toString('base64');
    assert.throws(() => loadConfig({ SW_AUTH_KEY: short }, 'v'), /SW_AUTH_KEY must be 32/u);
    try {
      loadConfig({ SW_AUTH_KEY: short }, 'v');
    } catch (error) {
      assert.ok(!(error as Error).message.includes(short));
    }
  });

  it('requires the key in production when a database is configured', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', SW_DATABASE_URL: DB }, 'v'),
      /SW_AUTH_KEY is required/u,
    );
    assert.doesNotThrow(() =>
      loadConfig({ NODE_ENV: 'production', SW_DATABASE_URL: DB, SW_AUTH_KEY: KEY }, 'v'),
    );
    assert.doesNotThrow(
      () => loadConfig({ NODE_ENV: 'production' }, 'v'),
      'no database, no sign-in',
    );
  });

  it('marks the cookie Secure in production by default and lets the setting override it', () => {
    assert.equal(loadConfig({}, 'v').cookieSecure, false);
    assert.equal(loadConfig({ NODE_ENV: 'production' }, 'v').cookieSecure, true);
    assert.equal(
      loadConfig({ NODE_ENV: 'production', SW_COOKIE_SECURE: 'false' }, 'v').cookieSecure,
      false,
    );
    assert.equal(loadConfig({ SW_COOKIE_SECURE: 'true' }, 'v').cookieSecure, true);
  });

  it('has session and lockout defaults and bounds them', () => {
    const c = loadConfig({}, 'v');
    assert.equal(c.sessionIdleMs, 120 * 60_000);
    assert.equal(c.sessionMaxMs, 12 * 3_600_000);
    assert.equal(c.lockoutAttempts, 5);
    assert.equal(c.lockoutMs, 15 * 60_000);
    assert.equal(c.stepUpMs, 5 * 60_000, 'the elevation window is five minutes by default');
    assert.equal(loadConfig({ SW_STEP_UP_MINUTES: '30' }, 'v').stepUpMs, 30 * 60_000);
    assert.deepEqual(c.vaultKdf, { memoryKib: 256 * 1024, passes: 3, parallelism: 1 });
    assert.equal(
      loadConfig({ SW_VAULT_KDF_MEMORY_MIB: '1024', SW_VAULT_KDF_PASSES: '4' }, 'v').vaultKdf
        .passes,
      4,
    );
    for (const bad of [{ SW_VAULT_KDF_MEMORY_MIB: '8' }, { SW_VAULT_KDF_PASSES: '0' }]) {
      assert.throws(() => loadConfig(bad, 'v'), /SW_VAULT_KDF/u);
    }
    for (const bad of ['0', '31', 'soon']) {
      assert.throws(() => loadConfig({ SW_STEP_UP_MINUTES: bad }, 'v'), /SW_STEP_UP_MINUTES/u);
    }
    assert.throws(() => loadConfig({ SW_LOCKOUT_ATTEMPTS: '1' }, 'v'), /SW_LOCKOUT_ATTEMPTS/u);
    assert.throws(
      () => loadConfig({ SW_SESSION_IDLE_MINUTES: '1' }, 'v'),
      /SW_SESSION_IDLE_MINUTES/u,
    );
  });

  it('takes allowed origins as a comma-separated list of origins only', () => {
    const c = loadConfig(
      { SW_ALLOWED_ORIGINS: 'https://a.example.com, http://localhost:5173' },
      'v',
    );
    assert.deepEqual(c.allowedOrigins, ['https://a.example.com', 'http://localhost:5173']);
    assert.deepEqual(loadConfig({}, 'v').allowedOrigins, []);
    assert.throws(
      () => loadConfig({ SW_ALLOWED_ORIGINS: 'https://a.example.com/path' }, 'v'),
      /origins like/u,
    );
    assert.throws(() => loadConfig({ SW_ALLOWED_ORIGINS: 'a.example.com' }, 'v'), /origins like/u);
  });

  it('wants a long fixed setup token or none', () => {
    assert.equal(loadConfig({ SW_SETUP_TOKEN: 'x'.repeat(16) }, 'v').setupToken, 'x'.repeat(16));
    assert.equal(loadConfig({ SW_SETUP_TOKEN: '' }, 'v').setupToken, undefined);
    assert.throws(() => loadConfig({ SW_SETUP_TOKEN: 'short' }, 'v'), /SW_SETUP_TOKEN/u);
  });
});

describe('update check configuration', () => {
  it('is on by default, asks GitHub and the project repository', () => {
    const c = loadConfig({}, 'v');
    assert.deepEqual(c.updateCheck, { enabled: true, apiBase: 'https://api.github.com' });
    assert.equal(c.repository, 'swellwright/swellwright');
    assert.equal(c.repositoryUrl, 'https://github.com/swellwright/swellwright');
  });

  it('is switched off with off (and the usual spellings), empty means the default', () => {
    for (const off of ['off', 'OFF', 'false', '0', 'no']) {
      assert.equal(loadConfig({ SW_UPDATE_CHECK: off }, 'v').updateCheck.enabled, false, off);
    }
    for (const on of ['on', 'true', '1', '']) {
      assert.equal(loadConfig({ SW_UPDATE_CHECK: on }, 'v').updateCheck.enabled, true, on);
    }
    assert.throws(() => loadConfig({ SW_UPDATE_CHECK: 'sometimes' }, 'v'), /SW_UPDATE_CHECK/u);
  });

  it('takes only owner/name as the repository', () => {
    assert.equal(loadConfig({ SW_REPOSITORY: 'a/b' }, 'v').repository, 'a/b');
    assert.equal(
      loadConfig({ SW_REPOSITORY: 'my-org/my.repo_2' }, 'v').repository,
      'my-org/my.repo_2',
    );
    assert.equal(loadConfig({ SW_REPOSITORY: '' }, 'v').repository, 'swellwright/swellwright');
    for (const bad of [
      'swellwright',
      'a/b/c',
      '/b',
      'a/',
      '-a/b',
      'a-/b',
      'a b/c',
      'a/b c',
      'a/..',
      'a/.',
      'https://github.com/a/b',
      'a/b?x=1',
      'a/b#x',
      '../b',
      `${'a'.repeat(40)}/b`,
    ]) {
      assert.throws(() => loadConfig({ SW_REPOSITORY: bad }, 'v'), /SW_REPOSITORY/u, bad);
    }
  });

  it('wants an https API address, or http on the same machine', () => {
    assert.equal(
      loadConfig({ SW_UPDATE_API_BASE: 'https://github.example.org/api/v3/' }, 'v').updateCheck
        .apiBase,
      'https://github.example.org/api/v3',
    );
    for (const ok of ['http://127.0.0.1:8080', 'http://localhost:9', 'http://[::1]:1234']) {
      assert.equal(loadConfig({ SW_UPDATE_API_BASE: ok }, 'v').updateCheck.apiBase, ok);
    }
    for (const bad of [
      'http://api.github.com',
      'http://example.org',
      'ftp://127.0.0.1',
      'api.github.com',
      ['https://user:pw', 'api.github.com'].join(String.fromCharCode(64)),
      'https://api.github.com/?x=1',
      'https://api.github.com/#x',
    ]) {
      assert.throws(() => loadConfig({ SW_UPDATE_API_BASE: bad }, 'v'), /SW_UPDATE_API_BASE/u, bad);
    }
  });

  it('finds the built-in artifacts of the repository by default and lets the installation move them', () => {
    const defaults = loadConfig({}, 'v').artifacts;
    assert.match(defaults.directory.replaceAll('\\', '/'), /\/artifacts$/u);
    assert.equal(defaults.maxBytes, 64 * 1024 * 1024);
    assert.equal(defaults.rateLimitPerMinute, 10);
    const moved = loadConfig(
      {
        SW_ARTIFACTS_DIR: '/srv/swellwright/artifacts',
        SW_ARTIFACT_MAX_BYTES: '1048576',
        SW_ARTIFACT_RATE_LIMIT_PER_MINUTE: '3',
      },
      'v',
    ).artifacts;
    assert.match(moved.directory.replaceAll('\\', '/'), /\/srv\/swellwright\/artifacts$/u);
    assert.equal(moved.maxBytes, 1048576);
    assert.equal(moved.rateLimitPerMinute, 3);
    // An empty variable is "not set"; a size that makes no sense is refused at start.
    assert.match(loadConfig({ SW_ARTIFACTS_DIR: '' }, 'v').artifacts.directory, /artifacts$/u);
    for (const bad of ['0', '100', '-1', 'big', String(1024 * 1024 * 1024)]) {
      assert.throws(
        () => loadConfig({ SW_ARTIFACT_MAX_BYTES: bad }, 'v'),
        /SW_ARTIFACT_MAX_BYTES/u,
        bad,
      );
    }
  });
});

describe('snapshot configuration', () => {
  it('keeps 50 snapshots, takes one a day and allows 32 MiB by default', () => {
    const { panel } = loadConfig({}, 'v');
    assert.equal(panel.snapshotKeep, 50);
    assert.equal(panel.snapshotIntervalMs, 24 * 3_600_000);
    assert.equal(panel.snapshotMaxBytes, 32 * 1024 * 1024);
  });

  it('switches the job off with 0, reads fractions of an hour, and bounds every value', () => {
    assert.equal(
      loadConfig({ SW_PANEL_SNAPSHOT_INTERVAL_HOURS: '0' }, 'v').panel.snapshotIntervalMs,
      0,
    );
    assert.equal(
      loadConfig({ SW_PANEL_SNAPSHOT_INTERVAL_HOURS: '0.5' }, 'v').panel.snapshotIntervalMs,
      1_800_000,
    );
    assert.equal(loadConfig({ SW_PANEL_SNAPSHOT_KEEP: '7' }, 'v').panel.snapshotKeep, 7);
    assert.equal(
      loadConfig({ SW_PANEL_SNAPSHOT_MAX_MIB: '1' }, 'v').panel.snapshotMaxBytes,
      1024 * 1024,
    );
    for (const bad of [
      { SW_PANEL_SNAPSHOT_KEEP: '0' },
      { SW_PANEL_SNAPSHOT_KEEP: '1001' },
      { SW_PANEL_SNAPSHOT_INTERVAL_HOURS: '-1' },
      { SW_PANEL_SNAPSHOT_INTERVAL_HOURS: '0.001' },
      { SW_PANEL_SNAPSHOT_INTERVAL_HOURS: '721' },
      { SW_PANEL_SNAPSHOT_MAX_MIB: '0' },
    ]) {
      assert.throws(() => loadConfig(bad, 'v'), /Invalid configuration/u, JSON.stringify(bad));
    }
  });
});
