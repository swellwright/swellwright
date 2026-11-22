import { ActionIcon, Group, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import type { ElementType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorMessageBlock, OverlayHeader, SectionCard } from '@swellwright/ui';

/**
 * What a page shows when its data could not be loaded, as the panel shows a node's last error: a card with a red
 * header and the text of the error in a copyable block. A retry, when there is something to retry, sits in the header.
 */
export function QueryErrorCard({
  title,
  message,
  icon = IconAlertTriangle,
  onRetry,
  action,
}: {
  title: string;
  message: string;
  icon?: ElementType<{ size?: number }>;
  onRetry?: () => void;
  /** Something the person can do about it (a link to where it is fixed), under the text of the error. */
  action?: ReactNode;
}) {
  const { t } = useTranslation('common');
  return (
    <SectionCard.Root>
      <SectionCard.Section>
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <OverlayHeader icon={icon} iconColor="red" title={title} titleOrder={5} />
          {onRetry ? (
            <Tooltip label={t('retry')} withArrow>
              <ActionIcon aria-label={t('retry')} onClick={onRetry} size="lg" variant="soft">
                <IconRefresh size={18} />
              </ActionIcon>
            </Tooltip>
          ) : null}
        </Group>
      </SectionCard.Section>
      <SectionCard.Section>
        <ErrorMessageBlock copiedLabel={t('copied')} copyLabel={t('copy')} message={message} />
      </SectionCard.Section>
      {action ? <SectionCard.Section>{action}</SectionCard.Section> : null}
    </SectionCard.Root>
  );
}
