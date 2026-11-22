// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/ui/layouts/empty-page/empty-page.layout.tsx.
// Changes: the title is a required prop (the panel falls back to a translated "Nothing found"); an optional description
// and a children slot (a button, hints) are added under the title.
import { Center, Stack, Text, ThemeIcon } from '@mantine/core';
import type { ReactNode } from 'react';

import { SectionCard } from './section-card.js';

export interface EmptyPageLayoutProps {
  /** The glyph, about 3rem: usually the icon of the page. */
  icon: ReactNode;
  /** Minimum height of the card. */
  mih?: string;
  title: ReactNode;
  description?: ReactNode;
  /** Anything under the texts: a call-to-action button or a hint. */
  children?: ReactNode;
  /** Only the centred content, for the inside of a card that has a title of its own (the dashboard's feed). */
  embedded?: boolean;
}

/** The empty state of a page or a list: a card with a large gray soft icon and a bold line of text. */
export function EmptyPageLayout({
  icon,
  mih,
  title,
  description,
  children,
  embedded = false,
}: EmptyPageLayoutProps) {
  const content = (
    <Center py="xl" {...(mih === undefined ? {} : { mih })}>
      <Stack align="center" gap="lg">
        <ThemeIcon aria-hidden color="gray" radius="xl" size={64} variant="soft">
          {icon}
        </ThemeIcon>

        <Stack align="center" gap="xs">
          <Text fw={600} size="lg" ta="center">
            {title}
          </Text>
          {description ? (
            <Text c="dimmed" maw={400} size="sm" ta="center">
              {description}
            </Text>
          ) : null}
        </Stack>
        {children}
      </Stack>
    </Center>
  );
  if (embedded) {
    return content;
  }
  return (
    <SectionCard.Root p="xl" {...(mih === undefined ? {} : { mih })}>
      <SectionCard.Section>{content}</SectionCard.Section>
    </SectionCard.Root>
  );
}
