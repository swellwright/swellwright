#!/usr/bin/env python3
"""Repository hygiene check (standard library only).

Fails on: secret-looking strings, private-key headers, forbidden file types, e-mail addresses other than
noreply/example ones and the documented AI-assistant attribution addresses (codex@openai.com,
noreply@anthropic.com), oversized files, and any pattern from the SW_FORBIDDEN_PATTERNS environment variable
(newline-separated regexes; keep the real list in CI secrets, never in the repository).
Warns on public-looking IPv4 addresses (allowlist: scripts/hygiene-allowlist.txt, one string per line).

    python3 scripts/check-hygiene.py [path ...]
"""
import ipaddress
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# "generated" is the Prisma client written by `prisma generate` (gitignored build output with sample e-mail addresses in comments).
SKIP_DIRS = {".git", "node_modules", "dist", "build", "generated", ".turbo", ".pnpm-store", "coverage"}
SKIP_FILES = {"LICENSE", "DCO"}
FORBIDDEN_NAMES = re.compile(r"(^\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|(^|/)id_(rsa|ed25519|ecdsa)|\.sqlite3?$|\.dump$)")
ALLOWED_NAMES = {".env.example"}
DETECTORS = [
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("GitHub token", re.compile(r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{40,}")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("Telegram bot token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
]
# The top-level label must be alphabetic, so "pnpm@10.34.9" or "pkg@0.23.6" (name@version) are not e-mails.
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])")
EMAIL_OK = re.compile(
    r"(@users\.noreply\.github\.com$|@example\.(com|org|net)$|@localhost$"
    r"|^codex@openai\.com$|^noreply@anthropic\.com$)",
    re.I,
)
IPV4 = re.compile(r"(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])")
DOC_NETS = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")]
MAX_BYTES = 5 * 1024 * 1024


def relpath(p):
    try:
        return p.relative_to(ROOT).as_posix()
    except ValueError:
        return str(p)


def lineno(text, pos):
    return text.count(chr(10), 0, pos) + 1


def files(paths):
    for base in paths:
        base = Path(base).resolve()
        if base.is_file():
            yield base
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and not (set(relpath(p).split("/")) & SKIP_DIRS):
                yield p


def load_allow():
    f = ROOT / "scripts" / "hygiene-allowlist.txt"
    return {ln.strip() for ln in f.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")} if f.exists() else set()


def main():
    paths = sys.argv[1:] or [ROOT]
    forbidden = [re.compile(x) for x in os.environ.get("SW_FORBIDDEN_PATTERNS", "").splitlines() if x.strip()]
    allow = load_allow()
    errors, warns = [], []
    for p in files(paths):
        rel = relpath(p)
        if p.name in SKIP_FILES:
            continue
        if (FORBIDDEN_NAMES.search(rel) or re.match(r"\.env($|\.)", p.name)) and p.name not in ALLOWED_NAMES:
            errors.append(f"{rel}: forbidden file type")
            continue
        if p.stat().st_size > MAX_BYTES:
            errors.append(f"{rel}: larger than {MAX_BYTES // 1024 // 1024} MB")
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        # Findings are reported as file and line only: the matched value is never printed, so CI logs
        # (which are public for a public repository) cannot repeat what the check has just found.
        for kind, rx in DETECTORS:
            m = rx.search(text)
            if m:
                errors.append(f"{rel}:{lineno(text, m.start())}: {kind} (value not shown)")
        for m in EMAIL.finditer(text):
            if not EMAIL_OK.search(m.group(0)) and m.group(0) not in allow and not m.group(0).startswith("Signed-off-by"):
                errors.append(f"{rel}:{lineno(text, m.start())}: e-mail address (value not shown)")
        for rx in forbidden:
            m = rx.search(text)
            if m:
                errors.append(f"{rel}:{lineno(text, m.start())}: matches a forbidden pattern (SW_FORBIDDEN_PATTERNS)")
        for m in IPV4.finditer(text):
            s = m.group(0)
            try:
                ip = ipaddress.ip_address(s)
            except ValueError:
                continue
            if ip.is_private or ip.is_loopback or ip.is_unspecified or ip.is_link_local or ip.is_multicast or any(ip in n for n in DOC_NETS) or s in allow:
                continue
            warns.append(f"{rel}:{lineno(text, m.start())}: public-looking IPv4 address (value not shown)")
    for w in sorted(set(warns)):
        print("warning:", w)
    for e in sorted(set(errors)):
        print("error:", e)
    print(f"hygiene: {len(set(errors))} error(s), {len(set(warns))} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
