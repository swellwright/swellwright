// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the list pages that show their objects as cards (src/pages/
// dashboard/templates/ui/components/templates.page.component.tsx, src/pages/dashboard/node-plugins/ui/components/
// node-plugins-base-page.component.tsx): a header card with icon-only actions, a tag filter bar, a grid of `EntityCard`s
// that open the object in a drawer, and a menu of actions on each card. Changes: the objects are scripts; the tags are
// the danger levels and the built-in scripts.
import { Badge, Box, CopyButton, Menu, SimpleGrid, Text } from '@mantine/core';
import {
  IconCopy,
  IconEdit,
  IconEye,
  IconInfoCircle,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconCode,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiCheck, PiCopy } from 'react-icons/pi';
import { useNavigate } from 'react-router';

import type { Permission, ScriptSummary } from '@swellwright/contracts';
import {
  Callout,
  EntityCard,
  HeaderAction,
  HeaderActions,
  LoadingScreen,
  PageHeader,
  StatusBadge,
  TagFilterBar,
  filterByTag,
} from '@swellwright/ui';

import { deleteScript, listScripts, listServers } from '../api.js';
import { describeError } from '../auth/messages.js';
import { useStepUp } from '../auth/step-up.js';
import { notifyFailure } from '../security/notify-failure.js';
import { QueryErrorCard } from '../security/query-error.js';
import { confirmAction, notifySuccess } from '../shell/feedback.js';
import { ROUTES } from '../routes.js';
import { DANGER_COLOR, DangerBadge } from './danger.js';
import { RunDialog } from './run-dialog.js';
import { type ScriptTarget, ScriptDrawer } from './script-drawer.js';

/** The tabs of the filter bar: the levels of danger, and the scripts that ship with Swellwright. */
const TAGS = ['read', 'change', 'destructive', 'builtin', 'own'] as const;
type Tag = (typeof TAGS)[number];
/** The bar sorts its tags alphabetically; each starts with its place in the strip. */
const tagOf = (tag: Tag): string => `${String(TAGS.indexOf(tag))}:${tag}`;
const fromTag = (value: string): Tag => TAGS.find((tag) => tagOf(tag) === value) ?? 'read';

const tagsOf = (script: ScriptSummary): string[] => [
  tagOf(script.dangerLevel),
  tagOf(script.builtin ? 'builtin' : 'own'),
];

const CHIP_STYLES = {
  root: { flexShrink: 0, width: 'max-content' },
  label: { overflow: 'visible' },
};

/** The library of scripts: built-in diagnostics and the instance's own. Reading needs `servers:read`; writing and running `servers:exec`. */
export function ScriptsPage({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation(['commands', 'common', 'errors']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const step = useStepUp();
  const canExec = permissions.includes('servers:exec');
  const [target, setTarget] = useState<ScriptTarget>(undefined);
  const [running, setRunning] = useState<string | undefined>(undefined);
  // The dialog is mounted anew for every opening, so it starts from the script of that moment.
  const [openings, setOpenings] = useState(0);
  const startRun = (id: string) => {
    setOpenings((count) => count + 1);
    setRunning(id);
  };
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['scripts'], queryFn: listScripts, retry: false });
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => listServers(),
    enabled: canExec,
    retry: false,
  });

  const remove = useMutation({
    mutationFn: (script: ScriptSummary) => step.run(() => deleteScript(script.id)),
    onSuccess: (_, script) => {
      notifySuccess(
        t('commands:scripts.deleted'),
        t('commands:scripts.deletedText', { name: script.name }),
      );
      void queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
    onError: (error, script) => {
      notifyFailure(
        t,
        t('commands:scripts.deleteTitle', { name: script.name }),
        error,
        t('commands:signInAgain'),
        t('commands:scripts.forbidden'),
      );
    },
  });
  const askDelete = (script: ScriptSummary) => {
    confirmAction({
      title: t('commands:scripts.deleteTitle', { name: script.name }),
      message: <Text size="sm">{t('commands:scripts.deleteText')}</Text>,
      confirmLabel: t('common:delete'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        remove.mutate(script);
      },
    });
  };

  const scripts = list.data?.scripts;
  const rows = useMemo(
    () => (scripts ?? []).map((script) => ({ script, tags: tagsOf(script) })),
    [scripts],
  );
  const visible = filterByTag(rows, activeTag);

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={list.isRefetching}
              onClick={() => void list.refetch()}
            />
            {canExec ? (
              <HeaderAction
                color="teal"
                icon={IconPlus}
                label={t('commands:scripts.add')}
                onClick={() => {
                  setTarget({ kind: 'new' });
                }}
              />
            ) : null}
          </HeaderActions>
        }
        description={t('commands:scripts.description')}
        icon={<IconCode size={24} />}
        title={t('commands:scripts.title')}
      />

      {list.isPending ? (
        <LoadingScreen height="60vh" />
      ) : list.isError ? (
        <QueryErrorCard
          message={describeError(
            t,
            list.error,
            t('commands:signInAgain'),
            t('commands:scripts.readForbidden'),
          )}
          onRetry={() => void list.refetch()}
          title={t('commands:scripts.loadFailed')}
        />
      ) : (
        <motion.div
          animate={{ opacity: 1 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.5 }}
        >
          {!canExec ? (
            <Callout color="blue" icon={<IconInfoCircle size={20} />} mb="md">
              {t('commands:scripts.readOnlyNotice')}
            </Callout>
          ) : null}
          <TagFilterBar
            activeTag={activeTag}
            allLabel={t('commands:scripts.filter.all')}
            items={rows}
            onChange={setActiveTag}
            tagLabel={(tag) => t(`commands:scripts.filter.${fromTag(tag)}`)}
            untaggedLabel={t('commands:scripts.filter.all')}
          />
          <Box style={{ paddingInline: 'calc(var(--mantine-spacing-md) - 4px)' }}>
            <SimpleGrid cols={{ base: 1, '1000px': 2 }} p={4} spacing={8} type="container">
              {visible.map(({ script }) => (
                <ScriptCard
                  canExec={canExec}
                  key={script.id}
                  onDelete={askDelete}
                  onDuplicate={(source) => {
                    setTarget({ kind: 'duplicate', id: source.id });
                  }}
                  onOpen={(item) => {
                    setTarget({ kind: 'edit', id: item.id });
                  }}
                  onRun={(item) => {
                    startRun(item.id);
                  }}
                  script={script}
                />
              ))}
            </SimpleGrid>
          </Box>
        </motion.div>
      )}

      <ScriptDrawer
        canExec={canExec}
        onChange={setTarget}
        onRun={(id) => {
          setTarget(undefined);
          startRun(id);
        }}
        target={target}
      />
      <RunDialog
        canReveal={permissions.includes('vault:reveal')}
        chooseServers
        key={openings}
        initialScriptId={running}
        initialServerIds={[]}
        onClose={() => {
          setRunning(undefined);
        }}
        onStarted={(run) => {
          setRunning(undefined);
          void navigate(`${ROUTES.DASHBOARD.OPERATIONS.RUNS}?run=${run.id}`);
        }}
        opened={running !== undefined}
        servers={servers.data?.servers ?? []}
      />
    </>
  );
}

/** One script: a card of the panel's kind. The whole card opens it, its menu holds the actions. */
function ScriptCard({
  script,
  canExec,
  onOpen,
  onRun,
  onDuplicate,
  onDelete,
}: {
  script: ScriptSummary;
  canExec: boolean;
  onOpen: (script: ScriptSummary) => void;
  onRun: (script: ScriptSummary) => void;
  onDuplicate: (script: ScriptSummary) => void;
  onDelete: (script: ScriptSummary) => void;
}) {
  const { t } = useTranslation(['commands', 'common']);
  return (
    <EntityCard.Root
      aria-label={t('commands:scripts.openAria', { name: script.name })}
      isActive={script.dangerLevel === 'read'}
      onClick={() => {
        onOpen(script);
      }}
      wrap
    >
      <EntityCard.Header>
        <EntityCard.Icon highlight={script.dangerLevel === 'read'}>
          <IconCode
            color={`var(--mantine-color-${DANGER_COLOR[script.dangerLevel]}-4)`}
            size={22}
          />
        </EntityCard.Icon>
        <EntityCard.Content
          badges={
            <>
              <DangerBadge level={script.dangerLevel} />
              {script.sudo ? (
                <Badge color="gray" maw="none" size="lg" styles={CHIP_STYLES} variant="soft">
                  {t('commands:badges.sudo')}
                </Badge>
              ) : null}
              {script.builtin ? (
                <Badge color="cyan" maw="none" size="lg" styles={CHIP_STYLES} variant="soft">
                  {t('commands:badges.builtin')}
                </Badge>
              ) : null}
              {script.parameters.length > 0 ? (
                <StatusBadge kind="info" maw="none" styles={CHIP_STYLES}>
                  {t('commands:badges.parameters', { count: script.parameters.length })}
                </StatusBadge>
              ) : null}
            </>
          }
          title={script.name}
        />
      </EntityCard.Header>
      <EntityCard.Actions>
        <EntityCard.Menu label={t('commands:scripts.menuAria', { name: script.name })}>
          {canExec ? (
            <Menu.Item
              color="teal"
              leftSection={<IconPlayerPlay size={18} />}
              onClick={() => {
                onRun(script);
              }}
            >
              {t('commands:scripts.run')}
            </Menu.Item>
          ) : null}
          <Menu.Item
            leftSection={
              !script.builtin && canExec ? <IconEdit size={18} /> : <IconEye size={18} />
            }
            onClick={() => {
              onOpen(script);
            }}
          >
            {!script.builtin && canExec ? t('commands:scripts.edit') : t('commands:scripts.view')}
          </Menu.Item>
          {canExec ? (
            <Menu.Item
              leftSection={<IconCopy size={18} />}
              onClick={() => {
                onDuplicate(script);
              }}
            >
              {t('commands:scripts.duplicate')}
            </Menu.Item>
          ) : null}
          <CopyButton timeout={2000} value={script.bodySha256}>
            {({ copied, copy }) => (
              <Menu.Item
                {...(copied ? { color: 'teal' } : {})}
                leftSection={copied ? <PiCheck size={18} /> : <PiCopy size={18} />}
                onClick={copy}
              >
                {t('commands:scripts.copyHash')}
              </Menu.Item>
            )}
          </CopyButton>
          {canExec && !script.builtin ? (
            <>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={18} />}
                onClick={() => {
                  onDelete(script);
                }}
              >
                {t('common:delete')}
              </Menu.Item>
            </>
          ) : null}
        </EntityCard.Menu>
      </EntityCard.Actions>
    </EntityCard.Root>
  );
}
