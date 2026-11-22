---
name: swellwright-ui
description: >-
  Use for Swellwright console UI, layout, components and visible text in apps/web,
  packages/ui and packages/i18n. Follow the Remnawave panel's design system and
  libraries; use the accessibility checklist after choosing the panel pattern.
---

# Swellwright UI: the panel first, the checklist second

The owner's rule (2026-11-19): the console must give the impression that the person did not open another tool but switched to another tab of the Remnawave panel. Use the panel's design system and components; modernise them only in exceptional cases and say why. Layout and UX skills help with the arrangement of elements. They never override the panel's style and patterns.

## Order of authority
1. **The panel source, version 3.4.11**: read the real component markup, Mantine props and CSS before porting. Use a local reference checkout identified by `SW_PANEL_FRONTEND_DIR` when available. Record its commit and verify its package version. If missing, obtain the reviewed release tag/commit in a temporary reference directory; do not use an unpinned shallow clone of the default branch. Do not guess a tag or claim source parity without the source. ADR 0011 governs reuse: retain the notice `Adapted from Remnawave frontend 3.4.11 (AGPL-3.0-only): <path>. Changes: ...` and update `THIRD_PARTY_NOTICES.md`. Do not copy the Remnawave name, logo or links.
2. **The live panel** in the built-in browser, when the owner is signed in there: compare screenshots at 390, 1024, 1025, 1440, 2047, 2048 and 2560 px wide. Do not type the owner's password.
3. **`reference/current-ui.md`**: current component map and layout rules. Accepted ADR 0033 supersedes earlier proposals about table libraries, animation and dates. Historical gap lists are not a task list.
4. **`reference/web-interface-guidelines.md`**: a pinned copy of the Vercel Web Interface Guidelines (MIT). A checklist for accessibility, focus, forms, content handling, navigation and state, touch, i18n. Apply it to arrangement and behaviour. Skip any rule that asks for a look the panel decides (title case, colours, animation style).

## Workflow for a component or a page
1. Find the panel counterpart (same kind of page or widget). Say which file it is.
2. Use our port in `packages/ui` if there is one (`PageHeader`, `HeaderActions`, `SectionCard`, `SettingsCard`, `ModalFooter`, `DrawerFooter`, `OverlayHeader`, `MetricCard`, `EntityCard`, `DataTableCard` with a `MantineReactTable` (`panelTableOptions`, `useMrtTableState`), `CopyableCodeBlock`, `Callout`, `ErrorMessageBlock`, `EmptyPageLayout`, `StatusBadge`, `LoadingScreen`). If there is none, port the panel component into `packages/ui` rather than composing something similar on the page.
3. Keep the panel's props: sizes, variants, colours and gaps are theme tokens (`Button variant="light"`, `Badge size="lg" variant="soft"`, `ActionIcon size="input-md" variant="soft"`, `Card` with the translucent surface, `Title order={4}` for card titles, `Stack gap="md"`, `SimpleGrid` breakpoints from the panel). No hex colours and no pixel values on pages where a token exists.
4. Feedback the panel's way: toasts (`@mantine/notifications`, top-right, teal success and red error), `modals.openConfirmModal` for confirmations (red soft confirm, subtle cancel), `OverlayHeader` titles in dialogs and drawers, sticky `ModalFooter`. Inline `Alert` banners are not a panel pattern.
5. Third-party pieces: use the panel's library for it (section above). Icons: `@tabler/icons-react` (the same glyphs as the panel's `Tb*`); the panel's `Pi*` and `Hi*` icons come from `react-icons` where the panel uses them for the same concept (users, server, logout, caret). Icon-only controls need an `aria-label` (the panel has none; we add them).
6. Responsive: the panel's breakpoints are in the theme (`lg` = 64em is where the mobile layout starts; from 2048 px the tabs move into the brand row and the page gets `10vw` side padding). Test the widths listed above.
7. Texts through i18n (English first, Russian second); dates and numbers through `useDateTime` / `useNumber`.
8. Verify in a browser against a local disposable stand. Create its owner through the normal setup flow and use its own TOTP; do not depend on old `e2e-code.mjs` scripts or credentials. Compare with a live panel only when access is authorized and available. Measure sizes with `getBoundingClientRect` against the pinned panel reference. Report missing live comparisons explicitly.

## Third-party solutions: the panel's are ours (owner's rule, 2026-11-21)
If the panel renders a component, a layout or a piece of UX with a third-party library, we use the same library, in the same version the panel pins (the pinned reference checkout's `package.json`), the same way. We do not write a look-alike of it. Known cases: the tables inside a titled card (Users, request history, inspectors) are `@kastov/mantine-react-table-open`, MRT (column filters under the head, sorting, order, resizing, pinning, visibility, density, full screen, pages); the page-level lists of objects (Hosts, Nodes) and the tables in dialogs are `@kastov/mantine-datatable` (resizable, draggable, toggleable, persisted columns, column filters in popovers, the "Reset" menu under the table); entrance animations are `motion/react`; tag colours are `color-hash`; dates are formatted with `dayjs`; icons are `react-icons` and Tabler; charts are Highcharts / Recharts / `@mantine/charts`; code and config editors are Monaco; the terminal is xterm; markdown is `react-markdown`. A library is added when we build the component that uses it, never "just in case". Each addition passes the dependency rules (ADR 0009): exact pin, at least three days old, no install scripts, `pnpm audit` clean, the tarball read (network, dynamic code, URLs) before the first use, listed in `THIRD_PARTY_NOTICES.md`. The panel's plumbing (zustand stores, nice-modal registries, route guards) is not a display solution and is not copied.

## Layout checklist (own words; use after the panel pattern is chosen)
- **Hierarchy**: one clear primary action per card or dialog (the panel's is `Button color="teal" variant="soft"` in the footer); destructive actions red and confirmed; secondary actions `subtle` or `default`. The most important fact of a page is the most prominent (metric cards first, then the table card).
- **Grouping**: related things inside one card or `SectionCard`, separated by the card's dividers; unrelated things in separate cards with the panel's `mb="md"` rhythm. Labels above values in `DataList` rows; actions at the top right of their card, in the order refresh, secondary, primary (create) last.
- **Alignment and rhythm**: spacing only from the Mantine scale (xs 10, sm 12, md 16, lg 20, xl 32); the same gap between sibling cards everywhere; left edges align with the page header card.
- **States**: every interactive element has rest, hover, active, focus-visible (keyboard users must see focus even though the panel theme sets `focusRing: 'never'`: add `:focus-visible` outlines to the custom controls), disabled, loading. Every list has loading, empty and error states built from `LoadingScreen`, `EmptyPageLayout`, `ErrorMessageBlock`.
- **Content**: long values wrap or truncate with a tooltip, ids and hashes are monospace with a copy button, empty cells are an en dash, times use the panel's format; counts as numerals.
- **Forms**: a visible label for every input, the error next to the field, the submit button disabled only while the request runs, secrets never echoed.
- **Responsive**: no horizontal page scroll at 390 px; tables scroll inside their card; actions wrap (`wrapActions`) instead of overflowing; touch targets at least 44 px in the header controls (they are 44 by design).
- **Accessibility**: semantic elements, headings in order, `aria-live` for toasts (Mantine does it), contrast of dimmed text on the dark surfaces, reduced-motion respected (`prefers-reduced-motion` rules exist in `styles.css`).

## Do not
- Invent a layout, colour, radius, font or component the panel has an answer for.
- Replace a third-party solution the panel uses with our own imitation (see the next section).
- Show planned-but-unbuilt pages as working: they are listed in the menu and disabled.
- Break the contract-first rule: UI types come from `@swellwright/contracts`.
