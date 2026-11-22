import { apiConsole } from './apiConsole.js';
import { artifacts } from './artifacts.js';
import { audit } from './audit.js';
import { auth } from './auth.js';
import { baseline } from './baseline.js';
import { checks } from './checks.js';
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
import { snapshots } from './snapshots.js';
import { tokens } from './tokens.js';
import { users } from './users.js';
import { vault } from './vault.js';

export const ru = {
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
  checks,
  snapshots,
  baseline,
  apiConsole,
} as const;
