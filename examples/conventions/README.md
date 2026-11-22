# examples/conventions

Example convention packs: the rules that the checks of Panel > Checks (the convention linter, reconciliation and the impact calculator) run with.

- [`convention-pack.example.yaml`](convention-pack.example.yaml): a pack with placeholders for a typical scheme (nodes called `CC-NN`, hosts that carry the node name in their remark, an SNI on every host, objects tagged `TEST` left alone, reserved route ids, what reconciliation expects, impact thresholds). Every value is a placeholder; change them to your own.

To use one: open Panel > Checks > Conventions, **Edit the pack**, paste the file (or **Load from a file**), read what the editor says about it, and **Save as a new version**. The history keeps the version before it. The same through the API: `POST /panel/checks/convention-pack/validate` checks a pack and saves nothing; `PUT /panel/checks/convention-pack` saves it.

The format, every rule with its parameters, the pattern language, what reconciliation and the impact calculator mean: [`docs/en/conventions.md`](../../docs/en/conventions.md) ([по-русски](../../docs/ru/conventions.md)). The design: [ADR 0044](../../docs/adr/0044-conventions-reconciliation-and-impact.md).

A test (`packages/conventions/src/examples.test.ts`) keeps the example valid, so a renamed rule or a changed parameter breaks the build and not the first person who tries the file. An example must hold nothing that belongs to an installation: no real domain, address, token or name. Documentation addresses (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) and `example.com` are the only ones to use.
