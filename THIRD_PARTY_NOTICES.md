# Third-party notices

Material that is included in the repository or bundled in the application, and material that is referenced, is listed here with its license and attribution. When dependencies or adapted code are added they are listed here too. Any code derived from Remnawave (`AGPL-3.0-only`) is listed with its origin and the retained notices.

## Tabler Icons (MIT)

The icon shapes inside `docs/en/design/wireframes/*.svg` are taken from [Tabler Icons](https://github.com/tabler/tabler-icons) (outline set). The same icon set is used by the Remnawave panel.

```text
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts (bundled in the web build)

Montserrat and Fira Mono, the fonts of the Remnawave panel theme, and Unbounded, the font of its brand title, are bundled into the web build from the `@fontsource/montserrat`, `@fontsource/fira-mono` and `@fontsource/unbounded` packages. All are distributed under the SIL Open Font License 1.1; the license texts ship inside those packages, and a release adds them next to the build output.

The flag emoji font `Twemoji Country Flags` ships in the `country-flag-emoji-polyfill` package (MIT, TalkJS) and is bundled into the web build so that Windows can draw the flags in the language menu. Its glyphs come from Twemoji and are used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): the art is copyright Twitter, Inc. and other contributors (<https://github.com/twitter/twemoji>), it is redistributed in the font file without changes beyond the font packaging.

## Icon sets of `react-icons` (MIT)

The navigation and the header controls use a few glyphs from the Phosphor (`react-icons/pi`, MIT, Phosphor Icons) and Heroicons v1 (`react-icons/hi`, MIT, Refactoring UI Inc.) sets, as the Remnawave panel does, through the `react-icons` package (MIT). Only the imported icons are bundled.

## Remnawave panel frontend (AGPL-3.0-only)

The design tokens described in `docs/en/design/wireframes/README.md` (palette, primary color, fonts, radii, component variants, layout) were read from the open-source Remnawave frontend, version 3.4.11, under `src/shared/constants/theme`.

Code adapted from that frontend (Copyright (C) 2025 Remnawave, AGPL-3.0-only, the license of this project too, as ADR 0011 describes) lives in `packages/ui`, `apps/web/src/shell`, `apps/web/src/settings` (the failed-load card and the settings card of the plugin dialog, from the panel's active-sessions failed state and its external-squads response-headers card) and `apps/web/src/security` (the token permission rows and the token list styles, from the panel's API-token card; the card layout of the invite and change dialogs of the Users page, from the panel's create-user and view-user modals and their form cards) and `apps/web/src/fleet` (the Servers page: its table and its drawer, from the panel's Hosts and Nodes pages and its edit-host drawer; the facts card and `facts-card.css`, from the panel's node system card, `src/widgets/dashboard/nodes/node-system-card`). Every adapted file says in its header which file of the panel it comes from and what was changed. The panel's name, logo and links are not copied.

The shared components of `packages/ui` are adapted from the same frontend (ADR 0011). Every adapted file starts with a line `Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): <panel path>. Changes: ...`; the panel's CSS modules are translated into the `sw-*` rules at the end of `packages/ui/src/styles.css`. The adapted components are `OverlayHeader`, `SectionCard`, `SettingsCard`, `ModalFooter`, `DrawerFooter`, `MetricCard`, `ShimmerSkeleton`, `LoaderModal`, `EmptyPageLayout`, `CopyableCodeBlock`, `CopyableDataListItem`, `CopyableField`, `ErrorMessageBlock`, `Callout` (from the one-time notice of the API-token card), `PageHeader`, `EntityCard`, `TagFilterBar`, `SingleRowOverflowList`, `DataTableCard`, `StatRow` (from the panel's HTTP-statistics row) `MetricSection` (the section blocks of the panel's Home page) and `usePreventTableBackScroll` (from the hook every table page of the panel calls). `HeaderActions`, `HeaderAction`, `HeaderActionGroup`, `StatusBadge` and the date field setup of `packages/ui/src/date-picker.ts` (Mantine's `DatePickerInput` with the `ru` dayjs locale and the `customParseFormat` plugin, as the panel's `app.tsx` and `time-utils` prepare it) encode patterns of the panel without copying its files. The table option set and the persisted table state in `packages/ui/src/mrt-table.tsx` are adapted from the panel's Users and request-history table widgets and its table store (`src/shared/lib/mrt-table-store`). No Remnawave name, logo or link is used.


## Pages and overlays adapted from the panel's shell (AGPL-3.0-only, MIT for the drawing)

`apps/web/src/shell/error-pages.tsx` (the 404 and 500 pages), `apps/web/src/shell/connection-status.tsx` (the connection-lost pill, its probe and the watchdog), `apps/web/src/shell/loading-progress.tsx` and the sign-in screens in `apps/web/src/auth` follow the panel's `src/pages/errors`, `src/shared/ui/connection-status-overlay`, `src/shared/api/connection-watchdog.ts`, `src/shared/ui/loading-screen/loading-progress.tsx`, `src/pages/auth/login` and `src/features/auth` (login and register forms); each file names its origin. The drawing of the digits 404 in the not-found page is the "nothing found" illustration of the Mantine UI examples (MIT, Copyright (c) Mantine), which the panel itself uses.

## Libraries the panel's pages are built on (MIT)

The console uses the libraries the Remnawave panel renders its tables, entrances and tag colours with, at the versions the panel pins (ADR 0033). They are ordinary dependencies, not copied code:

- `@kastov/mantine-react-table-open` 9.0.12 (MIT, Copyright (c) 2023 Kevin Vandy, a Mantine fork of Material React Table), with `@tanstack/react-table`, `@tanstack/match-sorter-utils` and `@tanstack/react-virtual` (MIT, Tanner Linsley): the tables inside the cards.
- `motion` 12.42.2 (MIT, Matt Perry): the entrance of page headers, table card titles and pages.
- `color-hash` 2.0.2 (MIT, zenozeng): the colours of tags.
- `@kastov/mantine-datatable` 9.3.4 (MIT, Ionut-Cristian Florescu, a Mantine data table): the page-level lists, as the panel's Hosts and Nodes (the Servers page). It imports only `@mantine/core`, `@mantine/hooks`, `clsx` and React. Its cells, filters, controls and sort helper are adapted from the panel's `src/shared/ui/datatable` in `packages/ui/src/datatable.tsx`.
- `react-country-flag` 3.1.0 (MIT, Dan Alloway): the flag of a country in its emoji mode, as in the panel's Nodes table (`packages/ui/src/country-flag.tsx`). Its picture mode loads images from a CDN and is not used.
- `@mantine/code-highlight` 9.5.2 (MIT, Mantine): the details of the 500 page.
- `@mantine/dates` 9.5.2, `dayjs` 1.11.23 and `clsx` 2.1.1 (MIT): peers of the table package; `dayjs` (MIT, iamkun) also formats the dates of the console, as in the panel.

## Code editor (MIT)

The script editor and the command box of the console are Monaco, as the code editors of the Remnawave panel (ADR 0038). They are ordinary dependencies at the versions the panel pins, bundled with the console (nothing is fetched from a CDN):

- `monaco-editor` 0.56.0 (MIT, Copyright (c) Microsoft Corporation), with `dompurify` (MPL-2.0 OR Apache-2.0, Cure53 and contributors; the newest 3.4.18 by an override, because Monaco pins 3.4.8, which has advisories) and `marked` 14.0.0 (MIT, Christopher Jeffrey and contributors). Its own third-party notices ship in the package (`ThirdPartyNotices.txt`).
- `@monaco-editor/react` 4.7.0 and `@monaco-editor/loader` 1.7.0 (MIT, Suren Atoyan), `state-local` 1.0.7 (MIT, Suren Atoyan): the React wrapper and its loader, which is told to use the bundled Monaco and never loads the one from the CDN.
- The editor's dark theme and options are adapted from the panel's `src/shared/constants/monaco-theme/*` (AGPL-3.0-only) in `apps/web/src/commands/monaco-theme.ts` and its setup from `src/shared/utils/setup-monaco/setup-monaco.ts` in `monaco-setup.ts`; the bar of selected rows of the servers table from `src/features/dashboard/hosts/multi-select-hosts/multi-select-hosts.feature.tsx`.

## SSH layer (`packages/ssh`)

The SSH layer uses `ssh2` 1.17.0 (MIT, Copyright Brian White) in its pure JavaScript mode, with its four runtime dependencies: `asn1` 0.2.6 (MIT, Copyright (c) 2011 Mark Cavage), `bcrypt-pbkdf` 1.0.2 (BSD-3-Clause, with the Blowfish portions of Niels Provos, Copyright 1997, and Implementation advice by David Mazieres), `safer-buffer` 2.1.2 (MIT, Copyright (c) 2018 Nikita Skovoroda) and `tweetnacl` 0.14.5 (Unlicense, public domain). `@types/ssh2` 1.15.6 (MIT, DefinitelyTyped contributors) is a development dependency. They are ordinary dependencies, not copied code; the license texts ship inside the packages and a release adds them next to the build output. `ssh2` lists two optional native add-ons (`cpu-features`, `nan`) that are never installed (`ignoredOptionalDependencies` in `pnpm-workspace.yaml`). The review of the dependency is in ADR 0035.

## The Remnawave panel's API contract and description (`packages/remnawave`)

`@remnawave/backend-contract` 3.4.11 (AGPL-3.0-only, Copyright (C) Remnawave, the license of this project too, ADR 0011) is a development dependency of `packages/remnawave`: its Zod schemas and route constants are used by the tests as a cross-check of the fake panel and of the paths of the client, never at run time and never bundled (ADR 0041). It pins `zod` 4.4.3, a second copy of Zod that only the tests load. The tarball was read before first use (ADR 0009): schemas and constants only, no install scripts, no network, filesystem or process code.

`packages/remnawave/spec/remnawave-api-3.4.11.json` is the OpenAPI description that Remnawave 3.4.11 generates for its own API (public, no instance data; `info.license` of the document is AGPL-3.0). It is kept byte for byte as the frozen reference of the client's contract tests and of the future `oasdiff` job. The schemas, the adapters and the fake panel in `packages/remnawave` are written for this project from that description; they copy no code of the panel.

## Panel pages (`apps/web/src/panel`)

The read-only pages of the Panel section are adapted from the Remnawave panel frontend 3.4.11 (Copyright (C) 2025 Remnawave, AGPL-3.0-only) like the rest of the console (ADR 0011, 0032, 0033); each file names its origin in its first lines. Origins, under `src/` of the panel: `connection-page.tsx` from `shared/ui/settings-card/*`, `pages/dashboard/remnawave-settings/*` and the authentication settings card; `nodes-page.tsx` and `node-drawer.tsx` from the Nodes page, its realtime metrics and datatable widgets and the edit-node modal; `hosts-page.tsx` and `host-drawer.tsx` from the Hosts page, its datatable widget and the edit-host modal and form; `profiles-page.tsx` and `profile-drawer.tsx` from the Config profiles page, its card and editor widgets; `internal-squads-page.tsx`, `external-squads-page.tsx`, `templates-page.tsx`, `snippets-page.tsx` and `node-plugins-page.tsx` from the pages and card widgets of the same names and their drawers; `entity-grid.tsx`, `panel-datatable.tsx`, `panel-drawer.tsx` and `code-viewer.tsx` from the shared grid, datatable, modal and code editor components. The snapshot screens (ADR 0043) are adapted the same way: `snapshots-page.tsx` from the Users page and its table widget (a header card, then a titled card with a `@kastov/mantine-react-table-open` table and soft icon row actions), `snapshot-drawer.tsx` from the record drawers and `DrawerFooter`, `snapshot-dialogs.tsx` from the panel's small create dialogs, and `snapshot-compare.tsx` from the edit drawers, the metric cards and the table card with column filters; the panel has no comparison screen, so that one is a new composition of those parts. `snapshot-parts.tsx` is new in Swellwright. `panel-data.tsx`, `panel-format.tsx`, `panel-reads.ts` and `host-lookups.ts` are new in Swellwright. The API console (ADR 0046, `apps/web/src/panel/api-console/`) has no counterpart in the panel and is a new composition of the panel's parts: `history-card.tsx` is adapted from the Users page and its table widget like `snapshots-page.tsx` (a titled card with a `@kastov/mantine-react-table-open` table and soft icon row actions), `response-card.tsx` from the code card of the config-profile and template pages (Monaco in the panel's theme, here read only), `request-card.tsx` and `operation-list.tsx` from the panel's settings cards and `OverlayHeader`; `console-model.ts` and `console-parts.tsx` are new in Swellwright. No library was added; the panel's name, logo and links are not used.

## Agent UI checklist

`.agents/skills/swellwright-ui/reference/web-interface-guidelines.md` is the pinned
Web Interface Guidelines checklist from `vercel-labs/web-interface-guidelines`,
commit `434b7f91364665f2f733b310ec54809bf8f37937`, MIT, Copyright (c) Vercel.
The attribution is retained in the file; the MIT license is alongside it in
`reference/LICENSE.vercel`. It is a development checklist, not runtime application code.

## Checks page (`apps/web/src/checks`)

The Checks page (ADR 0044) is adapted from the same Remnawave panel frontend 3.4.11 (Copyright (C) 2025 Remnawave, AGPL-3.0-only); each file names its origin in its first lines. Origins, under `src/` of the panel: `checks-page.tsx` from the header card of its pages and the tabbed settings pages (`widgets/dashboard/subscription-settings/settings/subscription-tabs.widget.tsx`); `conventions-tab.tsx`, `reconciliation-tab.tsx` and `rules-card.tsx` from the metric-card strip of its Nodes page and the table cards of its Users and request-history pages (`widgets/dashboard/users/users-table`); `finding-drawer.tsx` from the read-only drawers of its lists (`shared/_modals/hosts`, `config-profiles`); `impact-tab.tsx` and `pack-card.tsx` from the editor cards of its config-profile and template pages (`widgets/dashboard/config-profiles/config-editor`) and its drawers with a sticky footer (`shared/ui/drawer-footer`). `checks-api.ts`, `checks-data.ts`, `checks-format.tsx` and `preview-impact.tsx` are new in Swellwright. No library was added: the pack format is read with `yaml` and `zod`, which the repository already used, and the pattern engine, the JSON Patch and the impact table are written for this project (`packages/conventions`). No Remnawave name, logo or link is used.

## Baseline page (`apps/web/src/baseline`)

The dashboard on the Overview page (ADR 0047, `apps/web/src/overview.tsx` and `apps/web/src/dashboard/`) is adapted from the same Remnawave panel frontend 3.4.11 (Copyright (C) 2025 Remnawave, AGPL-3.0-only); each file names its origin in its first lines. Origins, under `src/` of the panel: `overview.tsx` and `sections.tsx` from the home page and its recap widgets (titled sections of metric cards with the panel's breakpoints and entrances); `fleet-section.tsx` from the Users page and its table widget (a metric strip over a titled card with a `@kastov/mantine-react-table-open` table, filters under the head and soft icon row actions); `attention-card.tsx` has no counterpart in the panel and is a new composition of its parts (the titled card, soft icons, the empty layout). `hidden.ts`, `attention-links.ts` and `props.ts` are new in Swellwright. No library was added; the panel's name, logo and links are not used.

The Baseline page (ADR 0045) is adapted from the same Remnawave panel frontend 3.4.11 (Copyright (C) 2025 Remnawave, AGPL-3.0-only); each file names its origin in its first lines. Origins, under `src/` of the panel: `baseline-page.tsx` from the Hosts and Nodes pages (the header card with its icon actions and the `@kastov/mantine-datatable` list) and the metric cards of the home page; `check-drawer.tsx` and `baselines-drawer.tsx` from the panel's detail and edit drawers (`OverlayHeader`, `SectionCard`, the sticky `DrawerFooter`) and its Monaco editor with a validation under it; `run-checks-dialog.tsx` from its modals; `baseline-card.tsx` from its settings cards. `baseline-parts.tsx` is new in Swellwright. No library was added; the panel's name, logo and links are not used.
