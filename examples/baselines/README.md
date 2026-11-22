# examples/baselines

Example baselines: documents that say what a healthy server of your fleet looks like, which Fleet > Baseline checks over SSH.

- [`fleet-node.example.yaml`](fleet-node.example.yaml): the checks of a node with names, ports and paths that are **not** the node installer's defaults. Every value is a placeholder; change them to your own.

To use one: open Fleet > Baseline > Baselines > **New baseline**, paste the file, read what the editor says about it (problems are underlined with their line), name it and save. Then assign it to servers or to a tag. The same through the API: `POST /baselines/validate` checks a text and saves nothing; `POST /baselines` saves it; `PUT /baselines/{id}/assignments` says which servers and tags it applies to.

The format, the comparators, the catalogue of observations and what a result can be: [`docs/en/baselines.md`](../../docs/en/baselines.md). The design: [ADR 0045](../../docs/adr/0045-baseline-checks.md).

A test (`apps/api/src/baseline/diff-document.test.ts`) keeps the example valid, so a renamed kind or a changed parameter breaks the build and not the first person who tries the file. An example must hold nothing that belongs to an installation: no real domain, address, token or name. Documentation addresses (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) and `example.com` are the only ones to use.
