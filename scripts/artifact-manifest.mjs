// Builds or checks the manifest of every artifact under artifacts/ (see artifacts/README.md).
//
//   node scripts/artifact-manifest.mjs build     rewrite manifest.json and the generated tables of README.md, and record a
//                                                new version in releases.json
//   node scripts/artifact-manifest.mjs --check   fail when either differs from what install.sh says, or when the bytes of a
//                                                version differ from the bytes recorded for it
//
// install.sh is the single source of truth. Its `#@meta`, `#@step` and `#@param` lines (one JSON object each) describe the
// steps and the parameters; a pattern or default written as "@NAME" takes its text from the assignment `NAME=...` in the
// script, so the validators the script runs and the patterns the manifest publishes are the same text. The size and the
// SHA-256 are computed from the bytes of the file as they are on disk. Nothing here has dependencies.
//
// A version is bound to its bytes. releases.json records the SHA-256 and the size of every version that was built, and it
// only grows after merge: build can refresh a version not yet in the base, and --check
// fails when the current version is not recorded or is recorded with other bytes. --check also compares with a base
// revision of the repository (SW_ARTIFACT_BASE_REF, by default origin/main when it exists; CI sets the target branch of a
// pull request): every version recorded there, and the version of the manifest there, must be recorded here with the same
// bytes, so neither a changed script nor an edited releases.json can give one version two contents.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// SW_ARTIFACTS_ROOT is for the tests of this tool (a copy of an artifact directory in a temporary place).
const root = env.SW_ARTIFACTS_ROOT
  ? join(resolvePath(env.SW_ARTIFACTS_ROOT), '/')
  : fileURLToPath(new URL('../artifacts/', import.meta.url));
const SCRIPT = 'install.sh';
const MANIFEST = 'manifest.json';
const README = 'README.md';
const RELEASES = 'releases.json';

class ArtifactError extends Error {}
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function fail(message) {
  throw new ArtifactError(message);
}

/** The text of `NAME=value` (quoted or a bare word) at the start of a line of the script. */
function constantOf(script, name) {
  const line = script.split('\n').find((l) => l.startsWith(`${name}=`));
  if (line === undefined) fail(`${SCRIPT}: the constant ${name} is referenced but not assigned`);
  const value = line.slice(name.length + 1);
  const quoted = /^'([^']*)'$/.exec(value) ?? /^"([^"$`\\]*)"$/.exec(value);
  if (quoted) return quoted[1];
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
  return fail(
    `${SCRIPT}: ${name} must be quoted without $ or \` inside, or a bare word, to be used in the manifest`,
  );
}

function resolve(script, value) {
  if (typeof value === 'string' && value.startsWith('@')) return constantOf(script, value.slice(1));
  return value;
}

function jsonLines(script, tag) {
  const out = [];
  script.split('\n').forEach((line, i) => {
    if (!line.startsWith(`#@${tag} `)) return;
    try {
      out.push(JSON.parse(line.slice(tag.length + 3)));
    } catch (e) {
      fail(`${SCRIPT}:${String(i + 1)}: #@${tag} is not valid JSON (${e.message})`);
    }
  });
  return out;
}

const STEP_KEYS = ['id', 'title', 'readOnly', 'needsRoot', 'inFull', 'params', 'requires'];

function checkStep(step) {
  for (const k of STEP_KEYS) if (!(k in step)) fail(`step ${step.id ?? '?'}: "${k}" is missing`);
  for (const k of ['readOnly', 'needsRoot', 'inFull'])
    if (typeof step[k] !== 'boolean') fail(`step ${step.id}: "${k}" must be true or false`);
  if (!/^[a-z][a-z0-9]*$/.test(step.id))
    fail(`step id ${step.id}: lower-case letters and digits only`);
}

function checkParam(p, script) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(p.name ?? ''))
    fail(`parameter name ${String(p.name)} is not upper case`);
  if (!['node', 'installer'].includes(p.group))
    fail(`parameter ${p.name}: group must be node or installer`);
  if (typeof p.secret !== 'boolean') fail(`parameter ${p.name}: secret must be true or false`);
  if (typeof p.description !== 'string' || p.description === '')
    fail(`parameter ${p.name}: description is missing`);
  if ('pattern' in p && 'enum' in p) fail(`parameter ${p.name}: pattern and enum are exclusive`);
  if ('pattern' in p) new RegExp(resolve(script, p.pattern)); // must at least compile as a JavaScript regular expression
}

/** Everything the manifest says, computed from the bytes of the script (and its text, which must be UTF-8). */
function buildManifest(bytes) {
  const script = bytes.toString('utf8');
  if (!Buffer.from(script, 'utf8').equals(bytes)) fail(`${SCRIPT} is not valid UTF-8`);
  if (script.includes('\r'))
    fail(`${SCRIPT} contains a carriage return: it must have LF line endings`);
  if (!script.startsWith('#!/bin/sh\n')) fail(`${SCRIPT} must start with #!/bin/sh`);
  if (!script.endsWith('\n')) fail(`${SCRIPT} must end with a newline`);
  const version = /^INSTALLER_VERSION=(\d+\.\d+\.\d+)$/m.exec(script)?.[1];
  if (!VERSION.test(version ?? ''))
    fail(`${SCRIPT}: INSTALLER_VERSION=major.minor.patch is missing or invalid`);
  const metas = jsonLines(script, 'meta');
  if (metas.length !== 1) fail(`${SCRIPT}: exactly one #@meta line is expected`);
  const meta = metas[0];
  const steps = jsonLines(script, 'step');
  const params = jsonLines(script, 'param');
  steps.forEach(checkStep);
  params.forEach((p) => {
    checkParam(p, script);
  });

  const names = params.map((p) => p.name);
  if (new Set(names).size !== names.length) fail('a parameter is declared twice');
  const ids = steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) fail('a step is declared twice');

  // The steps are functions and are reachable by name.
  for (const id of ids) {
    if (!script.includes(`\nstep_${id}() {`)) fail(`step ${id}: there is no function step_${id}`);
  }
  const accepted = /^ {8}menu\|full\|redeploy\|(.+)\) ;;$/m.exec(script)?.[1].split('|') ?? [];
  const missing = ids.filter((id) => !accepted.includes(id));
  if (missing.length > 0) fail(`the action check of main does not accept: ${missing.join(' ')}`);

  // What full runs, the parameters the script reads from files, what it saves: the lists in the script and the metadata agree.
  const phases = steps.filter((s) => s.inFull).map((s) => s.id);
  if (constantOf(script, 'PHASES') !== phases.join(' '))
    fail(
      `PHASES is "${constantOf(script, 'PHASES')}" but the steps with inFull say "${phases.join(' ')}"`,
    );
  const nodeNames = params.filter((p) => p.group === 'node').map((p) => p.name);
  if (constantOf(script, 'PARAM_NAMES') !== nodeNames.join(' '))
    fail('PARAM_NAMES does not list the parameters of the group node, in order');
  // Every secret can be given as a file: the script lists its secrets (SECRET_PARAMS), and each has a declared NAME_FILE
  // parameter, which is not itself a secret (it is a path), so that a caller can hand a secret over without putting it in an
  // environment variable.
  const secrets = params.filter((p) => p.secret).map((p) => p.name);
  if (constantOf(script, 'SECRET_PARAMS') !== secrets.join(' '))
    fail(
      `SECRET_PARAMS is "${constantOf(script, 'SECRET_PARAMS')}" but the parameters with secret: true are "${secrets.join(' ')}"`,
    );
  for (const n of secrets) {
    const file = params.find((p) => p.name === `${n}_FILE`);
    if (file === undefined) fail(`secret parameter ${n}: ${n}_FILE is not declared`);
    if (file.secret) fail(`${n}_FILE is a path, not a secret`);
  }
  const saved = constantOf(script, 'SAVED_PARAMS').split(' ').filter(Boolean);
  for (const n of saved)
    if (!nodeNames.includes(n))
      fail(`SAVED_PARAMS names ${n}, which is not a parameter of the group node`);
  for (const s of steps) {
    for (const n of s.params) if (!names.includes(n)) fail(`step ${s.id}: unknown parameter ${n}`);
    for (const n of s.requires)
      if (!s.params.includes(n)) fail(`step ${s.id}: ${n} is required but not in params`);
  }
  const required = new Set(steps.flatMap((s) => s.requires));

  const outParams = {};
  for (const p of params) {
    const entry = {
      group: p.group,
      description: p.description,
      required: required.has(p.name),
      secret: p.secret,
    };
    if ('pattern' in p) entry.pattern = resolve(script, p.pattern);
    if ('enum' in p) entry.enum = p.enum;
    entry.default = 'default' in p ? resolve(script, p.default) : null;
    if ('example' in p) entry.example = p.example;
    outParams[p.name] = entry;
  }

  return {
    manifestVersion: 1,
    name: meta.name,
    version,
    description: meta.description,
    file: SCRIPT,
    interpreter: meta.interpreter,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    minOs: meta.minOs,
    steps: steps.map((s) => Object.fromEntries(STEP_KEYS.map((k) => [k, s[k]]))),
    params: outParams,
  };
}

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');
const code = (text) => `\`${String(text)}\``;

/** The two tables of the README, generated from the manifest. */
function renderTables(manifest) {
  const steps = [
    '| Step | What it does | Changes the server | In `full` | Parameters |',
    '| --- | --- | --- | --- | --- |',
    ...manifest.steps.map((s) =>
      [
        code(s.id),
        cell(s.title),
        s.readOnly ? 'no (read-only)' : 'yes',
        s.inFull ? 'yes' : 'no',
        cell(s.params.map((n) => (s.requires.includes(n) ? `**${n}**` : n)).join(', ') || '-'),
      ]
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |'),
    ),
  ];
  const rows = (group) =>
    Object.entries(manifest.params)
      .filter(([, p]) => p.group === group)
      .map(([name, p]) => {
        const format = p.enum
          ? p.enum.map(code).join(', ')
          : p.example !== undefined
            ? code(p.example)
            : '-';
        const dflt = p.default === null ? '-' : code(p.default);
        return `| ${[code(name), p.required ? 'yes' : 'no', dflt, format, p.secret ? 'yes' : 'no', cell(p.description)].join(' | ')} |`;
      });
  const head = [
    '| Parameter | Required by a step | Default | Format or values | Secret | Meaning |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  return {
    steps: steps.join('\n'),
    nodeParams: [...head, ...rows('node')].join('\n'),
    installerParams: [...head, ...rows('installer')].join('\n'),
  };
}

const SECTIONS = ['steps', 'nodeParams', 'installerParams'];

function replaceSection(readme, name, body) {
  const begin = `<!-- manifest:${name}:begin -->`;
  const end = `<!-- manifest:${name}:end -->`;
  const from = readme.indexOf(begin);
  const to = readme.indexOf(end);
  if (from < 0 || to < from) fail(`${README}: the markers ${begin} and ${end} are missing`);
  return `${readme.slice(0, from + begin.length)}\n${body}\n${readme.slice(to)}`;
}

/** The versions recorded in a releases.json text: { "1.0.0": { sha256, size }, ... } ({} for an empty text). */
function readReleases(text, where) {
  if (text === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    fail(`${where}: ${RELEASES} is not valid JSON (${e.message})`);
  }
  const versions = parsed?.versions;
  if (typeof versions !== 'object' || versions === null || Array.isArray(versions))
    fail(`${where}: ${RELEASES} has no "versions" object`);
  for (const [v, r] of Object.entries(versions)) {
    if (
      !VERSION.test(v) ||
      typeof r?.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(r.sha256) ||
      !Number.isSafeInteger(r.size) ||
      r.size < 1
    )
      fail(`${where}: ${RELEASES}: the entry ${v} is not { "sha256": "<hex>", "size": <bytes> }`);
  }
  return versions;
}

const releasesText = (versions) => `${JSON.stringify({ versions }, null, 2)}\n`;

function compareVersions(a, b) {
  const x = a.split('.').map(BigInt);
  const y = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function git(args, encoding = 'utf8') {
  return execFileSync('git', ['-C', root, ...args], {
    encoding,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

function hasRevision(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The revision --check compares with: SW_ARTIFACT_BASE_REF (it must exist), else origin/main when it exists, else none. */
function baseRevision() {
  const asked = env.SW_ARTIFACT_BASE_REF;
  if (asked) {
    if (!hasRevision(asked))
      fail(`SW_ARTIFACT_BASE_REF=${asked} is not a revision of this repository (fetch it first)`);
    return asked;
  }
  return hasRevision('origin/main') ? 'origin/main' : null;
}

/** The text of a file of an artifact directory at a revision, or null when it is not there. */
function atRevision(ref, path, encoding = 'utf8') {
  const fullPath = `${git(['rev-parse', '--show-prefix']).trimEnd()}${path}`;
  let entry;
  try {
    entry = git(['ls-tree', '-z', '--full-tree', ref, '--', `:(literal)${fullPath}`]);
  } catch {
    fail(`cannot list ${fullPath} at ${ref}`);
  }
  if (entry === '') return null;
  const oid = /^100[67][0-7]{2} blob ([a-f0-9]{40,64})\t/.exec(entry)?.[1];
  if (!oid) fail(`expected a regular file for ${fullPath} at ${ref}`);
  try {
    return git(['cat-file', 'blob', oid], encoding);
  } catch {
    fail(`cannot read ${fullPath} at ${ref}: Git blob is missing or unreadable`);
  }
}

/** Whether the base revision has this version: recorded in its releases.json, or the version of its manifest. */
function publishedAt(ref, label, version) {
  const theirs = atRevision(ref, `${label}/${RELEASES}`);
  if (theirs !== null && readReleases(theirs, `${label} at ${ref}`)[version] !== undefined)
    return true;
  const manifest = atRevision(ref, `${label}/${MANIFEST}`);
  if (manifest === null) return false;
  try {
    return JSON.parse(manifest).version === version;
  } catch {
    return false;
  }
}

/** What the base revision says about versions and bytes that this checkout contradicts. */
function baseProblems(ref, label, versions) {
  const problems = [];
  const theirs = atRevision(ref, `${label}/${RELEASES}`);
  if (theirs !== null) {
    for (const [v, r] of Object.entries(readReleases(theirs, `${label} at ${ref}`))) {
      const here = versions[v];
      if (here === undefined)
        problems.push(`version ${v} is recorded at ${ref} but not here (${RELEASES} only grows)`);
      else if (here.sha256 !== r.sha256 || here.size !== r.size)
        problems.push(`version ${v} is recorded here with other bytes than at ${ref}`);
    }
  }
  const manifest = atRevision(ref, `${label}/${MANIFEST}`);
  if (manifest !== null) {
    const m = JSON.parse(manifest);
    if (
      !VERSION.test(m?.version ?? '') ||
      !/^[0-9a-f]{64}$/.test(m?.sha256 ?? '') ||
      !Number.isSafeInteger(m?.size) ||
      m.size < 1
    )
      fail(`${label}: malformed ${MANIFEST} at ${ref}`);
    const here = versions[m.version];
    if (here === undefined)
      problems.push(`version ${m.version}, the manifest at ${ref}, is not recorded in ${RELEASES}`);
    else if (here.sha256 !== m.sha256 || here.size !== m.size)
      problems.push(
        `version ${m.version} has a different SHA-256 or size from the manifest at ${ref}: a released version is never edited, raise the version`,
      );
  }
  return problems;
}

function artifactDirs() {
  if (!lstatSync(resolvePath(root)).isDirectory())
    fail('artifacts root is not a regular directory');
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, SCRIPT)))
    .map((d) => join(root, d.name));
}

function readArtifact(path, optional = false) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if ((stat !== undefined || !optional) && !stat?.isFile())
    fail(`${path}: expected a regular file`);
  const actual = stat === undefined ? undefined : readFileSync(path);
  const candidate = env.SW_ARTIFACT_HEAD_REF;
  if (candidate) {
    // Ignore any checkout text conversion controlled by the candidate's attributes.
    const relative = path.slice(root.length).replaceAll('\\', '/');
    const tracked = atRevision(candidate, relative, null);
    if (tracked === null ? actual !== undefined : !actual?.equals(tracked))
      fail(`${relative}: working tree bytes do not match the candidate commit`);
  }
  return actual;
}

function run(mode) {
  const dirs = artifactDirs();
  const base = baseRevision();
  if (env.SW_ARTIFACT_HEAD_REF && !hasRevision(env.SW_ARTIFACT_HEAD_REF))
    fail('SW_ARTIFACT_HEAD_REF is not a revision of this repository');
  if (base !== null) {
    // Git reports paths relative to the repository root, even when run from artifacts/.
    const prefix = git(['rev-parse', '--show-prefix']).trimEnd();
    const scripts = git([
      'ls-tree',
      '-r',
      '-z',
      '--full-name',
      '--name-only',
      base,
      '--',
      '.',
    ]).split('\0');
    for (const path of scripts) {
      const [label, file, extra] = path.slice(prefix.length).split('/');
      if (file === SCRIPT && extra === undefined && !dirs.includes(join(root, label))) {
        fail(`${label}: artifact exists at ${base} but not here`);
      }
    }
  }
  if (dirs.length === 0) fail('no artifact found under artifacts/');
  let bad = 0;
  for (const dir of dirs) {
    const label = dir.slice(root.length);
    const manifest = buildManifest(readArtifact(join(dir, SCRIPT)));
    const releasesPath = join(dir, RELEASES);
    const releasesHave = readArtifact(releasesPath, true)?.toString('utf8') ?? '';
    const versions = readReleases(releasesHave, label);
    const higher = Object.keys(versions).filter((v) => compareVersions(v, manifest.version) > 0);
    if (higher.length > 0)
      fail(`${label}: version ${manifest.version} is lower than the recorded ${higher.join(', ')}`);
    const problems = base === null ? [] : baseProblems(base, label, versions);
    if (mode === 'build' && problems.length > 0) fail(`${label}: ${problems.join('; ')}`);
    const recorded = versions[manifest.version];
    const sameBytes =
      recorded !== undefined &&
      recorded.sha256 === manifest.sha256 &&
      recorded.size === manifest.size;
    const wantJson = `${JSON.stringify(manifest, null, 2)}\n`;
    const readmePath = join(dir, README);
    const readme = readArtifact(readmePath, true)?.toString('utf8') ?? '';
    const tables = renderTables(manifest);
    let wantReadme = readme;
    for (const s of SECTIONS) wantReadme = replaceSection(wantReadme, s, tables[s]);
    const haveJson = readArtifact(join(dir, MANIFEST), true)?.toString('utf8') ?? '';
    if (mode === 'build') {
      // A version recorded with other bytes may be recorded again only while the base revision does not have it (the work
      // on a new version before it is merged); without a base revision to ask, it may not.
      if (recorded !== undefined && !sameBytes) {
        if (base === null || publishedAt(base, label, manifest.version))
          fail(
            `${label}: version ${manifest.version} is recorded in ${RELEASES} with other bytes${base === null ? '' : ` and is in ${base}`}. A released version is never edited: raise the version in ${SCRIPT}`,
          );
        delete versions[manifest.version];
      }
      if (versions[manifest.version] === undefined) {
        versions[manifest.version] = { sha256: manifest.sha256, size: manifest.size };
        writeFileSync(releasesPath, releasesText(versions));
      }
      writeFileSync(join(dir, MANIFEST), wantJson);
      writeFileSync(readmePath, wantReadme);
      console.log(
        `${label}: wrote ${MANIFEST} (version ${manifest.version}, sha256 ${manifest.sha256.slice(0, 12)}...)${sameBytes ? '' : `, recorded the version in ${RELEASES}`} and the tables of ${README}`,
      );
      continue;
    }
    const before = bad;
    if (recorded === undefined) {
      bad += 1;
      console.error(
        `${label}: version ${manifest.version} is not recorded in ${RELEASES}. Run: pnpm run artifacts:build`,
      );
    } else if (!sameBytes) {
      bad += 1;
      console.error(
        `${label}: version ${manifest.version} is recorded in ${RELEASES} with other bytes than ${SCRIPT} has. A released version is never edited: raise the version`,
      );
    }
    if (releasesHave !== '' && releasesHave !== releasesText(versions)) {
      bad += 1;
      console.error(`${label}: ${RELEASES} is not in the form the tool writes`);
    }
    for (const p of problems) {
      bad += 1;
      console.error(`${label}: ${p}`);
    }
    if (haveJson !== wantJson) {
      bad += 1;
      const have = haveJson === '' ? {} : JSON.parse(haveJson);
      const why = ['sha256', 'size', 'version', 'steps', 'params'].filter(
        (k) => JSON.stringify(have[k]) !== JSON.stringify(manifest[k]),
      );
      console.error(
        `${label}: ${MANIFEST} is out of date (differs in: ${why.join(', ') || 'formatting'}). Run: pnpm run artifacts:build`,
      );
    }
    if (readme !== wantReadme) {
      bad += 1;
      console.error(
        `${label}: the generated tables of ${README} are out of date. Run: pnpm run artifacts:build`,
      );
    }
    if (bad === before)
      console.log(
        `${label}: ${MANIFEST}, ${README} and ${RELEASES} are up to date (version ${manifest.version}, sha256 ${manifest.sha256.slice(0, 12)}...; ${base === null ? 'no base revision to compare with' : `compared with ${base}`})`,
      );
  }
  return bad === 0;
}

const mode = argv[2];
if (mode !== 'build' && mode !== '--check' && mode !== 'check') {
  console.error('usage: node scripts/artifact-manifest.mjs build | --check');
  exit(2);
}
try {
  exit(run(mode === 'build' ? 'build' : 'check') ? 0 : 1);
} catch (e) {
  if (e instanceof ArtifactError) {
    console.error(`error: ${e.message}`);
    exit(1);
  }
  throw e;
}
