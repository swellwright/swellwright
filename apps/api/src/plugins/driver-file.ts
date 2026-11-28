import { DRIVER_LIMITS, type Driver, parseDriver } from '@swellwright/plugin-api';
import { parse } from 'yaml';

import { readBoundedFile } from './files.js';

/**
 * Reads the driver file of a plugin (ADR 0030). The YAML is parsed as strictly as the library allows: the 1.2 core
 * schema (no dates, no custom tags), no aliases at all (so no expansion attacks), no duplicate keys, no merge keys.
 * What comes out is plain data, checked by the driver schema.
 */
export async function readDriver(
  root: string,
  path: string,
  label: string,
): Promise<{ driver: Driver | undefined; problems: string[] }> {
  const read = await readBoundedFile(root, path, DRIVER_LIMITS.fileBytes);
  if (read.kind === 'missing') {
    return { driver: undefined, problems: [`${label} cannot be read`] };
  }
  if (read.kind === 'refused') {
    return { driver: undefined, problems: [`${label} ${read.reason}`] };
  }
  const text = read.data.toString('utf8');
  let value: unknown;
  try {
    value = parse(text, {
      schema: 'core',
      version: '1.2',
      maxAliasCount: 0,
      strict: true,
      uniqueKeys: true,
      merge: false,
      prettyErrors: false,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'is not valid YAML';
    return { driver: undefined, problems: [`${label} is not valid YAML: ${reason ?? ''}`] };
  }
  const { driver, problems } = parseDriver(value);
  return { driver, problems: problems.map((p) => `${label}: ${p}`) };
}
