# ADR 0044: The convention linter, the reconciliation and the impact calculator

Status: accepted

## Context

Phase 3 has the connection to a panel and the read model of its objects (ADR 0041). On top of it the design promises three things (`docs/en/design/04-remnawave-integration.md`, sections 5-7; `03-scenarios.md`; the acceptance line of phase 3 in `11-roadmap.md`): a **convention linter**, **reconciliation** of hosts with nodes and with the server inventory, and an **impact calculator** with a dry run for any edit. The acceptance case is concrete: a dry run of editing one inbound of a shared profile says "restarts N nodes", and reconciliation finds an `address` that drifted from the node that serves the host.

Two constraints decide the shape. First, **conventions are data about an installation**: a naming scheme, a marker for test objects, a reserved range of route ids, a domain pattern. A tool that ships to other people cannot have them in code, and an operator must be able to change them without a release. Second, the three features are **advice on a system that is in production**: they must not be able to change it, they must not be a way to leak the secrets the read model so carefully masks, and they must not be a way to stop Swellwright itself (a pattern that takes exponential time, a DNS name that never answers, a rule that throws).

## Decision

### A package of pure functions

`packages/conventions` holds the engine and has no I/O: it takes a `PanelModel` (what the panel reported, already masked), a resolved pack, and, for reconciliation, the answers of DNS and the inventory, and returns plain values. It reads no clock, network or file. The API loads the model through the cache of the read model (ADR 0041), supplies the DNS lookups and the inventory, and shapes the result. Everything of substance is therefore testable without a database, a panel or a network, and a rule cannot do anything but say what it finds.

### The pack: rules as data

A **convention pack** is a document `swellwright.conventions/v1` (YAML or JSON), checked by a strict Zod schema: unknown keys are refused (a typo is an error, not a setting that does nothing), an unknown rule id is a warning (so a pack for a newer release still loads), every rule parameter is checked by the rule's own schema, and limits are fixed (256 KiB of text, 200 rules, 50 tags per scope, patterns of at most 256 characters). A pack holds, per rule id, `enabled`, `severity`, `params`, `scope` and `note`; a `scope` for the pack as a whole (`tags`, `excludeTags`, `match`, `exclude`; a rule's own scope replaces the pack's); `reconciliation` settings (what a host's address, SNI and port must be, DNS and inventory options, checks to switch off, a scope); and `impact` thresholds (`highRiskRestartNodes`, `highRiskRestartShare`). Format and rule catalogue are documented for authors in `docs/en/conventions.md` (and `docs/ru`).

The **built-in pack** lists every rule with its default parameters and contains **no installation data**: no domain, address, marker or pattern (a test enforces it). Rules that need a pattern (`*.name-pattern`, `host.remark-pattern`) have none until a pack gives one, and show as "needs parameters". An **example pack** with placeholders (`examples/conventions/convention-pack.example.yaml`, kept valid by a test) shows a typical scheme. What a given installation calls its nodes is that installation's pack, not this repository.

**Storage.** `ConventionPack` (migration `20261122120000`): one row per saved version, for the panel key `default` (the pack outlives a reconnect and a rotated token, because the connection row is replaced on reconnect, ADR 0041), with `version`, the validated `document`, the `source` text as written (with its comments), the SHA-256 `hash` of the canonical JSON of the document, `active`, a `comment`, and the user (no foreign key, like the audit chain). Saving is a **new version**; nothing is overwritten; one version is active, and none active means the built-in pack applies. `DELETE` on the pack deactivates the active version (the history stays). Saving the same document again (even with other whitespace) makes no new version. An editor sends `expectedVersion`; if the active pack is another one, the answer is 409 `conflict` and nothing is saved. A saved pack that a later release no longer accepts is not fatal: the run falls back to the built-in pack and says so.

**Audit.** `panel.convention_pack.saved` (version, hash, name, number of rules, source of the text, whether it replaced a version) and `panel.convention_pack.reset`, **strict and in the same transaction** as the change; the document and the text are never in the record.

**Permissions.** Reading, running, validating and calculating need `panel:read`. Saving and resetting need `panel:write` **and a step-up** (a pack decides what the checks report, and what the console calls healthy): the routes declare `stepUp` and the permission test lists them. `POST .../validate` saves nothing and needs only `panel:read`.

### Patterns are not regular expressions

A pattern in a pack is a program written by a person. With the regular expression engine of the language a pattern such as `(a+)+$` takes exponential time on a short value and stops the server, so a pack could be used to stop Swellwright. Patterns are therefore matched by `safe-pattern.ts`: the pattern is parsed into a structure (sequence, alternation, groups, repetition), compiled to a Thompson automaton and run with a set of states that never backs up, so the time is the length of the value times the size of the automaton, **whatever the pattern is**. Single characters (a class, `\d`, `\p{L}`, a dot) are decided by code of the module, so that **no text of a pack is ever given to the regular expression engine**; only the Unicode properties are looked up in it, from a fixed list of constants, and a test compares the module's shorthands, dot and classes with the engine over every character where the two could differ. The language is a **subset** and is **anchored** (a pattern matches a whole value); back-references, lookahead, lookbehind, word boundaries, an anchor in the middle, a quantifier on nothing, counts above 64, a pattern above 256 characters or one that needs more than 5000 states are refused **at save time**, with the position, so the editor says so before anything runs. A value longer than 512 characters does not match. The test suite runs the classical catastrophic patterns against their worst inputs and asserts that they finish in a few milliseconds and still give the right answer.

### The linter

A **rule** is `{ id, kind, defaultSeverity, needs, codes, params (a Zod object, every key with a default), run(context, params) }`. It says what it finds by `emit({ code, subject, params, fields, fix, related })` and can do nothing else. The engine decides the scope, the severity, the text, the order and the limits. 30 rules ship (hosts, nodes, profiles, squads, templates, the panel's token; see `docs/en/conventions.md`). A finding has the object, the rule, the code within the rule, a severity, a message **key with parameters** (the console renders it in the language of the user; the API also gives the English text), the fields involved as JSON Pointers into the editable form of the object, and, when there is an obvious fix, a **hint** (`replace /address with ...`) that nothing applies.

Failure is isolated: a rule that needs a kind of object the token cannot read is **skipped and listed as skipped** with what it was missing; a rule that throws is **listed as failed** and the others run; a run lists at most 5000 findings and says when it was cut. A finding never contains a secret: the rules read the masked views of the read model, and a finding about a secret says only that one is there or that it changed. The test for it plants literals in the fake panel and asserts they are in no answer, no audit record and no log line.

### Reconciliation: what the sides say about each other, check only

`GET /panel/checks/reconciliation` compares the hosts with the nodes that serve them, the nodes with their names in DNS, and the nodes with the server inventory of ADR 0034. It returns **rows** with a status: `ok`, `drift` (the sides disagree), `missing` (the other side has no counterpart), `extra` (the inventory holds something the panel does not; retired servers never), and `unknown` (it could not be decided: a name did not resolve in time, nothing serves the inbound). `unknown` is a row, never an error of the report: the point is to say what could not be decided. Eleven checks (`host.address`, `host.sni`, `host.port`, `host.node`, `host.duplicate`, `node.dns`, `node.disabled-resolving`, `node.duplicate`, `node.server`, `server.node`, `server.duplicate`), each switchable in the pack; what a host's address, SNI and port must be is a setting of the pack (`hostAddress`: `node`, `node-ip`, `node-address` or `none`; `hostSni`; `hostPort`), because installations differ (an IP or a name, an SNI of the node's domain or not) and the defaults assume as little as possible. A node is matched with a server by address, by what the names resolve to, or by the host name the server's facts reported (`matchBy`); a node that matches no server is `missing`, a match with several servers is `drift` with the reason `ambiguous_servers`, and the matching method is in the row.

**DNS is looked up under limits** because the names come from a panel and a pack, and a lookup is a network call: one lookup per distinct name per run, a per-lookup **timeout** (`SW_CHECKS_DNS_TIMEOUT_SECONDS`), a **cap** on names per run (`SW_CHECKS_DNS_MAX_NAMES`, the report says what the cap left out and the rows are `unknown` with `dns_skipped_cap`), bounded **concurrency**, a **CNAME chain limit**, a short **memory** of answers (`SW_CHECKS_DNS_CACHE_SECONDS`; a timeout is never remembered, `?refresh=true` forgets), and a **rate limit** per user (`SW_CHECKS_RATE_LIMIT_PER_MINUTE`, 429 with `Retry-After`). The resolver is a **parameter** of the application (`DNS_QUERY`), the production one on `node:dns` with optional servers (`SW_CHECKS_DNS_SERVERS`), so the tests never touch a network. An answer is filtered by the **address policy of the SSH layer** (ADR 0035): a name that resolves to loopback, link local or another refused address is reported as such and is not followed. A node that is disabled in the panel but still resolves is reported, because that is how stale names are found.

Reconciliation is **check only**. It writes nothing to the panel, to DNS or to the inventory, and writes no audit record because nothing changes. A row's fix is a hint of what a later, approved write would do. The inventory is compared only for a caller with `servers:read`; otherwise the report says it was not compared.

### The impact calculator

`POST /panel/impact` is a **pure function** of the model, the pack and a proposal: the model is not changed (a test compares it before and after), nothing is sent to the panel, the same question gets the same answer, and **no audit record** is written (it changes nothing). The proposal is, for one of five kinds (`configProfile`, `internalSquad`, `host`, `node`, `subscriptionTemplate`), either an object with the fields to change or a **JSON Patch** (RFC 6902, implemented in `json.ts`, with `__proto__`, `constructor` and `prototype` keys refused and limits on size and operations) against the **editable form** of the object, which `GET /panel/impact/target` returns (secrets masked, `masked: true` when it holds any). A field that is not part of the form is **ignored and reported**, an identity cannot be changed, and a masked value left as it is means "keep the secret" while any other value in its place is reported as a changed secret and is never repeated in the answer.

The answer is built from a **versioned rule table** (`IMPACT_RULES`, version `3.4`: Remnawave 3.4.x). Every rule carries its **basis**: `observed` (seen on a real panel: editing one inbound of a shared profile restarts every node of the profile; changing the inbounds of a squad restarts the nodes that serve them), `documented`, or `assumed` (reasoned, not seen: renaming restarts nothing), so the reader knows how far to trust it; the answer lists the rules it applied. For a panel of another release line the answer says so. From the rules come the **restarts** (node, action `restart`, `stop` or `start`, the rule), the changed and dangling **inbound references**, hosts left **unserved**, the **users online** on the nodes that restart (the number the panel reports), the subscriptions that change, the **findings the linter would raise after the change** that it does not raise now (**introduced**) and those it would no longer raise (**fixed**; computed by running the same rules on the model before and after), a **risk level** with every reason (`high`: restarts at or above `highRiskRestartNodes` or `highRiskRestartShare`, dangling references, unserved hosts, introduced errors; `medium`: some restart, a shared profile, users online, introduced warnings, a changed secret), and, when there is one, a **safer way** (for the shared profile: clone it for the node that needs the change). Answers for a kind the token cannot read are 502 `panel_forbidden` naming the resource; an object the panel does not have is 404; a change that cannot be applied (a patch that fails, a value of the wrong type) is 400 `validation_failed` naming the operation.

### Routes

All under the Panel tag, all `panel:read` unless noted, all answering with the panel's error codes (409 `panel_not_connected`, 502 `panel_forbidden`, `panel_unreachable`, `panel_timeout` and the rest of ADR 0041):

| Route | What |
|---|---|
| `GET /panel/checks/rules` | the catalogue with parameters, defaults and the effect of the active pack |
| `GET /panel/checks/convention` | run the conventions (`?refresh=true`) |
| `GET /panel/checks/convention/last` | what the last run found, without running anything (the Overview card) |
| `GET /panel/checks/reconciliation` | run the reconciliation (`?refresh=true`; 429 over the rate limit) |
| `GET /panel/checks/convention-pack` | the pack in use or a version of the history (`?version=`), as a document and as the text written |
| `PUT /panel/checks/convention-pack` | save a new version (`panel:write`, step-up; 400 with the issues, 409 `conflict`) |
| `DELETE /panel/checks/convention-pack` | back to the built-in pack (`panel:write`, step-up) |
| `GET /panel/checks/convention-pack/versions` | the history |
| `POST /panel/checks/convention-pack/validate` | check a pack, save nothing: syntax errors with the line, wrong values with the path, unknown rules as warnings |
| `GET /panel/impact/target` | the editable form of an object |
| `POST /panel/impact` | the dry run |

OpenAPI 0.25.0. The contracts are in `packages/contracts/src/checks.ts`; every answer is checked against its schema in the tests.

### The console

**Panel > Checks** is one page with three tabs, in the panel's look (ADR 0032, 0033: the header card, the tab bar, metric cards, `@kastov/mantine-react-table-open` cards with column filters, drawers with the panel's cards, status chips, Monaco in a titled card):

- **Conventions**: a strip of cards (errors, warnings, information, objects with findings, rules run), the table of findings (severity, kind of object, object, rule, finding; filters per column; a drawer per finding with the fields involved, the related objects and the fix hint), the pack card (its name, version, hash, who saved it and when; **Edit the pack**, **Export as YAML**, **Load from a file**, **Reset**), and the table of the rules with the state the pack gives them. The pack editor is a drawer with Monaco in YAML, validation as you type, the issues listed with their lines and paths, a comment, **Save as a new version** (step-up on demand, a conflict says to reload), and the history tab (**Load into the editor** puts an old version in the editor to be saved as a new one).
- **Reconciliation**: cards per status, the table of rows with a drawer (expected and actual, the counterpart, the reason, the hint), the DNS line (names, resolved, failed, left out, answers from memory) and the inventory line (whether it was compared).
- **Impact**: choose a kind and an object (or arrive from a drawer), edit the change as JSON in Monaco (the starting form is masked and says so), calculate; the answer is a risk card, the restarts, the rules with their basis, the hosts and subscriptions, the findings introduced and fixed, the safer way and the notes.

A **Preview impact** button sits in the drawers of profiles, internal squads, hosts and nodes and opens the Impact tab with the object chosen; the **Overview** page gets a card with the last run of the conventions (it never runs them). Texts are in the `checks` namespace (English and Russian) and the texts of the engine are generated from the catalogue so that a rule cannot exist without both; a test compares them. The page and its buttons follow the permissions: a role that cannot write sees the pack but not the buttons that change it.

### Configuration

`SW_CHECKS_DNS_TIMEOUT_SECONDS` (3), `SW_CHECKS_DNS_MAX_NAMES` (200), `SW_CHECKS_DNS_CONCURRENCY` (8), `SW_CHECKS_DNS_CACHE_SECONDS` (60), `SW_CHECKS_DNS_SERVERS` (empty: the system's), `SW_CHECKS_RATE_LIMIT_PER_MINUTE` (12). The image carries `packages/conventions` (the Dockerfile copies it, as the smoke test requires of every package the server imports).

## Consequences

- An operator can write the conventions of an installation without a release, share them as a file, keep a history and see who changed what; Swellwright's code names nobody's naming scheme.
- The three features cannot change the panel, DNS or the inventory: they take no write client, and a test asserts that the fake panel received only `GET` requests while the checks and a dry run ran.
- A hostile pack, a hostile DNS answer and a rule that fails each cost bounded time and memory and show up as a message, not as an outage.
- No dependency was added: `yaml` and `zod` were already in the tree (JSON Patch and the pattern engine are ours, about 1000 lines with tests).
- The impact table is **knowledge about Remnawave 3.4.x**, labelled with its basis, and it can be wrong when the panel changes; it is versioned, shown with every answer, and a panel of another release line gets a warning. Rows marked `assumed` should be promoted to `observed` or corrected as they are tried on a real panel.
- The numbers for users online come from the panel's last report and may be stale by the cache time; they are shown as a reason for care, not a promise.

## Not built here

Applying a fix hint, or any write (the hints say what a later approved write would do; writes of the panel are a later slice behind the plan and approval flow); snapshots and diff of the panel (the next slice); scheduled runs and alerts on new findings (the Monitoring section); conventions for objects the read model does not have (users, billing); a baseline pack format shared between installations (packs are files, exchanged by hand); a rule written in code by a plugin (a plugin may later contribute rules through the plugin API, which does not exist yet); estimates of restart time ("approximately X-Y s"), which need measurements the calculator does not have; per-object overrides in a pack (a scope is by tag and pattern only).
