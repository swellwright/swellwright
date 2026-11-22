/**
 * The Roles page (apps/web/src/security/roles-page.tsx) and the names of the roles wherever else the console shows one.
 *
 * The API sends the catalogue of roles and permissions in English. The console translates what it knows by
 * the id (`names`, `roleDescriptions`, `permissionDescriptions`) and shows the text from the API for an id it
 * does not know yet. A permission `servers:read` is written `serversRead` here: a colon cannot be part of a key.
 */
export const roles = {
  header: {
    title: 'Roles',
    description: 'Built-in roles and the permissions each one holds',
  },

  matrix: {
    title: 'Roles and permissions',
    subtitle: 'Which role holds which permission',
  },
  descriptions: {
    title: 'What each role is for',
  },

  permissionColumn: 'Permission',
  you: 'you',
  held: 'The role {{role}} has the permission {{permission}}',
  notHeld: 'The role {{role}} does not have the permission {{permission}}',
  note: 'The roles are fixed. Custom roles come with user management. Permissions of pages that are not built yet are listed so the roles stay stable.',

  signInAgain: 'Sign in again to continue.',
  forbidden: 'Your role may not see this page.',

  /** The display name of a role, by its id. */
  names: {
    owner: 'Owner',
    operator: 'Operator',
    observer: 'Observer',
    terminal: 'Terminal',
    auditor: 'Auditor',
  },

  roleDescriptions: {
    owner: 'Everything, including users, the vault and the audit log. Every new permission.',
    operator:
      'Runs scripts and changes servers and the panel. Cannot reveal a secret, open the terminal or manage users.',
    observer: 'Read-only view of servers, the panel, runs and the vault status.',
    terminal: 'Read-only view plus the web terminal.',
    auditor: 'Reads everything, including users, roles and the audit log, and verifies the chain.',
  },

  permissionDescriptions: {
    serversRead: 'See servers, their facts and state.',
    serversWrite:
      'Add, change and retire servers; read host keys, try the access entries and collect facts over SSH.',
    serversExec:
      'Run scripts and commands on servers, stop a run, and write the scripts of the library.',
    panelRead: 'See the connected Remnawave panel: nodes, hosts, profiles, squads.',
    panelWrite: 'Change panel objects through Swellwright.',
    panelConsole:
      'Send read requests to the panel from the API console with the stored token. What it reads is masked; the operations about people need more (reveal secrets).',
    runsRead: 'See runs, their steps and logs.',
    runsExecute: 'Start, approve, cancel and roll back runs.',
    vaultRead: 'See the vault status and the list of secrets, never their values.',
    vaultManage: 'Create, rotate and delete secrets; seal and unseal the vault.',
    vaultReveal: 'Show the value of a secret.',
    terminalUse: 'Open the web terminal to a server.',
    usersRead: 'See the users of this instance.',
    usersWrite: 'Create users, change their role and disable them.',
    rolesRead: 'See the roles and the permission catalogue.',
    auditRead: 'Read the audit log.',
    auditVerify: 'Verify the integrity of the audit chain.',
    auditExport: 'Export the audit log and make checkpoints of it.',
    sessionsRead: 'See the signed-in sessions of every user.',
    sessionsRevoke: 'End the sessions of other users.',
    tokensCreate: 'Create API tokens in your own name.',
    tokensRead: 'See the API tokens of every user, never their values.',
    tokensRevoke: 'Revoke the API tokens of other users.',
    pluginsRead: 'See the plugins of this instance, what each asks for and whether it is enabled.',
    pluginsManage: 'Enable plugins, approving what they ask for, and disable them.',
  },
} as const;
