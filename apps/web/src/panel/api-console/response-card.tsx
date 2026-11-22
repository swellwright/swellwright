// New in Swellwright (ADR 0046). Built from the panel's pieces: the code card of its config-profile and template pages (a
// `SectionCard` with an `OverlayHeader` and a Monaco editor in the panel's theme, here read only), the status chips of its
// tables (`Badge size="lg" variant="soft"`), `Tabs color="cyan"` as its template pages use them, and the soft icon-only
// actions with a tooltip. Everything shown has been masked by the server; the note above the editor says so.
import {
  ActionIcon,
  Badge,
  Button,
  Collapse,
  DataList,
  Group,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import { useClipboard, useDisclosure } from '@mantine/hooks';
import {
  IconBookmarkPlus,
  IconBraces,
  IconCopy,
  IconDownload,
  IconPlayerPlay,
  IconShieldLock,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TbShieldLock } from 'react-icons/tb';

import type { PanelConsoleOperation, PanelConsoleResult } from '@swellwright/contracts';
import {
  Callout,
  EmptyPageLayout,
  LoadingScreen,
  OverlayHeader,
  SectionCard,
  StatusBadge,
} from '@swellwright/ui';

import { CodeEditor } from '../../commands/code-editor.js';
import { useBytes, useNumber } from '../../format.js';
import { notifySuccess } from '../../shell/feedback.js';
import { statusKind } from './console-model.js';

/** `42 ms`, `1.4 s`. */
function useDuration(): (ms: number) => string {
  const number = useNumber();
  return (ms) => (ms >= 1000 ? `${number(Math.round(ms / 100) / 10)} s` : `${number(ms)} ms`);
}

function HeadersList({ headers }: { headers: Readonly<Record<string, string>> }) {
  const { t } = useTranslation('apiConsole');
  const [opened, { toggle }] = useDisclosure(false);
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    return null;
  }
  return (
    <Stack gap="xs">
      <Button
        aria-expanded={opened}
        onClick={toggle}
        size="compact-sm"
        style={{ alignSelf: 'flex-start' }}
        variant="subtle"
      >
        {t(opened ? 'response.hideHeaders' : 'response.showHeaders', { n: entries.length })}
      </Button>
      <Collapse expanded={opened}>
        <DataList orientation="vertical" size="xs" withDivider>
          {entries.map(([name, value]) => (
            <DataList.Item key={name}>
              <DataList.ItemLabel>
                <Text component="span" ff="monospace" fz="xs">
                  {name}
                </Text>
              </DataList.ItemLabel>
              <DataList.ItemValue>
                <Text component="span" ff="monospace" fz="xs">
                  {value}
                </Text>
              </DataList.ItemValue>
            </DataList.Item>
          ))}
        </DataList>
      </Collapse>
    </Stack>
  );
}

function ResultBody({ result }: { result: PanelConsoleResult }) {
  const { t } = useTranslation('apiConsole');
  const bytes = useBytes();
  const duration = useDuration();
  return (
    <Stack gap="md">
      <Group gap="xs">
        <StatusBadge kind={statusKind(result.status)}>{String(result.status)}</StatusBadge>
        <Badge size="lg" variant="soft">
          {duration(result.durationMs)}
        </Badge>
        <Badge size="lg" variant="soft">
          {bytes(result.bodyBytes)}
        </Badge>
        {result.attempts > 1 ? (
          <Badge color="orange" size="lg" variant="soft">
            {t('response.attempts', { count: result.attempts })}
          </Badge>
        ) : null}
        <Tooltip label={t('response.maskedHint')} multiline w={280} withArrow>
          <Badge
            color={result.masked ? 'cyan' : 'gray'}
            leftSection={<IconShieldLock size={16} />}
            size="lg"
            variant="soft"
          >
            {result.masked
              ? t('response.masked', { count: result.maskedCount })
              : t('response.nothingMasked')}
          </Badge>
        </Tooltip>
        {result.maskProfile === 'personal' ? (
          <Badge color="orange" size="lg" variant="soft">
            {t('response.personal')}
          </Badge>
        ) : null}
      </Group>
      <HeadersList headers={result.headers} />
      {result.truncated ? (
        <Callout color="orange" title={t('response.truncatedTitle')}>
          {t('response.truncated', { size: bytes(result.bodyBytes) })}
        </Callout>
      ) : null}
      {result.bodyFormat === 'empty' ? (
        <Text c="dimmed" size="sm">
          {t('response.empty')}
        </Text>
      ) : (
        <>
          <Text c="dimmed" size="xs">
            {t('response.editorHint')}
          </Text>
          <CodeEditor
            height="520px"
            label={t('response.editorLabel')}
            language={result.bodyFormat === 'json' ? 'json' : 'plaintext'}
            readOnly
            value={result.body}
          />
        </>
      )}
    </Stack>
  );
}

/** The answer of the panel (or why there is none) and the schemas of the operation, in two tabs. */
export function ResponseCard({
  operation,
  result,
  errorText,
  sending,
  schemaText,
  canSaveSample,
  onSaveSample,
  onDownload,
}: {
  operation: PanelConsoleOperation;
  result: PanelConsoleResult | undefined;
  /** The text of the error of a request that got no answer. */
  errorText: string | undefined;
  sending: boolean;
  /** The schema of the answer (or of the body of a write): text, `undefined` while it is being read. */
  schemaText: { label: string; text: string } | undefined | null;
  canSaveSample: boolean;
  onSaveSample: () => void;
  onDownload: () => void;
}) {
  const { t } = useTranslation(['apiConsole', 'common']);
  const clipboard = useClipboard({ timeout: 2000 });

  let body: ReactNode;
  if (sending) {
    body = <LoadingScreen height="240px" />;
  } else if (errorText !== undefined) {
    body = (
      <Callout color="red" title={t('apiConsole:response.failedTitle')}>
        {errorText}
      </Callout>
    );
  } else if (result === undefined) {
    body = (
      <EmptyPageLayout
        description={t('apiConsole:response.noneText')}
        icon={<IconPlayerPlay size="2rem" />}
        mih="200px"
        title={t('apiConsole:response.none')}
      />
    );
  } else {
    body = <ResultBody result={result} />;
  }

  const hasBody = result !== undefined && result.bodyFormat !== 'empty';
  return (
    <SectionCard.Root>
      <SectionCard.Section>
        <Group align="flex-start" gap="md" justify="space-between" wrap="wrap">
          <OverlayHeader
            icon={IconBraces}
            iconColor="violet"
            iconSize={18}
            subtitle={t('apiConsole:response.subtitle')}
            title={t('apiConsole:response.title')}
            titleOrder={5}
          />
          <Group gap="xs">
            <Tooltip
              label={clipboard.copied ? t('common:copied') : t('apiConsole:response.copy')}
              withArrow
            >
              <ActionIcon
                aria-label={t('apiConsole:response.copy')}
                {...(clipboard.copied ? { color: 'teal' } : {})}
                disabled={!hasBody}
                onClick={() => {
                  if (result !== undefined) {
                    clipboard.copy(result.body);
                    notifySuccess(t('common:copied'));
                  }
                }}
                size="input-md"
                variant="soft"
              >
                <IconCopy size={20} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('apiConsole:response.download')} withArrow>
              <ActionIcon
                aria-label={t('apiConsole:response.download')}
                disabled={!hasBody}
                onClick={onDownload}
                size="input-md"
                variant="soft"
              >
                <IconDownload size={20} />
              </ActionIcon>
            </Tooltip>
            <Tooltip
              label={
                result?.maskProfile === 'personal'
                  ? t('apiConsole:response.sampleNotPeople')
                  : t('apiConsole:response.saveSample')
              }
              multiline
              w={240}
              withArrow
            >
              <ActionIcon
                aria-label={t('apiConsole:response.saveSample')}
                color="teal"
                disabled={!hasBody || !canSaveSample}
                onClick={onSaveSample}
                size="input-md"
                variant="soft"
              >
                <IconBookmarkPlus size={20} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </SectionCard.Section>
      <SectionCard.Section>
        <Tabs color="cyan" defaultValue="response" keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="response">{t('apiConsole:response.tabResponse')}</Tabs.Tab>
            <Tabs.Tab value="schema">
              {schemaText?.label ?? t('apiConsole:response.tabSchema')}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="response">
            <Stack gap="md">
              <Callout color="blue" icon={<TbShieldLock size={20} />}>
                {t('apiConsole:response.maskedNote')}
              </Callout>
              {body}
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="schema">
            {schemaText === undefined ? (
              <LoadingScreen height="240px" />
            ) : schemaText === null ? (
              <Text c="dimmed" size="sm">
                {t('apiConsole:response.noSchema', { operation: operation.operationId })}
              </Text>
            ) : (
              <CodeEditor
                height="520px"
                label={schemaText.label}
                language="json"
                readOnly
                value={schemaText.text}
              />
            )}
          </Tabs.Panel>
        </Tabs>
      </SectionCard.Section>
    </SectionCard.Root>
  );
}
