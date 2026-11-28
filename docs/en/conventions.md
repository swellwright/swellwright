# Conventions, reconciliation and impact: writing a convention pack

The Checks page of the console (Panel > Checks) asks three questions about the Remnawave panel that is connected, and none of them changes anything in it:

- **Conventions**: does what is in the panel follow your rules? A rule engine reads every host, node, profile, squad and template and lists what breaks a rule.
- **Reconciliation**: do hosts, nodes and the server inventory agree with each other? A host must point at the node that serves it, a node must have a server, a name must resolve to what the panel says it is.
- **Impact**: what would this change do? A dry run takes a change you have in mind and says which nodes would restart, which hosts and subscriptions change, and what the linter would say afterwards.

Your rules are **data**: a convention pack. Nothing about an installation (a domain, an address, a marker, a naming scheme) is in the code. This page describes the pack format, the rules, the pattern language and what the three checks mean. The design is in [ADR 0044](../adr/0044-conventions-reconciliation-and-impact.md); a pack to start from is [`examples/conventions/convention-pack.example.yaml`](../../examples/conventions/convention-pack.example.yaml).

## The pack

A pack is a YAML or JSON document (JSON is YAML). In the console, **Edit the pack** opens it in an editor that checks it as you type, shows the line of a syntax error and the path of a wrong value, and saves it as a **new version** with a comment. The history keeps every version; **Reset** goes back to the built-in pack without deleting the history. The same through the API: `GET`, `PUT` and `POST .../validate` on `/panel/checks/convention-pack`.

```yaml
format: swellwright.conventions/v1     # required, exactly this
name: My conventions                   # required, 1-100 characters
description: What this pack is for     # optional

scope:                                 # optional: the scope of every rule that has none of its own
  excludeTags: [TEST]
  exclude: ".*[Tt]est.*"

rules:                                 # optional: settings by rule id
  host.sni-explicit:
    severity: error                    # error | warning | info
  node.name-pattern:
    params: { pattern: "[A-Z]{2}-[0-9]{2}" }
    note: Why this rule is set this way  # shown next to the rule
  profile.shared:
    enabled: false                     # switch a rule off

reconciliation: { ... }                # optional, see below
impact: { ... }                        # optional, see below
```

- **Unknown keys are refused.** A typo (`severty`) is an error, not a setting that silently does nothing. An unknown rule id is a warning (a pack written for a newer release still loads).
- A rule that the pack does not name keeps its defaults. The **built-in pack** lists every rule with its default parameters and carries no installation data: no domain, address, marker or pattern. A rule that needs a pattern (`*.name-pattern`, `host.remark-pattern`) has none by default and shows as "needs parameters" until the pack sets one.
- **Keep secrets out of a pack.** It is stored in the database as written (with its comments) and shown to everyone who may read the checks; the audit log records only its hash and size, never the text.
- Limits: 256 KiB of text, 200 rules, 50 tags per scope, patterns of at most 256 characters.
- The pack is kept **per panel connection slot**: it survives a reconnect and a rotated token.
- The hash shown with the pack (SHA-256 of its canonical JSON) lets two installations compare packs without comparing text.

### Scope

A scope says which objects a rule judges. It can be on the pack (`scope`) and on a rule (`rules.<id>.scope`); a rule's own scope **replaces** the pack's, it does not add to it.

| Key | Meaning |
|---|---|
| `tags` | only objects that carry at least one of these tags |
| `excludeTags` | not the objects that carry any of these tags (a tag for test objects, for instance) |
| `match` | only objects whose name (the remark, for a host) matches this pattern entirely |
| `exclude` | not the objects whose name matches this pattern entirely |

### Patterns

Patterns in a pack are **not** JavaScript regular expressions. A pack arrives from a person and a pattern is a program: with the engine of the language a pattern like `(a+)+$` takes exponential time on a short value and stops the server. Patterns are matched here with an automaton that never backs up, so the time is the length of the value times the size of the pattern, whatever the pattern is.

A pattern always matches a **whole value** (`^` at the very start and `$` at the very end are accepted and ignored). Supported:

- literals, `.`, and escapes `\d \D \w \W \s \S \p{...} \P{...} \uXXXX \u{...} \xHH \n \t \r` and an escaped symbol
- classes `[A-Z0-9_-]` (members, ranges, `^` for negation, the same escapes inside), groups `( )`, `(?: )`, named groups (they do not capture), alternation `|`
- quantifiers `* + ? {n} {n,} {n,m}`, lazy forms allowed (they change nothing for a yes-or-no match)

`\p{...}` and `\P{...}` take a name from a **fixed list**: a general category (`L`, `Lu`, `Ll`, `N`, `Nd`, `P`, `S`, `Z` and the others of the standard, short or long), a binary property (`Alphabetic`, `Uppercase`, `Lowercase`, `White_Space`, `Emoji`, `Emoji_Presentation`, `Extended_Pictographic`, `Regional_Indicator`, `ASCII`, `Any` and a few more) or `Script=` (or `sc=`, `Script_Extensions=`, `scx=`) with `Latin`, `Cyrillic`, `Greek`, `Han`, `Hiragana`, `Katakana`, `Hangul`, `Arabic`, `Hebrew`, `Thai`, `Devanagari`, `Armenian`, `Georgian` or `Common`. Anything else is refused with the position, so that what a pack may ask of the language's engine is known. No other text of a pack reaches that engine: the shorthands, the dot and the classes are decided by code of Swellwright, and a test compares them with the engine over every character where the two could differ.

Refused, with the character position: back-references, lookahead and lookbehind, word boundaries (`\b`), an anchor in the middle, a quantifier on nothing, a count above 64, a pattern longer than 256 characters or one that needs more than 5000 automaton states. A value longer than 512 characters does not match. When you save, every pattern is checked, so the editor tells you what is wrong before anything runs.

## The rules

`GET /panel/checks/rules` (and the table on the Conventions tab) lists every rule with its parameters, defaults and how the active pack sets it. A finding has a severity, the object, the rule, a text in the language of the user, the fields involved as JSON Pointers into the editable form of the object, and, when there is an obvious fix, a **hint** (`replace /address with ...`). A hint is information: nothing applies it.

| Rule | Object | Default | What it finds | Parameters |
|---|---|---|---|---|
| `host.address-policy` | host | warning | the address is empty, or is not what the policy wants | `policy`: `any`, `ip`, `domain` |
| `host.sni-explicit` | host | warning | a host without an SNI (not one that takes the security of an inbound that has none) | |
| `host.remark-unique` | host | warning | an empty remark, or one that two hosts share | `caseSensitive` |
| `host.remark-pattern` | host | warning | a remark that does not match the pattern | `pattern` (required) |
| `host.inbound-exists` | host | error | a host bound to no inbound, a missing profile or inbound, or an inbound of another profile | |
| `host.serving-node` | host | warning | no node serves the host's inbound, or the node it is assigned to is missing or does not serve it | |
| `host.state` | host | info | a host that is disabled or hidden | `report` |
| `host.sni-in-inbound-names` | host | warning | an SNI that its REALITY inbound does not list among its server names | |
| `host.vless-route-id` | host | warning | a `vlessRouteId` that is reserved, out of range, or (optionally) shared | `reserved`, `max`, `warnOnDuplicates` |
| `node.has-host` | node | warning | a node that no host points at | |
| `node.disabled-referenced` | node | warning | a disabled node that is the last server of an inbound or is still assigned to a host | |
| `node.version-skew` | node | warning | node or Xray version that differs from the others, or a panel of another release line | `checkNodeVersion`, `checkXrayVersion`, `sameLineAsPanel` |
| `node.address-valid` | node | error | an address that is neither an IP nor a domain name | |
| `node.profile-assigned` | node | warning | no profile, a profile that does not exist, or no active inbounds | |
| `node.plugin-exists` | node | error | a node that uses a plugin the panel does not have | |
| `node.name-pattern` | node | warning | a name that does not match the pattern | `pattern` (required) |
| `profile.inbound-tag-unique` | profile | error | an inbound tag used twice, in one profile or across profiles (tags are global in the panel) | |
| `profile.inbound-port-clash` | profile | error | two inbounds that one node has **active** together on the same port (a warning, `possible_clash`, over all inbounds when no node has any active) | |
| `profile.snippet-exists` | profile | error | a configuration that uses a snippet the panel does not have | |
| `profile.name-pattern` | profile | warning | a name that does not match the pattern | `pattern` (required) |
| `profile.unused` | profile | info | a profile no node uses, or one with no inbounds | |
| `profile.shared` | profile | info | a profile used by at least `minNodes` nodes (editing one inbound of it restarts all of them) | `minNodes` |
| `squad.internal-empty` | internal squad | warning | a squad with no inbounds or no members | |
| `squad.inbound-exists` | internal squad | error | a squad that lists an inbound the panel does not have | |
| `squad.name-pattern` | squad | warning | a name that does not match the pattern | `pattern` (required), `kinds` |
| `squad.external-template-exists` | external squad | error | a squad that points at a missing template, or one of the wrong type | |
| `template.name-pattern` | template | warning | a name that does not match the pattern | `pattern` (required) |
| `template.body-present` | template | error | a template whose body was read and is empty or cannot be parsed (a body that was not read is `not_loaded`, information) | `types` |
| `template.unused` | template | info | a template no external squad and no host uses (not the `Default` template of a type) | `ignoreNames` |
| `panel.token-expiry` | panel | warning | the token Swellwright uses expires within `warnDays` days, or has expired | `warnDays` |

A rule needs some kinds of object to be read (`needs`). If the token of the connection cannot read one of them, the rule is **skipped and listed as skipped** with what it was missing; the rest of the run is not affected. A rule that throws is isolated and listed as failed, and the other rules still run. A run lists at most 5000 findings and says when it was cut.

### Findings are about the panel, not about secrets

The checks read the panel through masked views: a private key, a short id or a subscription URL never reaches a rule, a finding, the audit log or a log line. A finding about a secret says only that it is there or that it changed.

## Real shapes: what a real Remnawave 3.4.11 fleet looks like

The first fake panel was tidy: bodies in every list, one inbound for each profile, one host for each node. A real fleet is not, and a rule written against the tidy one gives false results (ADR 0044, note of 2026-11-22). These are the facts about **Remnawave panel 3.4.11** that a rule author needs. They come from running the checks read-only against a real panel; the fixture `realLayout()` in `packages/conventions/src/test-model.ts` has this shape, and a rule that is not tested against it is not finished.

| Fact | What it means for a rule |
|---|---|
| **A list is not the detail.** The list of subscription templates is documented "without content": `templateJson` and `encodedTemplateYaml` are `null` for every template, and the body is in `GET /api/subscription-templates/{uuid}` only. The list of node plugins may leave `pluginConfig` out the same way. | Never read "null" in a list as "empty". A view says whether it was read (`bodyLoaded`, `configLoaded`); judge only what was read. The linter, the calculator and the snapshots are handed views that were read with the detail; a rule that gets one that was not says "not read" (information), not "missing". |
| **A profile holds one inbound for each node.** The common layout is one config profile with an inbound for every node (twelve inbounds, every one on port 443, a tag for each), and two profiles with one inbound each. | Inbounds that are never active together on one node do not clash. Compare per node. |
| **Every node activates exactly one inbound** (`node.configProfile.activeInbounds` has one entry on each). Xray runs only the active inbounds of a node. | "The nodes that use a profile" is not "the nodes that serve an inbound": use `ModelIndex.nodesServing` and `servingNodes` (active inbounds), not the list of inbounds of the profile. Editing the profile restarts all its nodes (twelve); editing a squad's inbound restarts the nodes that have it active (one). |
| **A node has a host for each subscription template.** Hosts come in pairs (a "global" and a "selective" entry of one node) with the same address, port, SNI and inbound, and differ in the remark, the position, the uuid and `xrayJsonTemplateUuid`. | Equal address, port, SNI and inbound is not a duplicate. A duplicate is equal in everything that selects what a client gets (see `host.duplicate` below). |
| **Each type has a template named `Default`** (the panel's own UI treats that name as the mark of the default and does not let it be deleted), which the panel uses on its own for every squad and host that names none. A real panel has the five types (`XRAY_JSON`, `MIHOMO`, `STASH`, `CLASH`, `SINGBOX`) and other templates besides. | "No squad and no host names it" does not make a `Default` template unused. |
| **A host with no SNI is not always wrong**: a host that takes the security of an inbound that has none (plain) needs no SNI. | Look at the inbound before asking for an SNI. |
| **Test objects are in the panel too** (hosts and templates made to try a client). | A scope by tag (`excludeTags`) is how a pack leaves them out; do not assume that every host is production. |

Two further habits. A rule must be correct for the layout it has not seen, so it asks the model for **relations** (which nodes serve this inbound, which hosts use this template) rather than counting objects. And a finding that is true but expected on the common layout (`profile.shared`, a profile used by twelve nodes) is **information**, never a warning.

## Reconciliation

`GET /panel/checks/reconciliation` (`?refresh=true` asks the panel again and forgets the memory of DNS) compares hosts, nodes and the **server inventory** of Swellwright, and looks up the names in DNS. It returns rows; a row has a **status**:

| Status | Meaning |
|---|---|
| `ok` | as expected |
| `drift` | the two sides disagree (a host points at an address that is not the node's) |
| `missing` | the other side has no counterpart (a node the inventory does not know, a name without a record) |
| `extra` | the inventory holds something the panel does not (a server with no node; retired servers are never reported) |
| `unknown` | it could not be decided: a name did not resolve in time, or no node serves the host's inbound. This is a row, never an error of the whole report |

The checks, each of which a pack can switch off (`reconciliation.checks.<id>.enabled: false`):

| Check | Compares |
|---|---|
| `host.address` | the host's address with the node that serves it |
| `host.sni` | the host's SNI with the node's address |
| `host.port` | the host's port with the port of its inbound |
| `host.node` | the nodes a host is assigned to exist and serve its inbound |
| `host.duplicate` | two enabled hosts that give a client the **same entry**: equal in address, port, SNI, host header, path, ALPN, fingerprint, security layer, inbound, nodes, subscription template, route id, options, squad filter, tags and description. The remark, the position and the uuid are not part of the key, so a "global" and a "selective" host of one node are not duplicates. Status `drift`, for an exact duplicate only |
| `node.dns` | the node's name resolves (to an IP, within the TTL the pack allows) |
| `node.disabled-resolving` | a disabled node whose name still resolves |
| `node.duplicate` | two nodes with one address |
| `node.server` | a node has a server in the inventory (matched by address, by DNS, or by the host name the facts reported) |
| `server.node` | a server of the inventory has a node |
| `server.duplicate` | two servers with one address |

Settings in the pack:

```yaml
reconciliation:
  hostAddress: node          # node (default) | node-ip | node-address | none
  hostSni: none              # none (default) | node-address
  hostPort: none             # none (default) | inbound
  dns:
    enabled: true
    maxTtlSeconds: 3600      # a record with a longer TTL is reported with a hint
  inventory:
    matchBy: [address, dns, hostname]
    reportUnmanaged: true
    reportExtra: true
  checks: { server.duplicate: { enabled: false } }
  scope: { excludeTags: [TEST] }
```

`hostAddress`: `node` accepts the node's address, an IP of the node, or a name that resolves to an IP of the node; `node-ip` demands an IP of the node; `node-address` demands exactly the address the panel has for the node; `none` does not check.

**DNS is looked up under limits.** One lookup per distinct name per run, with a per-lookup timeout, a cap on names per run, bounded concurrency, a CNAME chain limit, a short memory of answers, and a rate limit per user for the whole report. Names are resolved by the machine Swellwright runs on, or by the servers named in `SW_CHECKS_DNS_SERVERS`. An answer that points at an address the SSH layer would refuse to connect to (loopback, link local, private and so on, unless the instance allows them) is reported as `resolves to a refused address` and is not followed. A name that is not looked up because of the cap is `unknown` with the reason `dns_skipped_cap`, and the report says how many.

Reconciliation is **check only**. A row's fix is a hint of what a later, approved write would do; nothing here writes to the panel, to DNS or to the inventory. It writes no audit record either, because it changes nothing.

## Impact: the dry run

`POST /panel/impact` takes a kind (`configProfile`, `internalSquad`, `host`, `node`, `subscriptionTemplate`), the object's `uuid`, and a **change**: either an object with the fields to change (fields you leave out stay as they are) or a **JSON Patch** (RFC 6902) against the editable form of the object. `GET /panel/impact/target` gives that form (secrets masked), which is what the console's editor starts from. A patch has a budget: the document it leaves holds at most a million values and its operations together clone or compare at most four million (a `copy` is measured before it is made), so a patch that keeps copying a growing subtree is answered 400 `validation_failed` instead of filling the memory of the API. The answer has:

- the **restarts**: which nodes restart, stop or start, each with the rule that says so;
- the **rules** that were applied, each labelled **observed** (seen on a real panel), **documented** (the panel's documentation says so) or **assumed** (reasoned, not seen), so that you know how far to trust it;
- the **risk level** (`low`, `medium`, `high`) with the reasons;
- the **users** online on the nodes that would restart (the number the panel reports, not a promise);
- the **hosts and subscriptions** that change, **dangling references** the change would leave, hosts left without a serving node;
- what the linter would say about the result: findings **introduced** and findings **fixed** by the change;
- a **safer way** when there is one (for the shared-profile case: clone the profile for the node that needs the change);
- **notes**: fields ignored because they are not part of the form, a configuration that was not read, a panel of another release line than the table was written for, a changed secret.

It is a pure calculation on what the panel last reported: it does not send the change to the panel, writes no audit record, and never repeats a value of the proposal in its answer.

The rule table (version `3.4`, for Remnawave 3.4.x):

| Rule | Effect | Basis |
|---|---|---|
| `profile.config-edit` | editing the configuration of a profile restarts Xray on **every node of the profile**, even when one inbound changed | observed |
| `profile.name-only` | renaming a profile or changing its tags restarts nothing | assumed |
| `squad.inbounds-changed` | changing the inbounds of an internal squad restarts the nodes that serve the added or removed inbounds | observed |
| `squad.members-changed` | adding or removing members restarts no node | assumed |
| `squad.metadata-only` | renaming a squad or changing its tags restarts nothing | assumed |
| `node.profile-move` | moving a node to another profile restarts that node only | documented |
| `node.active-inbounds-changed` | changing the active inbounds of a node restarts that node only | documented |
| `node.disable` | disabling a node stops it and disconnects its users | documented |
| `node.enable` | enabling a node starts it | assumed |
| `node.connection-changed` | changing the address or port makes the panel connect again, which restarts Xray on that node | assumed |
| `node.metadata-only` | name, tags, note and the like restart nothing | assumed |
| `host.edit` | editing a host restarts no node; the subscriptions that include the host change | documented |
| `template.edit` | editing a subscription template restarts no node; the subscriptions that use it change | documented |

When the panel is of another release line than the table, the answer says so; the numbers are then a guess.

```yaml
impact:
  highRiskRestartNodes: 3    # a change that restarts at least this many nodes is high risk
  highRiskRestartShare: 0.5  # or at least this share of the running nodes
```

The level is the highest of the reasons, and every reason is listed with it. **High**: restarts at or above either limit, references that would point at an inbound that no longer exists, hosts left with no node serving their inbound, a change that introduces a convention error. **Medium**: some node restarts, the profile is shared by several nodes, users are online on the nodes that would restart, the change introduces warnings, the change replaces a masked secret. **Low**: nothing restarts and nothing else is wrong.

## Who may do what

| Action | Needs |
|---|---|
| run the conventions and reconciliation, list rules, read the pack and its history, calculate an impact | `panel:read` |
| save, validate-and-save or reset the pack | `panel:write`, with a step-up (an authenticator code) |
| import the pack from a file | the same as saving: the console loads the file into the editor, and saving is the `PUT` |
| export the pack (YAML or JSON) | `panel:read`: it is the `GET` of the pack |

`POST .../validate` needs only `panel:read`: it checks a pack and saves nothing. An API token may do whatever its permissions and the owner's role allow, except routes that need a step-up. Reconciliation compares the server inventory only when the caller may read servers; otherwise it says that the inventory was not compared.

Every change of the pack is an audit event in the same transaction as the change: `panel.convention_pack.saved` (version, hash, name, number of rules, source of the text, whether it replaced a version; never the document or the text) and `panel.convention_pack.reset`. A save that changes nothing (the same pack, even with other whitespace) makes no new version.

## Settings of the server

| Variable | Default | Meaning |
|---|---|---|
| `SW_CHECKS_DNS_TIMEOUT_SECONDS` | `3` | timeout of one DNS lookup (0.2-30) |
| `SW_CHECKS_DNS_MAX_NAMES` | `200` | the most names looked up per run (1-2000) |
| `SW_CHECKS_DNS_CONCURRENCY` | `8` | lookups at the same time (1-32) |
| `SW_CHECKS_DNS_CACHE_SECONDS` | `60` | how long an answer is remembered (0-3600; 0 remembers nothing) |
| `SW_CHECKS_DNS_SERVERS` | empty | comma-separated resolver IPs (`IP` or `IP:port`); empty uses the system's resolver |
| `SW_CHECKS_RATE_LIMIT_PER_MINUTE` | `12` | reconciliation runs per user per minute (1-600); `refresh=true` also counts against `SW_PANEL_REFRESH_RATE_LIMIT_PER_MINUTE` |

## Try it without a panel

The package `@swellwright/remnawave` ships a fake panel with a scenario that has things wrong in it on purpose (a host bound to a missing inbound, a duplicated remark, a node nobody points at, a shared profile). `pnpm --filter @swellwright/remnawave run fake-panel -- --scenario checks` starts it; connect it from Panel > Connection, then open Checks.
