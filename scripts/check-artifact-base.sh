#!/bin/sh
# Run a verifier from a trusted base commit against a candidate checkout. Never run files from the candidate.
set -eu
repo=$1
base=$2
case $base in ''|*[!0-9a-f]*) echo "An exact base commit id is required" >&2; exit 1 ;; esac
export GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
git -C "$repo" show "$base:scripts/artifact-manifest.mjs" -- >"$tmp/artifact-manifest.mjs"
SW_ARTIFACT_BASE_REF="$base" SW_ARTIFACT_HEAD_REF="${3:-}" SW_ARTIFACTS_ROOT="$repo/artifacts" \
    node "$tmp/artifact-manifest.mjs" --check
