// Builds or checks the manifest of every artifact under artifacts/ (see artifacts/README.md).
//
//   node scripts/artifact-manifest.mjs build     rewrite manifest.json and the generated tables of README.md
//   node scripts/artifact-manifest.mjs --check   fail when either differs from what install.sh says
//
// install.sh is the single source of truth. Its `#@meta`, `#@step` and `#@param` lines (one JSON object each) describe the
// steps and the parameters; a pattern or default written as "@NAME" takes its text from the assignment `NAME=...` in the
// script, so the validators the script runs and the patterns the manifest publishes are the same text. The size and the
// SHA-256 are computed from the bytes of the file. Nothing here has dependencies.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../artifacts/', import.meta.url));
const SCRIPT = 'install.sh';
const MANIFEST = 'manifest.json';
const README = 'README.md';

class ArtifactError extends Error {}

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

/** Everything the manifest says, computed from the script text. */
function buildManifest(script) {
  if (script.includes('\r'))
    fail(`${SCRIPT} contains a carriage return: it must have LF line endings`);
  if (!script.startsWith('#!/bin/sh\n')) fail(`${SCRIPT} must start with #!/bin/sh`);
  if (!script.endsWith('\n')) fail(`${SCRIPT} must end with a newline`);
  const version = /^INSTALLER_VERSION=(\d+\.\d+\.\d+)$/m.exec(script)?.[1];
  if (version === undefined) fail(`${SCRIPT}: INSTALLER_VERSION=major.minor.patch is missing`);
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
    sha256: createHash('sha256').update(script, 'utf8').digest('hex'),
    size: Buffer.byteLength(script, 'utf8'),
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

function artifactDirs() {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, SCRIPT)))
    .map((d) => join(root, d.name));
}

function run(mode) {
  const dirs = artifactDirs();
  if (dirs.length === 0) fail('no artifact found under artifacts/');
  let bad = 0;
  for (const dir of dirs) {
    const label = dir.slice(root.length);
    const script = readFileSync(join(dir, SCRIPT), 'utf8');
    const manifest = buildManifest(script);
    const wantJson = `${JSON.stringify(manifest, null, 2)}\n`;
    const readmePath = join(dir, README);
    const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
    const tables = renderTables(manifest);
    let wantReadme = readme;
    for (const s of SECTIONS) wantReadme = replaceSection(wantReadme, s, tables[s]);
    const haveJson = existsSync(join(dir, MANIFEST))
      ? readFileSync(join(dir, MANIFEST), 'utf8')
      : '';
    if (mode === 'build') {
      writeFileSync(join(dir, MANIFEST), wantJson);
      writeFileSync(readmePath, wantReadme);
      console.log(
        `${label}: wrote ${MANIFEST} (version ${manifest.version}, sha256 ${manifest.sha256.slice(0, 12)}...) and the tables of ${README}`,
      );
      continue;
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
    if (bad === 0)
      console.log(
        `${label}: ${MANIFEST} and ${README} are up to date (version ${manifest.version}, sha256 ${manifest.sha256.slice(0, 12)}...)`,
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
