// The page-level lists of the Remnawave panel frontend 3.4.11 (AGPL-3.0-only), Hosts and Nodes, are `@kastov/mantine-datatable`
// (MIT) tables, and this project uses the same package at the same version (ADR 0033, ADR 0034). This file re-exports it
// and ports what the panel builds around it: src/shared/ui/datatable/{cells.tsx,columns-visibility-popover.tsx,
// datatable-controls.tsx,sort.ts} and the props both widgets (src/widgets/dashboard/{hosts/hosts-datatable,
// nodes/nodes-datatable}/*-datatable.widget.tsx) give to every column and to the table.
// Changes: the texts are props instead of translation keys (the "Yes/No/All" of the boolean filter, the labels of the
// reset menu and of the column popover); `lodash/get` became a small path reader; the column-header icons, which the
// panel's two widgets do not use, are not ported; buttons and popovers have accessible names.
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnToggle,
  type DataTableProps,
  type DataTableSortStatus,
  useDataTableColumns,
} from '@kastov/mantine-datatable';
import {
  ActionIcon,
  Button,
  Checkbox,
  Divider,
  Group,
  Menu,
  MultiSelect,
  Popover,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useClipboard, useDisclosure } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { PiCheckCircleDuotone, PiXCircleDuotone } from 'react-icons/pi';
import {
  TbChevronDown,
  TbColumns3,
  TbEye,
  TbEyeOff,
  TbRestore,
  TbSearch,
  TbX,
} from 'react-icons/tb';

export {
  DataTable,
  type DataTableColumn,
  type DataTableColumnToggle,
  type DataTableProps,
  type DataTableSortStatus,
  useDataTableColumns,
};

/**
 * What both of the panel's datatable widgets pass as `defaultColumnProps`: cells do not wrap and are cut with an
 * ellipsis, every column can be dragged, resized and hidden unless a column says otherwise.
 */
export const defaultColumnProps = {
  noWrap: true,
  textAlign: 'left',
  ellipsis: true,
  draggable: true,
  toggleable: true,
  resizable: true,
} as const satisfies DataTableProps<never>['defaultColumnProps'];

/**
 * The props both widgets give to the table itself: striped rows with borders, the first and the last column pinned,
 * columns that expand while they are resized, virtualised rows.
 */
export const panelDataTableProps = {
  borderRadius: 'sm',
  defaultColumnProps,
  fetching: false,
  highlightOnHover: true,
  pinFirstColumn: true,
  pinLastColumn: true,
  striped: true,
  withColumnBorders: true,
  withRowBorders: true,
  withTableBorder: true,
  columnResizeMode: 'expand',
  rowVirtualization: { fixedLayout: false, overscan: 25 },
} as const satisfies Partial<DataTableProps<never>>;

/** The cell of a text column: one line, cut with an ellipsis (the panel's `EllipsisCell`). */
export function EllipsisCell({ children }: { children: ReactNode }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Text
        size="sm"
        style={{
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </Text>
    </Group>
  );
}

/** A monospace cell that copies its value on a click and turns teal for a second (the panel's `CopyableCell`). */
export function CopyableCell({ value, copyLabel }: { value: string; copyLabel?: string }) {
  const clipboard = useClipboard({ timeout: 1000 });
  if (!value || value === '–') {
    return <EllipsisCell>{value || '–'}</EllipsisCell>;
  }
  return (
    <Tooltip label={value} withArrow>
      <Text
        aria-label={copyLabel === undefined ? value : `${copyLabel}: ${value}`}
        ff="monospace"
        onClick={() => {
          clipboard.copy(value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            clipboard.copy(value);
          }
        }}
        role="button"
        size="sm"
        {...(clipboard.copied ? { c: 'teal' } : {})}
        style={{
          cursor: 'pointer',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        tabIndex={0}
      >
        {value}
      </Text>
    </Tooltip>
  );
}

/**
 * A check or a cross in a soft theme icon (the panel's `BooleanCell`). The icon is drawn for the eye; a screen reader
 * reads the value from `labels` (already translated), which the panel's cell does not have.
 */
export function BooleanCell({
  value,
  labels,
}: {
  value: boolean;
  labels: { readonly yes: string; readonly no: string };
}) {
  const label = value ? labels.yes : labels.no;
  return value ? (
    <ThemeIcon aria-label={label} color="teal" role="img" size="md" title={label} variant="light">
      <PiCheckCircleDuotone aria-hidden size={18} />
    </ThemeIcon>
  ) : (
    <ThemeIcon aria-label={label} color="gray" role="img" size="md" title={label} variant="light">
      <PiXCircleDuotone aria-hidden size={18} />
    </ThemeIcon>
  );
}

/** The filter popover of a text column (the panel's `TextSearchFilter`). */
export function TextSearchFilter({
  label,
  onChange,
  value,
  clearLabel,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
  /** Accessible name of the button that empties the field. */
  clearLabel?: string;
}) {
  return (
    <TextInput
      label={label}
      leftSection={<TbSearch size={16} />}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
      rightSection={
        value ? (
          <ActionIcon
            aria-label={clearLabel ?? 'Clear'}
            c="dimmed"
            onClick={() => {
              onChange('');
            }}
            size="sm"
            variant="transparent"
          >
            <TbX size={14} />
          </ActionIcon>
        ) : null
      }
      value={value}
    />
  );
}

export type BooleanFilterValue = 'all' | 'no' | 'yes';

/** The filter popover of a yes/no column: All, Yes, No (the panel's `BooleanFilterControl`). */
export function BooleanFilterControl({
  label,
  onChange,
  value,
  allLabel,
  yesLabel,
  noLabel,
}: {
  label: string;
  onChange: (value: BooleanFilterValue) => void;
  value: BooleanFilterValue;
  allLabel: string;
  yesLabel: string;
  noLabel: string;
}) {
  return (
    <Stack gap={6}>
      <Text fw={500} size="sm">
        {label}
      </Text>
      <SegmentedControl
        data={[
          { label: allLabel, value: 'all' },
          { label: yesLabel, value: 'yes' },
          { label: noLabel, value: 'no' },
        ]}
        fullWidth
        onChange={(next) => {
          onChange(next);
        }}
        size="xs"
        value={value}
      />
    </Stack>
  );
}

/** The filter popover of a column with a few values: a searchable multi-select (the panel's `SelectFilter`). */
export function SelectFilter({
  data,
  label,
  onChange,
  value,
}: {
  data: { label: string; value: string }[];
  label: string;
  onChange: (value: string[]) => void;
  value: string[];
}) {
  return (
    <MultiSelect
      clearable
      comboboxProps={{ withinPortal: false }}
      data={data}
      label={label}
      leftSection={<TbSearch size={16} />}
      onChange={onChange}
      searchable
      value={value}
    />
  );
}

type SortStatus<T> = Pick<DataTableSortStatus<T>, 'columnAccessor' | 'direction'>;

/** `a.b.c` read from an object, as lodash's `get` does for the accessors the tables use. */
function valueAt(record: unknown, path: string): unknown {
  let current: unknown = record;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Sorts the rows by one column (the panel's `sortRecords`): text without regard to case, empty values last in both
 * directions.
 */
export function sortRecords<T>(records: T[], sortStatus: SortStatus<T>): T[] {
  const isDesc = sortStatus.direction === 'desc';
  const accessor = String(sortStatus.columnAccessor);

  return [...records].sort((a, b) => {
    const first = valueAt(a, accessor);
    const second = valueAt(b, accessor);

    if ((first === null || first === undefined) && (second === null || second === undefined)) {
      return 0;
    }
    if (first === null || first === undefined) {
      return 1;
    }
    if (second === null || second === undefined) {
      return -1;
    }

    let result: number;
    if (typeof first === 'string' && typeof second === 'string') {
      result = first.toLowerCase().localeCompare(second.toLowerCase());
    } else if ((first as number) < (second as number)) {
      result = -1;
    } else {
      result = (first as number) > (second as number) ? 1 : 0;
    }
    return isDesc ? -result : result;
  });
}

export interface ColumnsVisibilityPopoverProps {
  columnsToggle: DataTableColumnToggle[];
  labelByAccessor: Record<string, string>;
  setColumnsToggle: (toggle: DataTableColumnToggle[]) => void;
  showAllLabel: string;
  hideAllLabel: string;
  /** Accessible name of the button that opens the popover, already translated. */
  label: string;
}

/** The "7/30" button under the table and its list of checkboxes (the panel's `ColumnsVisibilityPopover`). */
export function ColumnsVisibilityPopover({
  columnsToggle,
  labelByAccessor,
  setColumnsToggle,
  showAllLabel,
  hideAllLabel,
  label,
}: ColumnsVisibilityPopoverProps) {
  const [opened, { close, toggle }] = useDisclosure(false);

  const toggleableColumns = columnsToggle.filter((column) => column.toggleable);
  const visibleCount = toggleableColumns.filter((column) => column.toggled).length;

  const setToggled = (accessor: string, toggled: boolean) => {
    setColumnsToggle(
      columnsToggle.map((column) =>
        column.accessor === accessor ? { ...column, toggled } : column,
      ),
    );
  };

  const setAll = (toggled: boolean) => {
    setColumnsToggle(
      columnsToggle.map((column) => (column.toggleable ? { ...column, toggled } : column)),
    );
  };

  return (
    <Popover
      keepMounted={false}
      onClose={close}
      opened={opened}
      position="top-end"
      shadow="md"
      width={280}
      withArrow
    >
      <Popover.Target>
        <Button
          aria-label={label}
          leftSection={<TbColumns3 size={16} />}
          onClick={toggle}
          size="sm"
          variant="default"
        >
          {visibleCount}/{toggleableColumns.length}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Group justify="space-between" mb="xs">
          <Button
            leftSection={<TbEye size={14} />}
            onClick={() => {
              setAll(true);
            }}
            size="compact-xs"
            variant="subtle"
          >
            {showAllLabel}
          </Button>
          <Button
            color="gray"
            leftSection={<TbEyeOff size={14} />}
            onClick={() => {
              setAll(false);
            }}
            size="compact-xs"
            variant="subtle"
          >
            {hideAllLabel}
          </Button>
        </Group>
        <Divider mb="xs" />
        <ScrollArea.Autosize mah={320} type="auto">
          <Stack gap="xs" pr="sm">
            {toggleableColumns.map((column) => (
              <Checkbox
                checked={column.toggled}
                key={column.accessor}
                label={<Text size="sm">{labelByAccessor[column.accessor] ?? column.accessor}</Text>}
                onChange={(event) => {
                  setToggled(column.accessor, event.currentTarget.checked);
                }}
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}

export interface DataTableControlsLabels {
  reset: string;
  resetSort: string;
  columnWidth: string;
  columnOrder: string;
  columnToggle: string;
  showAll: string;
  hideAll: string;
  /** Accessible name of the "7/30" button. */
  columns: string;
}

export interface DataTableControlsProps {
  labels: DataTableControlsLabels;
  onResetColumnsOrder: () => void;
  onResetColumnsToggle: () => void;
  onResetColumnsWidth: () => void;
  onResetSort?: () => void;
  sortResetDisabled?: boolean;
  columnsToggle?: DataTableColumnToggle[];
  labelByAccessor?: Record<string, string>;
  setColumnsToggle?: (toggle: DataTableColumnToggle[]) => void;
}

/**
 * The row under a datatable: a "Reset" menu (sort, column width, order, visibility) and the columns popover (the
 * panel's `DataTableControls`).
 */
export function DataTableControls({
  labels,
  onResetColumnsOrder,
  onResetColumnsToggle,
  onResetColumnsWidth,
  onResetSort,
  sortResetDisabled,
  columnsToggle,
  labelByAccessor,
  setColumnsToggle,
}: DataTableControlsProps) {
  return (
    <Group gap="xs" justify="right" mt="md">
      <Menu position="top-end" shadow="md" width={230} withinPortal>
        <Menu.Target>
          <Button
            leftSection={<TbRestore size={16} />}
            rightSection={<TbChevronDown size={14} />}
            size="sm"
            variant="default"
          >
            {labels.reset}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {onResetSort ? (
            <Menu.Item
              disabled={sortResetDisabled === true}
              leftSection={<TbRestore size={14} />}
              onClick={onResetSort}
            >
              {labels.resetSort}
            </Menu.Item>
          ) : null}
          <Menu.Item leftSection={<TbRestore size={14} />} onClick={onResetColumnsWidth}>
            {labels.columnWidth}
          </Menu.Item>
          <Menu.Item leftSection={<TbRestore size={14} />} onClick={onResetColumnsOrder}>
            {labels.columnOrder}
          </Menu.Item>
          <Menu.Item leftSection={<TbRestore size={14} />} onClick={onResetColumnsToggle}>
            {labels.columnToggle}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      {columnsToggle && setColumnsToggle ? (
        <ColumnsVisibilityPopover
          columnsToggle={columnsToggle}
          hideAllLabel={labels.hideAll}
          label={labels.columns}
          labelByAccessor={labelByAccessor ?? {}}
          setColumnsToggle={setColumnsToggle}
          showAllLabel={labels.showAll}
        />
      ) : null}
    </Group>
  );
}
