// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/ui/virtualized-dnd-grid/
// {virtualized-dnd-grid.shared.tsx,virtualized-dnd-grid.module.css,virtualized-grid-components.tsx} (the list of cards with
// its tag filter bar above it: one column, two from a container 1000 px wide, a gap of 8 px) and the grids of src/widgets/
// dashboard/{config-profiles,internal-squads,external-squads,templates}/*-grid/*.widget.tsx. Changes: no drag and drop and no
// virtualisation (the lists of the connected panel are read, never reordered, and are short); the grid is plain CSS.
import { Box, CopyButton, Menu, SimpleGrid } from '@mantine/core';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiCheck, PiCopy } from 'react-icons/pi';

import { filterByTag, TagFilterBar } from '@swellwright/ui';

/** The cards of a list, in the panel's grid: padding so the focus ring of a card is not cut, a gap of 8 px. */
export function EntityGrid({ children }: { children: ReactNode }) {
  return (
    <Box style={{ paddingInline: 'calc(var(--mantine-spacing-md) - 4px)' }}>
      <SimpleGrid cols={{ base: 1, '1000px': 2 }} p={4} spacing={8} type="container">
        {children}
      </SimpleGrid>
    </Box>
  );
}

/** A list of cards under the panel's tag filter bar. */
export function TaggedGrid<T extends { uuid: string; tags: string[] }>({
  items,
  renderItem,
}: {
  items: readonly T[];
  renderItem: (item: T) => ReactNode;
}) {
  const { t } = useTranslation('panel');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const visible = useMemo(() => filterByTag([...items], activeTag), [items, activeTag]);
  return (
    <>
      <TagFilterBar
        activeTag={activeTag}
        allLabel={t('filter.all')}
        items={items}
        onChange={setActiveTag}
        untaggedLabel={t('filter.untagged')}
      />
      <EntityGrid>
        {visible.map((item) => (
          <div key={item.uuid}>{renderItem(item)}</div>
        ))}
      </EntityGrid>
    </>
  );
}

/** "Copy UUID" in the menu of a card: teal for two seconds after the copy, as the panel's menus do. */
export function CopyMenuItem({ value, label }: { value: string; label: string }) {
  return (
    <CopyButton timeout={2000} value={value}>
      {({ copied, copy }) => (
        <Menu.Item
          {...(copied ? { color: 'teal' } : {})}
          leftSection={copied ? <PiCheck size={18} /> : <PiCopy size={18} />}
          onClick={copy}
        >
          {label}
        </Menu.Item>
      )}
    </CopyButton>
  );
}
