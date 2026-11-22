import { IconLock } from '@tabler/icons-react';
import { lazy, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';

import type { Permission } from '@swellwright/contracts';
import { EmptyPageLayout } from '@swellwright/ui';

import { navFor } from './nav.js';
import { ROUTES } from './routes.js';
import { useConsole } from './shell/console-context.js';
import { ConsoleLayout } from './shell/console-layout.js';
import { NotFoundPage, ServerErrorPage } from './shell/error-pages.js';
import { Page } from './shell/page.js';

// A page chunk is loaded when the page is first opened.
const Overview = lazy(() => import('./overview.js').then((m) => ({ default: m.Overview })));
const VaultPage = lazy(() =>
  import('./security/vault-page.js').then((m) => ({ default: m.VaultPage })),
);
const UsersPage = lazy(() =>
  import('./security/users-page.js').then((m) => ({ default: m.UsersPage })),
);
const RolesPage = lazy(() =>
  import('./security/roles-page.js').then((m) => ({ default: m.RolesPage })),
);
const SessionsPage = lazy(() =>
  import('./security/sessions-page.js').then((m) => ({ default: m.SessionsPage })),
);
const TokensPage = lazy(() =>
  import('./security/tokens-page.js').then((m) => ({ default: m.TokensPage })),
);
const AuditPage = lazy(() =>
  import('./security/audit-page.js').then((m) => ({ default: m.AuditPage })),
);
const ServersPage = lazy(() =>
  import('./fleet/servers-page.js').then((m) => ({ default: m.ServersPage })),
);
const RunsPage = lazy(() =>
  import('./commands/runs-page.js').then((m) => ({ default: m.RunsPage })),
);
const ScriptsPage = lazy(() =>
  import('./commands/scripts-page.js').then((m) => ({ default: m.ScriptsPage })),
);
const ArtifactsPage = lazy(() =>
  import('./operations/artifacts-page.js').then((m) => ({ default: m.ArtifactsPage })),
);
const PluginsPage = lazy(() =>
  import('./settings/plugins-page.js').then((m) => ({ default: m.PluginsPage })),
);
// The pages of the connected Remnawave panel (ADR 0041).
const ConnectionPage = lazy(() =>
  import('./panel/connection-page.js').then((m) => ({ default: m.ConnectionPage })),
);
const PanelNodesPage = lazy(() =>
  import('./panel/nodes-page.js').then((m) => ({ default: m.PanelNodesPage })),
);
const PanelHostsPage = lazy(() =>
  import('./panel/hosts-page.js').then((m) => ({ default: m.PanelHostsPage })),
);
const ProfilesPage = lazy(() =>
  import('./panel/profiles-page.js').then((m) => ({ default: m.ProfilesPage })),
);
const InternalSquadsPage = lazy(() =>
  import('./panel/internal-squads-page.js').then((m) => ({ default: m.InternalSquadsPage })),
);
const ExternalSquadsPage = lazy(() =>
  import('./panel/external-squads-page.js').then((m) => ({ default: m.ExternalSquadsPage })),
);
const TemplatesPage = lazy(() =>
  import('./panel/templates-page.js').then((m) => ({ default: m.TemplatesPage })),
);
const NodePluginsPage = lazy(() =>
  import('./panel/node-plugins-page.js').then((m) => ({ default: m.NodePluginsPage })),
);
const SnippetsPage = lazy(() =>
  import('./panel/snippets-page.js').then((m) => ({ default: m.SnippetsPage })),
);
const ChecksPage = lazy(() =>
  import('./checks/checks-page.js').then((m) => ({ default: m.ChecksPage })),
);

/** A page for people whose role allows it; everyone else sees why they cannot. */
function Guarded({
  permission,
  title,
  children,
}: {
  permission?: Permission;
  title: string;
  children: ReactNode;
}) {
  const { t } = useTranslation('shell');
  const { session } = useConsole();
  if (permission !== undefined && !session.permissions.includes(permission)) {
    return (
      <Page title={t('forbidden.title')}>
        <EmptyPageLayout
          description={t('forbidden.text')}
          icon={<IconLock size="3rem" />}
          mih="50vh"
          title={t('forbidden.title')}
        />
      </Page>
    );
  }
  return <Page title={title}>{children}</Page>;
}

/** The index of an area goes to the first page of it that the person may open. */
function AreaIndex({ area }: { area: string }) {
  const { t } = useTranslation(['common', 'nav']);
  const { session } = useConsole();
  const section = navFor(session.permissions, t).find((s) => s.id === area);
  const first = section?.items.find((item) => item.planned !== true);
  return <Navigate replace to={first?.href ?? ROUTES.DASHBOARD.HOME} />;
}

function OverviewRoute() {
  const { t } = useTranslation('nav');
  return (
    <Guarded title={t('overview')}>
      <Overview />
    </Guarded>
  );
}

function VaultRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded permission="vault:read" title={t('vault')}>
      <VaultPage permissions={session.permissions} />
    </Guarded>
  );
}

function UsersRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded permission="users:read" title={t('users')}>
      <UsersPage currentUserId={session.user.id} permissions={session.permissions} />
    </Guarded>
  );
}

function RolesRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded permission="roles:read" title={t('roles')}>
      <RolesPage currentRole={session.user.role} />
    </Guarded>
  );
}

function SessionsRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded title={t('sessions')}>
      <SessionsPage currentUserId={session.user.id} permissions={session.permissions} />
    </Guarded>
  );
}

function TokensRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded title={t('tokens')}>
      <TokensPage permissions={session.permissions} role={session.user.role} />
    </Guarded>
  );
}

function AuditRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded permission="audit:read" title={t('audit')}>
      <AuditPage permissions={session.permissions} />
    </Guarded>
  );
}

function PluginsRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded permission="plugins:read" title={t('plugins')}>
      <PluginsPage permissions={session.permissions} />
    </Guarded>
  );
}

function ServersRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded permission="servers:read" title={t('servers')}>
      <ServersPage permissions={session.permissions} />
    </Guarded>
  );
}

function RunsRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded permission="servers:read" title={t('runs')}>
      <RunsPage permissions={session.permissions} />
    </Guarded>
  );
}

function ScriptsRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <Guarded permission="servers:read" title={t('scripts')}>
      <ScriptsPage permissions={session.permissions} />
    </Guarded>
  );
}

function ArtifactsRoute() {
  const { t } = useTranslation('nav');
  return (
    <Guarded permission="servers:read" title={t('artifacts')}>
      <ArtifactsPage />
    </Guarded>
  );
}

/** A page of the connected panel: it reads it, so `panel:read` opens it; what changes the connection asks for more. */
function PanelRoute({ title, page }: { title: string; page: ReactNode }) {
  return (
    <Guarded permission="panel:read" title={title}>
      {page}
    </Guarded>
  );
}

function ConnectionRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return (
    <PanelRoute
      page={<ConnectionPage permissions={session.permissions} />}
      title={t('connection')}
    />
  );
}

function PanelNodesRoute() {
  const { t } = useTranslation('nav');
  return <PanelRoute page={<PanelNodesPage />} title={t('nodes')} />;
}

function PanelHostsRoute() {
  const { t } = useTranslation('nav');
  return <PanelRoute page={<PanelHostsPage />} title={t('hosts')} />;
}

function ProfilesRoute() {
  const { t } = useTranslation('nav');
  return <PanelRoute page={<ProfilesPage />} title={t('profiles')} />;
}

function InternalSquadsRoute() {
  const { t } = useTranslation('nav');
  return <PanelRoute page={<InternalSquadsPage />} title={t('internalSquads')} />;
}

function ExternalSquadsRoute() {
  const { t } = useTranslation('nav');
  return <PanelRoute page={<ExternalSquadsPage />} title={t('externalSquads')} />;
}

function TemplatesRoute() {
  const { t } = useTranslation('nav');
  return <PanelRoute page={<TemplatesPage />} title={t('templates')} />;
}

function NodePluginsRoute() {
  const { t } = useTranslation('nav');
  return <PanelRoute page={<NodePluginsPage />} title={t('nodePlugins')} />;
}

function ChecksRoute() {
  const { t } = useTranslation('nav');
  const { session } = useConsole();
  return <PanelRoute page={<ChecksPage permissions={session.permissions} />} title={t('checks')} />;
}

function SnippetsRoute() {
  const { t } = useTranslation('nav');
  return <PanelRoute page={<SnippetsPage />} title={t('snippets')} />;
}

const D = ROUTES.DASHBOARD;

/** The paths of a child are relative to the layout route `/dashboard`. */
const relative = (path: string): string => path.slice(`${D.ROOT}/`.length);

export const routes: RouteObject[] = [
  {
    // Something that breaks while a page is drawn shows the panel's 500 page; an address that leads nowhere shows
    // its 404 page. Both fill the window, outside the header.
    ErrorBoundary: ServerErrorPage,
    children: [
      { path: ROUTES.ROOT, element: <Navigate replace to={D.HOME} /> },
      {
        path: D.ROOT,
        element: <ConsoleLayout />,
        children: [
          { index: true, element: <Navigate replace to={D.HOME} /> },
          { path: relative(D.HOME), element: <OverviewRoute /> },
          { path: relative(D.FLEET.ROOT), element: <AreaIndex area="fleet" /> },
          { path: relative(D.FLEET.SERVERS), element: <ServersRoute /> },
          { path: relative(D.FLEET.NODES), element: <PanelNodesRoute /> },
          { path: relative(D.OPERATIONS.ROOT), element: <AreaIndex area="operations" /> },
          { path: relative(D.OPERATIONS.RUNS), element: <RunsRoute /> },
          { path: relative(D.OPERATIONS.SCRIPTS), element: <ScriptsRoute /> },
          { path: relative(D.OPERATIONS.ARTIFACTS), element: <ArtifactsRoute /> },
          { path: relative(D.PANEL.ROOT), element: <AreaIndex area="panel" /> },
          { path: relative(D.PANEL.CONNECTION), element: <ConnectionRoute /> },
          { path: relative(D.PANEL.PROFILES), element: <ProfilesRoute /> },
          { path: relative(D.PANEL.HOSTS), element: <PanelHostsRoute /> },
          { path: relative(D.PANEL.INTERNAL_SQUADS), element: <InternalSquadsRoute /> },
          { path: relative(D.PANEL.EXTERNAL_SQUADS), element: <ExternalSquadsRoute /> },
          { path: relative(D.PANEL.TEMPLATES), element: <TemplatesRoute /> },
          { path: relative(D.PANEL.SNIPPETS), element: <SnippetsRoute /> },
          { path: relative(D.PANEL.NODE_PLUGINS), element: <NodePluginsRoute /> },
          { path: relative(D.PANEL.CHECKS), element: <ChecksRoute /> },
          { path: relative(D.SECURITY.ROOT), element: <AreaIndex area="security" /> },
          { path: relative(D.SECURITY.VAULT), element: <VaultRoute /> },
          { path: relative(D.SECURITY.USERS), element: <UsersRoute /> },
          { path: relative(D.SECURITY.ROLES), element: <RolesRoute /> },
          { path: relative(D.SECURITY.SESSIONS), element: <SessionsRoute /> },
          { path: relative(D.SECURITY.TOKENS), element: <TokensRoute /> },
          { path: relative(D.SECURITY.AUDIT), element: <AuditRoute /> },
          { path: relative(D.SETTINGS.ROOT), element: <AreaIndex area="settings" /> },
          { path: relative(D.SETTINGS.PLUGINS), element: <PluginsRoute /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** The router is made once, when the console is first shown. */
export const createConsoleRouter = () => createBrowserRouter(routes);
