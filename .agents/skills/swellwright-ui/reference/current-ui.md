# Current UI reference

Baseline: Remnawave frontend tag `3.4.11`, commit `20fabab0d788af97273d646614c6b9980f6f29d1`;
ADR 0011, 0032 and 0033. This is a maintained
map, not a copy of the old pre-port gap lists. Verify actual source before porting.

## Layout and theme
- Mobile through 1024 CSS px: 64 px header, drawer navigation, 16 px side padding.
- Desktop 1025–2047: 64 px brand row plus 52 px navigation row, 32 px side padding.
- Desktop from 2048: navigation in the brand row, 64 px header, 10vw side padding.
- Test 390, 1024, 1025, 1440, 2047, 2048 and 2560. Preserve the console's fix that
  lets the mobile menu open at exactly 1024; do not copy the panel's boundary bug.
- Montserrat / Fira Mono, dark theme, primary cyan; use `packages/ui/src/theme.ts`
  and `styles.css`. Mantine spacing: xs 10, sm 12, md 16, lg 20, xl 32.
- Header controls are 44 px, with accessible labels. Preserve visible keyboard focus
  and reduced motion even where the panel does not provide them.

## Components and dependencies
- Shared exports live in `packages/ui/src/index.ts`; shell in `apps/web/src/shell`.
- Use PageHeader/HeaderActions, SectionCard/SettingsCard, MetricCard/EntityCard,
  DataTableCard, OverlayHeader, ModalFooter/DrawerFooter, CopyableCodeBlock,
  Callout, EmptyPageLayout, ErrorMessageBlock, StatusBadge and LoadingScreen.
- Card tables: `@kastov/mantine-react-table-open` through `panelTableOptions` and
  `useMrtTableState`. Page-level infrastructure lists and dialog tables:
  `@kastov/mantine-datatable`. The old plain `ListTable` is removed.
- Motion uses `motion/react`; tag colors use `color-hash`; dates use `dayjs`
  through `apps/web/src/format.ts`. Numbers use the shared number hook.
- Visible text uses `packages/i18n` (English and Russian). Keep the library's
  localized table strings. Do not replace panel date formatting with ad hoc Intl output.
- Match library pins in `packages/ui/package.json` and `apps/web/package.json`.
  Add other display libraries only with the feature that needs them and a dependency review.
- Toasts via Mantine notifications; confirmation through the existing confirm helper;
  sticky dialog footers and OverlayHeader. Field validation stays beside its field.

## Verification
Identify the panel source path before a port. For existing components first reuse the
console's port. Check keyboard/focus, long text, loading/empty/error states, mobile
overflow and both languages. Use the pinned Vercel checklist for behavior and accessibility;
panel appearance takes precedence over its title-case and formatting preferences.
