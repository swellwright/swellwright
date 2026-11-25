import { Badge, Group, Menu, Text } from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LANGUAGES, LANGUAGE_NAMES, isLanguage } from '@swellwright/i18n';
import {
  AccountControl,
  DocsControl,
  GithubControl,
  LanguageControl,
  LogoutControl,
  VersionControl,
  type LanguageOption,
} from '@swellwright/ui';

import { updatePreferences } from '../api.js';
import { ChangePasswordDialog } from '../auth/change-password.js';
import { describeError } from '../auth/messages.js';
import { setLanguage } from '../i18n.js';
import { openBuildInfo } from './build-info-modal.js';
import { notifyError } from './feedback.js';
import { useConsole } from './console-context.js';
import { isNewerVersion, useUpdateInfo, useVersionInfo } from './system-info.js';

/** Where the project lives, until the server says otherwise. */
const DEFAULT_REPOSITORY_URL = 'https://github.com/swellwright/swellwright';

/** The flags next to the language names, as in the panel's language menu. */
const FLAGS: Record<string, string> = { en: '🇬🇧', ru: '🇷🇺' };

/** The GitHub control with the star count: a link to the repository, as in the panel. */
export function GithubLink() {
  const { t } = useTranslation('shell');
  const updates = useUpdateInfo();
  return (
    <GithubControl
      href={updates.data?.repositoryUrl ?? DEFAULT_REPOSITORY_URL}
      isLoading={updates.isLoading}
      label={t('githubLabel')}
      stars={updates.data?.stars ?? undefined}
    />
  );
}

/** The documentation control: the docs folder of the repository the server reports. */
export function DocsLink() {
  const { t } = useTranslation('shell');
  const updates = useUpdateInfo();
  return (
    <DocsControl
      href={`${updates.data?.repositoryUrl ?? DEFAULT_REPOSITORY_URL}/tree/main/docs`}
      label={t('docsLabel')}
    />
  );
}

function VersionButton() {
  const { t } = useTranslation('shell');
  const version = useVersionInfo();
  const updates = useUpdateInfo();
  const current = version.data?.version ?? null;
  const branch = version.data?.git.branch ?? null;
  const isNewVersion = isNewerVersion(updates.data?.latestVersion ?? null, current);

  return (
    <VersionControl
      isDev={branch !== null && branch !== 'main'}
      isLoading={version.isLoading}
      isNewVersion={isNewVersion}
      label={t('versionLabel')}
      onClick={() => {
        if (version.data) {
          openBuildInfo({
            title: t('buildInfo.title'),
            version: version.data,
            updates: updates.data,
            isNewVersion,
          });
        }
      }}
      version={current}
    />
  );
}

/**
 * The controls on the right of the header, in the order of the panel: the version and the GitHub link (not on a
 * narrow screen, where the GitHub link moves to the drawer), the language menu, and the end of the row. The panel
 * has one administrator and ends with Sign out; here people have accounts, so a control for the account sits between.
 */
export function HeaderControls({ mobile = false }: { mobile?: boolean }) {
  const { t, i18n } = useTranslation(['common', 'roles', 'errors']);
  const { session, signOut } = useConsole();
  const [changing, setChanging] = useState(false);

  const languages: LanguageOption[] = LANGUAGES.map((language) => ({
    value: language,
    label: LANGUAGE_NAMES[language],
    emoji: FLAGS[language] ?? '🌐',
  }));

  return (
    <>
      <ChangePasswordDialog
        onClose={() => {
          setChanging(false);
        }}
        opened={changing}
      />
      <Group gap="xs" wrap="nowrap">
        {mobile ? null : <DocsLink />}
        <VersionButton />
        {mobile ? null : <GithubLink />}
        <LanguageControl
          label={t('common:language')}
          onChange={(value) => {
            if (isLanguage(value)) {
              void setLanguage(value);
              // The choice already works here. Saving it on the account only makes it follow the person to other
              // browsers, so a failure is not worth a message.
              void updatePreferences(value).catch(() => undefined);
            }
          }}
          options={languages}
          value={i18n.language}
        />
        <AccountControl label={t('common:account')}>
          <Menu.Label>
            <Group gap="xs" wrap="nowrap">
              <Text fw={600} fz="sm">
                {session.user.displayName ?? session.user.username}
              </Text>
              <Badge size="xs">{t(`roles:names.${session.user.role}`)}</Badge>
            </Group>
          </Menu.Label>
          <Menu.Item
            leftSection={<IconKey size={16} />}
            onClick={() => {
              setChanging(true);
            }}
          >
            {t('common:changePassword')}
          </Menu.Item>
        </AccountControl>
        <LogoutControl
          label={t('common:signOut')}
          onClick={() => {
            // Until the server confirms, the person stays signed in and is told so; the control can be pressed again.
            signOut().catch((error: unknown) => {
              notifyError(
                t('common:signOutFailed'),
                describeError(t, error, t('common:signOutFailed')),
              );
            });
          }}
        />
      </Group>
    </>
  );
}
