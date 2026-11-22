// A dependency-free preflight. No network, environment-file loading or mutations.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const require = createRequire(new URL('package.json', root));
let failures = 0;
function check(ok, message) {
  console.log(`${ok ? 'OK' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}
check(
  process.versions.node.split('.')[0] === '26',
  `Node ${process.versions.node} (requires 26.x)`,
);
const wanted = manifest.packageManager.replace('pnpm@', '');
const actual = process.env.npm_config_user_agent?.match(/pnpm\/([^ ]+)/u)?.[1];
check(
  actual === wanted,
  `pnpm ${actual ?? 'unknown: run through pnpm run doctor'} (requires ${wanted})`,
);
for (const name of ['typescript', 'turbo', 'eslint', 'prettier']) {
  try {
    require.resolve(`${name}/package.json`);
    check(true, `${name} resolves`);
  } catch {
    check(false, `${name} missing or broken junction: reinstall with the frozen lockfile`);
  }
}
try {
  const fromApi = createRequire(new URL('apps/api/package.json', root));
  const resolved = fromApi.resolve('@swellwright/db');
  check(
    resolved.startsWith(fileURLToPath(root)),
    'API resolves @swellwright/db inside this checkout',
  );
} catch {
  // A fresh install has no dist until the first build. Check the workspace manifest instead.
  try {
    const db = JSON.parse(
      readFileSync(new URL('apps/api/node_modules/@swellwright/db/package.json', root), 'utf8'),
    );
    check(
      db.name === '@swellwright/db',
      'API workspace link exists (build output may not exist yet)',
    );
  } catch {
    check(false, 'API workspace link missing or broken');
  }
}
console.log(
  `Database tests: ${process.env.SW_TEST_DATABASE_URL ? 'configured (not probed)' : 'not configured; will skip'}`,
);
console.log(
  `Valkey tests: ${process.env.SW_TEST_VALKEY_URL ? 'configured (not probed)' : 'not configured; will skip'}`,
);
console.log(
  `POSIX SSH tests: ${process.platform === 'win32' ? 'require Linux; Windows skips shell suites' : 'require POSIX tools; real sshd is a separate suite'}`,
);
process.exitCode = failures ? 1 : 0;
