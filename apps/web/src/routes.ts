/**
 * The URLs of the console, one table for the router, the navigation and the links between pages. The shape follows
 * the panel's `ROUTES` (src/shared/constants/routes.ts): absolute paths grouped by area, list pages at
 * `/dashboard/<area>/<page>`, kebab-case segments. Pages that are planned but not built are listed too, so the
 * navigation can show them.
 */
export const ROUTES = {
  ROOT: '/',
  DASHBOARD: {
    ROOT: '/dashboard',
    HOME: '/dashboard/home',
    FLEET: {
      ROOT: '/dashboard/fleet',
      SERVERS: '/dashboard/fleet/servers',
      NODES: '/dashboard/fleet/nodes',
      CHAINS: '/dashboard/fleet/chains',
      DNS: '/dashboard/fleet/dns',
      CERTIFICATES: '/dashboard/fleet/certificates',
    },
    OPERATIONS: {
      ROOT: '/dashboard/operations',
      ARTIFACTS: '/dashboard/operations/artifacts',
      RUNS: '/dashboard/operations/runs',
      SCRIPTS: '/dashboard/operations/scripts',
      SCENARIOS: '/dashboard/operations/scenarios',
      SCHEDULES: '/dashboard/operations/schedules',
    },
    MONITORING: {
      ROOT: '/dashboard/monitoring',
      PROBES: '/dashboard/monitoring/probes',
      ALERTS: '/dashboard/monitoring/alerts',
      REPORTS: '/dashboard/monitoring/reports',
    },
    PANEL: {
      ROOT: '/dashboard/panel',
      CONNECTION: '/dashboard/panel/connection',
      PROFILES: '/dashboard/panel/profiles',
      HOSTS: '/dashboard/panel/hosts',
      INTERNAL_SQUADS: '/dashboard/panel/internal-squads',
      EXTERNAL_SQUADS: '/dashboard/panel/external-squads',
      TEMPLATES: '/dashboard/panel/templates',
      SNIPPETS: '/dashboard/panel/snippets',
      NODE_PLUGINS: '/dashboard/panel/node-plugins',
      SUBSCRIPTION_SETTINGS: '/dashboard/panel/subscription-settings',
      INFRA_BILLING: '/dashboard/panel/infra-billing',
      API_CONSOLE: '/dashboard/panel/api-console',
    },
    SECURITY: {
      ROOT: '/dashboard/security',
      VAULT: '/dashboard/security/vault',
      USERS: '/dashboard/security/users',
      ROLES: '/dashboard/security/roles',
      SESSIONS: '/dashboard/security/sessions',
      TOKENS: '/dashboard/security/tokens',
      AUDIT: '/dashboard/security/audit',
    },
    SETTINGS: {
      ROOT: '/dashboard/settings',
      PLUGINS: '/dashboard/settings/plugins',
    },
  },
} as const;
