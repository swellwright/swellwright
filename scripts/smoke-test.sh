#!/usr/bin/env bash
# Smoke test of a running Swellwright stack (deploy/compose): the server is ready, serves the console with its
# security headers, leaves the API alone, and the first-run setup works with the right token only.
# It creates the owner, so run it against a stack you are about to throw away.
# It does not start Compose. Set SW_TRUSTED_PROXIES=false before starting a direct-access smoke stack.
#
# Usage: scripts/smoke-test.sh <base url> <setup token>
#   scripts/smoke-test.sh http://127.0.0.1:3100 "$SW_SETUP_TOKEN"
set -euo pipefail

base="${1:?usage: smoke-test.sh <base url> <setup token>}"
token="${2:?usage: smoke-test.sh <base url> <setup token>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# 1. Ready: Postgres and Valkey answer and every migration is applied. The server needs a moment to start.
code=000
for _ in $(seq 1 45); do
  code="$(status "$base/api/v1/ready" || true)"
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || fail "/api/v1/ready answered $code"
pass "ready (database, cache and migrations)"

# 2. The console: the page, its security headers, a hashed asset that may be cached for good.
curl -fsS -D "$work/page.headers" -o "$work/page.html" "$base/"
grep -q '<div id="root">' "$work/page.html" || fail "the page is not the console"
grep -qi '^content-security-policy:.*frame-ancestors' "$work/page.headers" || fail "no content security policy"
grep -qi '^cache-control: no-cache' "$work/page.headers" || fail "the page may be cached"
pass "the console is served with its headers"
asset="$(grep -o '/assets/[^"]*\.js' "$work/page.html" | head -n 1)"
[ -n "$asset" ] || fail "the page names no script"
curl -fsS -D "$work/asset.headers" -o /dev/null "$base$asset"
grep -qi '^cache-control: public, max-age=31536000, immutable' "$work/asset.headers" || fail "the asset is not cached for good"
pass "hashed assets are cached for good"
# The console has real URLs: a deep link opens the same page, with the same headers.
curl -fsS -H 'accept: text/html' -D "$work/deep.headers" -o "$work/deep.html" "$base/dashboard/security/users"
cmp -s "$work/page.html" "$work/deep.html" || fail "a deep link does not open the console page"
grep -qi '^content-security-policy:.*frame-ancestors' "$work/deep.headers" || fail "a deep link has no content security policy"
grep -qi '^cache-control: no-cache' "$work/deep.headers" || fail "a deep link may be cached"
pass "a deep link opens the console"

# 3. The API is still the API: JSON, never cached, without the page headers.
curl -fsS -D "$work/api.headers" -o "$work/version.json" "$base/api/v1/version"
grep -q '"version"' "$work/version.json" || fail "/api/v1/version is not the version document"
grep -qi '^cache-control: no-store' "$work/api.headers" || fail "an API answer may be cached"
if grep -qi '^content-security-policy:' "$work/api.headers"; then fail "an API answer carries the page policy"; fi
[ "$(status "$base/api/v1/nothing-here")" = 404 ] || fail "an unknown API path is not 404"
[ "$(status "$base/nothing-here.js")" = 404 ] || fail "a missing file is not 404"
# The artifact catalogue is part of the API and sits behind the sign-in (the image carries the artifacts themselves).
[ "$(status "$base/api/v1/artifacts")" = 401 ] || fail "the artifact catalogue is not there, or is not behind the sign-in"
pass "the API answers as before"

# 4. First run: nobody yet, the wrong token is refused, the right one creates the owner, once.
grep -q '"initialized":false' < <(curl -fsS "$base/api/v1/setup/status") || fail "the instance is already set up"
body() { printf '{"setupToken":"%s","username":"owner","password":"correct-horse-battery-staple"}' "$1"; }
code="$(status -X POST -H 'content-type: application/json' -d "$(body wrong-token-wrong-token)" "$base/api/v1/setup/owner")"
[ "$code" = 403 ] || fail "a wrong setup token answered $code, not 403"
code="$(status -X POST -H 'content-type: application/json' -d "$(body "$token")" "$base/api/v1/setup/owner")"
[ "$code" = 200 ] || fail "the setup token was refused ($code)"
grep -q '"initialized":true' < <(curl -fsS "$base/api/v1/setup/status") || fail "the owner was not created"
code="$(status -X POST -H 'content-type: application/json' -d "$(body "$token")" "$base/api/v1/setup/owner")"
[ "$code" = 409 ] || fail "a second setup answered $code, not 409"
pass "first-run setup: wrong token refused, owner created once"

echo "smoke test passed"
