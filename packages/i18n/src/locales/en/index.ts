import { artifacts } from './artifacts.js';
import { audit } from './audit.js';
import { auth } from './auth.js';
import { commands } from './commands.js';
import { common } from './common.js';
import { errors } from './errors.js';
import { nav } from './nav.js';
import { overview } from './overview.js';
import { panel } from './panel.js';
import { plugins } from './plugins.js';
import { roles } from './roles.js';
import { servers } from './servers.js';
import { sessions } from './sessions.js';
import { shell } from './shell.js';
import { tokens } from './tokens.js';
import { users } from './users.js';
import { vault } from './vault.js';

/** English is the source: the key set of every other language must equal this one (see messages.test.ts). */
export const en = {
  common,
  nav,
  shell,
  errors,
  auth,
  users,
  roles,
  audit,
  overview,
  vault,
  sessions,
  tokens,
  plugins,
  servers,
  commands,
  artifacts,
  panel,
} as const;
