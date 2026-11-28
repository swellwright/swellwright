import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { SECRET_TYPES } from '@swellwright/contracts';
import {
  checkDriverAgainstPlugin,
  type ConfigSchemaFile,
  ConfigSchemaFileSchema,
  type Driver,
  MANIFEST_FILE,
  PluginManifestSchema,
  referencedFiles,
  secretFields,
  type PluginManifest,
} from '@swellwright/plugin-api';
import semver from 'semver';

import { digestPlugin, MAX_PLUGIN_BYTES } from './digest.js';
import { readDriver } from './driver-file.js';
import { fileErrorCode, PluginFilesUnavailable, readBoundedFile } from './files.js';

/** Where a plugin directory comes from, which decides how far it is trusted (ADR 0008). */
export type TrustLevel = 'official' | 'local' | 'community';

export interface PluginRoot {
  /** A directory whose sub-directories are plugins. */
  readonly directory: string;
  readonly trust: TrustLevel;
}

/**
 * `available`: the manifest is sound and fits this version. `incompatible`: sound, but for other versions of
 * the core. `invalid`: not a plugin the core can use; `problems` says why.
 */
export type PluginState = 'available' | 'incompatible' | 'invalid';

export interface DiscoveredPlugin {
  /** The directory name; for a sound plugin it is also the plugin id. */
  readonly folder: string;
  readonly directory: string;
  readonly trust: TrustLevel;
  readonly state: PluginState;
  readonly manifest: PluginManifest | undefined;
  /** SHA-256 over every file of the plugin (see `digestPlugin`); undefined when the plugin is invalid. */
  readonly digest: string | undefined;
  /** What its settings look like (the file named by `config.schema`), when it has any and it is sound. */
  readonly configSchema: ConfigSchemaFile | undefined;
  /** Its declarative drivers by extension kind, when it has any and they are sound (ADR 0030). */
  readonly drivers: Readonly<Record<string, Driver>>;
  readonly problems: readonly string[];
  /** Unable to verify on this attempt, not evidence that an approval must be revoked. */
  readonly transient?: true;
  readonly hardLink?: true;
}

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
/** What npm runs when a package is installed. A plugin may not run code just by being put on a disk. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

function isMissing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(fileErrorCode(error) ?? '');
}

type SmallFile =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Reads a file of the plugin that must be small and ordinary: not a link, not a device, not a big file, inside the
 * plugin. The type and the size are checked before it is read.
 */
async function readSmallFile(directory: string, path: string, limit: number): Promise<SmallFile> {
  const read = await readBoundedFile(directory, path, limit);
  return read.kind === 'data' ? { kind: 'text', text: read.data.toString('utf8') } : read;
}

/** Repository metadata is never a manifest entry; use a file in the plugin's working tree. */
function inHistory(file: string): boolean {
  return /^\.git(\/|$)/iu.test(file);
}

/** Every file the manifest names must exist, be a file, and be inside the plugin once links are resolved. */
async function checkFiles(directory: string, manifest: PluginManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const file of referencedFiles(manifest)) {
    if (inHistory(file)) {
      problems.push(`"${file}" is inside .git; the manifest must name a file in the working tree`);
      continue;
    }
    const result = await readBoundedFile(
      directory,
      join(directory, file),
      MAX_PLUGIN_BYTES,
      undefined,
      true,
    );
    if (result.kind === 'missing') {
      problems.push(`"${file}" does not exist`);
    } else if (result.kind === 'refused') {
      problems.push(`"${file}" ${result.reason}`);
    }
  }
  return problems;
}

async function installScriptProblems(directory: string): Promise<string[]> {
  const file = await readSmallFile(
    directory,
    join(directory, 'package.json'),
    MAX_PACKAGE_JSON_BYTES,
  );
  if (file.kind === 'missing') {
    return [];
  }
  if (file.kind === 'refused') {
    return [`package.json ${file.reason}`];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return ['package.json is not valid JSON'];
  }
  const scripts =
    typeof parsed === 'object' && parsed !== null && 'scripts' in parsed
      ? parsed.scripts
      : undefined;
  if (typeof scripts !== 'object' || scripts === null) {
    return [];
  }
  return INSTALL_SCRIPTS.filter((name) => name in scripts).map(
    (name) => `package.json has a "${name}" script; plugins may not run install scripts`,
  );
}

/** A kind of secret the manifest asks for must be one the vault has: `dns-oauth` is the vault type `dns_oauth`. */
function secretKindProblems(manifest: PluginManifest): string[] {
  return manifest.permissions.secrets
    .filter((kind) => !(SECRET_TYPES as readonly string[]).includes(kind.replaceAll('-', '_')))
    .map(
      (kind) =>
        `asks for secrets of the kind "${kind}", which this version does not have (${SECRET_TYPES.join(', ')})`,
    );
}

const MAX_SCHEMA_BYTES = 64 * 1024;

/** The settings the plugin declares: read, checked, and tied to the secrets the manifest asks for. */
async function readConfigSchema(
  directory: string,
  manifest: PluginManifest,
): Promise<{ schema: ConfigSchemaFile | undefined; problems: string[] }> {
  if (manifest.config === undefined) {
    return { schema: undefined, problems: [] };
  }
  const file = manifest.config.schema.replace(/^\.\//u, '');
  if (inHistory(file)) {
    // Reported by the check of the files the manifest names; never read.
    return { schema: undefined, problems: [] };
  }
  const raw = await readSmallFile(directory, join(directory, file), MAX_SCHEMA_BYTES);
  if (raw.kind === 'missing') {
    // A missing file is reported by the check of the files the manifest names.
    return { schema: undefined, problems: [] };
  }
  if (raw.kind === 'refused') {
    // Said here: a schema that is refused must not leave a plugin that looks usable without its settings.
    return { schema: undefined, problems: [`${file} ${raw.reason}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.text);
  } catch {
    return { schema: undefined, problems: [`${file} is not valid JSON`] };
  }
  const parsed = ConfigSchemaFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      schema: undefined,
      problems: parsed.error.issues.map(
        (i) => `${file}: ${i.path.join('.') || 'schema'}: ${i.message}`,
      ),
    };
  }
  const problems = secretFields(parsed.data)
    .filter((f) => !manifest.permissions.secrets.includes(f.kind))
    .map(
      (f) =>
        `${file}: the setting "${f.field}" holds a secret of the kind "${f.kind}", which the manifest does not ask for`,
    );
  return { schema: problems.length === 0 ? parsed.data : undefined, problems };
}

/** The declarative drivers of a plugin: each read, checked, and tied to what the manifest asks for. */
async function readDrivers(
  directory: string,
  manifest: PluginManifest,
  schema: ConfigSchemaFile | undefined,
): Promise<{ drivers: Record<string, Driver>; problems: string[] }> {
  const drivers: Record<string, Driver> = {};
  const problems: string[] = [];
  for (const provided of manifest.provides) {
    if (provided.driver === undefined) {
      continue;
    }
    const file = provided.driver.replace(/^\.\//u, '');
    if (inHistory(file)) {
      // Reported by the check of the files the manifest names; never read.
      continue;
    }
    const read = await readDriver(directory, join(directory, file), file);
    problems.push(...read.problems);
    if (read.driver === undefined) {
      continue;
    }
    if (read.driver.kind !== provided.kind) {
      problems.push(
        `${file}: is a driver for ${read.driver.kind} but the manifest gives it as ${provided.kind}`,
      );
      continue;
    }
    const mismatch = checkDriverAgainstPlugin(read.driver, manifest, schema).map(
      (p) => `${file}: ${p}`,
    );
    problems.push(...mismatch);
    if (mismatch.length === 0) {
      drivers[provided.kind] = read.driver;
    }
  }
  return { drivers, problems };
}

async function inspect(
  root: PluginRoot,
  folder: string,
  coreVersion: string,
): Promise<DiscoveredPlugin> {
  const directory = join(root.directory, folder);
  const done = (
    state: PluginState,
    problems: readonly string[],
    manifest?: PluginManifest,
    digest?: string,
    configSchema?: ConfigSchemaFile,
    drivers: Readonly<Record<string, Driver>> = {},
  ): DiscoveredPlugin => ({
    folder,
    directory,
    trust: root.trust,
    state,
    manifest,
    digest,
    configSchema,
    drivers,
    problems,
  });

  if ((await lstat(directory)).isSymbolicLink()) {
    return done('invalid', ['is a link; a plugin directory is never followed through a link']);
  }
  const raw = await readSmallFile(directory, join(directory, MANIFEST_FILE), MAX_MANIFEST_BYTES);
  if (raw.kind === 'missing') {
    return done('invalid', [`has no ${MANIFEST_FILE}`]);
  }
  if (raw.kind === 'refused') {
    return done('invalid', [`${MANIFEST_FILE} ${raw.reason}`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.text);
  } catch {
    return done('invalid', [`${MANIFEST_FILE} is not valid JSON`]);
  }
  const parsed = PluginManifestSchema.safeParse(json);
  if (!parsed.success) {
    return done(
      'invalid',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`),
    );
  }
  const manifest = parsed.data;

  const problems: string[] = [];
  if (manifest.id !== folder) {
    problems.push(`the directory is named "${folder}" but the plugin id is "${manifest.id}"`);
  }
  problems.push(...(await checkFiles(directory, manifest)));
  problems.push(...(await installScriptProblems(directory)));
  problems.push(...secretKindProblems(manifest));
  const settings = await readConfigSchema(directory, manifest);
  problems.push(...settings.problems);
  const declarative = await readDrivers(directory, manifest, settings.schema);
  problems.push(...declarative.problems);
  if (root.trust === 'community' && manifest.provides.some((p) => p.entry !== undefined)) {
    problems.push(
      'a community plugin does not run code in the process of Swellwright: it must be a sidecar container or a declarative driver',
    );
  }
  if (semver.validRange(manifest.engines.swellwright) === null) {
    problems.push(`engines.swellwright "${manifest.engines.swellwright}" is not a valid range`);
  }
  if (problems.length > 0) {
    return done('invalid', problems, manifest);
  }
  const digest = await digestPlugin(directory);
  if (!digest.ok) {
    return {
      ...done('invalid', [digest.problem], manifest),
      ...(digest.transient === true ? { transient: true } : {}),
      ...(digest.hardLink === true ? { hardLink: true } : {}),
    };
  }
  if (!semver.satisfies(coreVersion, manifest.engines.swellwright, { includePrerelease: true })) {
    return done(
      'incompatible',
      [`needs Swellwright ${manifest.engines.swellwright}, this is ${coreVersion}`],
      manifest,
      digest.digest,
      settings.schema,
      declarative.drivers,
    );
  }
  return done('available', [], manifest, digest.digest, settings.schema, declarative.drivers);
}

/** True for a directory with at least one file and nothing but documentation files (README, LICENSE, `*.md`). */
async function onlyDocumentation(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    entries.length > 0 &&
    entries.every(
      (e) =>
        e.isFile() && /^(readme|license|licence|notice|changelog)([._-].*)?$|\.md$/iu.test(e.name),
    )
  );
}

async function inspectCandidate(
  root: PluginRoot,
  folder: string,
  coreVersion: string,
): Promise<DiscoveredPlugin | undefined> {
  const directory = join(root.directory, folder);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const entry = await lstat(directory);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        return undefined;
      }
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      if (attempt === 0 && fileErrorCode(error) !== undefined) {
        continue;
      }
      return unavailable(root, folder, 'Plugin directory could not be checked.');
    }
    try {
      const plugin = await inspect(root, folder, coreVersion);
      if (
        plugin.manifest === undefined &&
        plugin.problems[0]?.startsWith(`has no ${MANIFEST_FILE}`) === true &&
        (await onlyDocumentation(directory))
      ) {
        return undefined;
      }
      return plugin;
    } catch (error) {
      const hardLink = error instanceof PluginFilesUnavailable && error.issue === 'hard_link';
      if (
        !hardLink &&
        attempt === 0 &&
        (error instanceof PluginFilesUnavailable || fileErrorCode(error) !== undefined)
      ) {
        continue;
      }
      return unavailable(
        root,
        folder,
        error instanceof PluginFilesUnavailable
          ? error.message
          : 'Plugin files could not be checked.',
        hardLink,
      );
    }
  }
}

function unavailable(
  root: PluginRoot,
  folder: string,
  problem: string,
  hardLink = false,
): DiscoveredPlugin {
  return {
    folder,
    directory: join(root.directory, folder),
    trust: root.trust,
    state: 'invalid',
    manifest: undefined,
    digest: undefined,
    configSchema: undefined,
    drivers: {},
    problems: [problem],
    transient: true,
    ...(hardLink ? { hardLink: true } : {}),
  };
}

/** Only inspect the named directory in each root, preserving root precedence. */
export async function discoverPlugin(
  roots: readonly PluginRoot[],
  coreVersion: string,
  id: string,
  onUnavailable?: (candidate: DiscoveredPlugin) => void,
): Promise<DiscoveredPlugin | undefined> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id)) {
    return undefined;
  }
  let invalid: DiscoveredPlugin | undefined;
  for (const root of roots) {
    const candidate = await inspectCandidate(root, id, coreVersion);
    if (candidate === undefined) {
      continue;
    }
    if (candidate.state !== 'invalid') {
      return candidate;
    }
    if (candidate.transient === true) {
      onUnavailable?.(candidate);
    }
    if (invalid === undefined || (invalid.transient !== true && candidate.transient === true)) {
      invalid = candidate;
    }
  }
  return invalid;
}

/**
 * Looks for plugins in the roots, in order, and says what each one is. Nothing is loaded or run: a plugin that
 * is found is only described. A root that does not exist is skipped. When two plugins have the same id the one
 * from the earlier root wins and the other is invalid.
 */
export async function discoverPlugins(
  roots: readonly PluginRoot[],
  coreVersion: string,
): Promise<DiscoveredPlugin[]> {
  const found: DiscoveredPlugin[] = [];
  const owner = new Map<string, string>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw error;
    }
    const folders = entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .filter((name) => name !== 'node_modules')
      .sort();
    for (const folder of folders) {
      const plugin = await inspectCandidate(root, folder, coreVersion);
      if (plugin === undefined) {
        continue;
      }
      const id = plugin.manifest?.id ?? (plugin.transient === true ? folder : undefined);
      const first = id === undefined ? undefined : owner.get(id);
      if (id !== undefined && first !== undefined && plugin.state !== 'invalid') {
        found.push({
          ...plugin,
          state: 'invalid',
          digest: undefined,
          problems: [`the plugin id "${id}" is already used by ${first}`],
        });
        continue;
      }
      if (id !== undefined && plugin.state !== 'invalid' && first === undefined) {
        owner.set(id, plugin.directory);
      }
      found.push(plugin);
    }
  }
  return found;
}
