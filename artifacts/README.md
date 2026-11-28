# Artifacts

An artifact is a file that Swellwright ships to a server and runs there: immutable once released, versioned, and verified by its SHA-256. Everything Swellwright changes on a node goes through an artifact (design principle 10 and policy P-009 in [`docs/en/design`](../docs/en/design/00-index.md)), so what runs on your servers is a file you can read, run by hand and compare with its hash, not a command assembled at run time.

| Artifact | What it is |
| --- | --- |
| [`node-installer`](node-installer/README.md) | Installs and hardens a Remnawave node: preflight and verify (read-only), firewall, fail2ban, Docker, the node API port open to the panel only, nginx default site, HAProxy SNI routing, the node container, SSH, rename. |

The catalogue is served by the API (`GET /artifacts`) and shown in the console (Operations, Artifacts); an artifact is pushed to a server from the server's drawer. The second planned artifact is the `node-engine` (snapshot, undo plan and a safety timer for SSH and firewall changes). Decision record: [ADR 0036](../docs/adr/0036-node-installer-artifact.md).

## What is in an artifact directory

```
artifacts/<name>/
  install.sh        the file that runs on the server (POSIX sh)
  manifest.json     what it is: name, version, SHA-256, size, steps, parameters (generated, never edited by hand)
  releases.json     version history with SHA-256 and size (written by the tool, append-only after merge)
  README.md         for people; its step and parameter tables are generated from the manifest
  test/             the test suite (runs with stubbed commands in a temporary root, never on a real system)
```

## The manifest

`manifest.json` is built by `scripts/artifact-manifest.mjs` from the script itself. The script carries `#@meta`, `#@step` and `#@param` lines, one JSON object each, and the tool turns them into the manifest. Nothing in the manifest is typed by a person, so it cannot disagree with the script.

| Field | Meaning |
| --- | --- |
| `name`, `version`, `description` | The artifact and its semantic version (`INSTALLER_VERSION` in the script). |
| `file`, `interpreter` | The file to run and the interpreter (`sh`). |
| `sha256`, `size` | The digest and the byte size of the file. |
| `minOs` | The systems it is written for. |
| `steps[]` | `id`, `title`, `readOnly` (it changes nothing), `needsRoot`, `inFull` (run by the `full` action), `params` (read by the step), `requires` (the step stops without them when it cannot ask). |
| `params{}` | Per parameter: `group` (`node` or `installer`), `description`, `required` (some step requires it), `secret`, `pattern` or `enum`, `default`, `example`. A secret is never printed or logged. |

A pattern or a default written as `@NAME` in a `#@param` line is the text of the assignment `NAME=...` in the script, so the regular expression that validates an input and the pattern in the manifest are one text.

`sha256` and `size` are computed from the bytes of the file as they are on disk (the same bytes Swellwright hashes before an upload); a file that is not valid UTF-8 is refused rather than re-encoded.

## One version, one content

`releases.json` binds every version to its bytes: `{"versions": {"1.0.2": {"sha256": "...", "size": 126265}, ...}}`. Both build and check compare with `SW_ARTIFACT_BASE_REF` (CI uses the PR base or the previous commit on push), or with `origin/main` when available. They reject changes to the base's recorded size or SHA-256, dropping a released version, and removing a released artifact directory. Build records a new version or refreshes an unmerged version entry; with no base available, it refuses to refresh an existing record. Check also requires the current version to match the highest recorded version and its bytes.

The separate **Released artifact integrity** workflow runs the verifier from the trusted PR base and never executes candidate files. A Git error reading a base object fails the check. Install this workflow on the target branch before requiring it; the initial merge is the trust bootstrap and must be reviewed manually.

## How an artifact is verified

The hash is the integrity check. Swellwright checks the file when it starts and again every time the file is used, hashes the bytes before it uploads them, has the server hash what arrived (the temporary file, then the file in its place, `sha256sum` against the same value) and refuses to put anything in place on a mismatch. The script does not check itself; a changed script would check whatever it liked. How the server does this, where a copy goes and what the audit chain records: [ADR 0039](../docs/adr/0039-artifact-distribution.md). The files of this directory are what the container image carries; `node apps/api/dist/admin.js artifacts` checks them against their manifests. You can do the same by hand, see the README of the artifact.

Line endings matter: the hash covers the bytes, and a carriage return breaks `sh`. A `.gitattributes` rule keeps the file `LF`, and `--check` refuses a file that has a `CR`.

## Working on an artifact

```
pnpm run artifacts:build     # rewrite manifest.json and the generated tables of the README, record a new version
pnpm run artifacts:check     # fail when they are out of date or a version changed its bytes (CI runs this)
sh artifacts/node-installer/test/run-tests.sh [filter]
```

Rules:
- A released version is never edited, and the check enforces it (see above). A change to `install.sh` is a new version: raise `INSTALLER_VERSION`, run `artifacts:build`, commit the script, the manifest, `releases.json` and the README together.
- No instance data: no real domains, addresses, keys, names or tokens; documentation ranges (`192.0.2.0/24`, `example.com`) in examples. The repository hygiene check (`scripts/check-hygiene.py`) covers these files too.
- Every change to the system goes through one of a few helpers (`run_cmd`, `q`, `write_file`, `make_dir`, `apt_install`) and every path is written under `$R`, so the tests can run a step in a temporary root with stubbed commands.
