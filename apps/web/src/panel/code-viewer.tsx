// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/ui/code-editor/code-editor.tsx and the
// card that holds an editor in the config-profile and template editors (src/widgets/dashboard/config-profiles/
// config-editor, src/widgets/dashboard/templates/subscription-template-editor). Changes: read-only (the panel's editor
// is edited and saved there; this one only shows what the server read), and the note that says every secret in it is
// masked, which the panel has no need for.
import { Stack, Text } from '@mantine/core';
import type { ElementType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TbShieldLock } from 'react-icons/tb';

import { Callout, OverlayHeader, SectionCard } from '@swellwright/ui';

import { CodeEditor } from '../commands/code-editor.js';

/** `JSON.stringify` with the panel's indentation; text that is already text stays as it is. */
export function jsonText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** A card with a read-only Monaco editor: the masked JSON or YAML of an object of the panel. */
export function ConfigViewerCard({
  title,
  description,
  value,
  placeholder,
  language = 'json',
  height = '520px',
  icon: Icon,
  iconColor = 'violet',
  actions,
}: {
  title: string;
  description?: string;
  /** The text to show; while there is none (still loading, or failed) `placeholder` takes the place of the editor. */
  value: string | undefined;
  /** What is shown instead of the editor while `value` is undefined. */
  placeholder?: ReactNode;
  language?: 'json' | 'yaml';
  height?: string;
  icon: ElementType<{ size?: number }>;
  iconColor?: string;
  /** Next to the title: a switch between the configuration and the computed one, for instance. */
  actions?: ReactNode;
}) {
  const { t } = useTranslation('panel');
  return (
    <SectionCard.Root>
      <SectionCard.Section>
        <Stack gap="xs">
          <OverlayHeader
            icon={Icon}
            iconColor={iconColor}
            iconSize={18}
            title={title}
            titleOrder={5}
          />
          {description === undefined ? null : (
            <Text c="dimmed" size="xs">
              {description}
            </Text>
          )}
          {actions}
          <Callout color="blue" icon={<TbShieldLock size={20} />}>
            {t('masked')}
          </Callout>
        </Stack>
      </SectionCard.Section>
      <SectionCard.Section>
        {value === undefined ? (
          placeholder
        ) : (
          <CodeEditor height={height} label={title} language={language} readOnly value={value} />
        )}
      </SectionCard.Section>
    </SectionCard.Root>
  );
}
