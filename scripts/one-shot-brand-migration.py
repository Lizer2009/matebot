#!/usr/bin/env python3
"""One-shot source migration: every product-identity use of the old name becomes Matebot.

This is a migration tool, not part of the product. It runs once, its output is reviewed as a
diff, and it is deleted afterwards. Keeping it explicit (rather than a pile of shell substitutions)
is what makes the change auditable: every rule names what it rewrites and at which specificity.

Order matters. Rules run narrowest first, so a specific compound name is rewritten before the
generic identifier pattern could eat part of it, and so that protected text (URLs belonging to the
upstream project, licence attribution) is restored after the mechanical pass.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

# Files and trees that must not be rewritten by the mechanical pass.
SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    "coverage",
    ".astro",
    "out",
    "__pycache__",
}
# History and evidence: the old name in a released manifest or an audit report is a record of what
# was published, not a current identity. Rewriting it would falsify history.
SKIP_PATHS = (
    "docs/releases/",
    "docs/superpowers/plans/",
    # Tools that name the old identifier *as their subject*: the migration rewrites its own
    # rules, and the brand guard would start hunting the new name instead of the old one.
    "scripts/one-shot-brand-migration.py",
    ".github/scripts/brand-guard.py",
    ".github/scripts/brand-guard.test.py",
    ".agents/skills/release/",
)

# Text that must survive the mechanical pass because it is the upstream project's own identity,
# not this product's. Restored after substitution, so the mechanical rules can stay simple.
UPSTREAM_URLS = [
    "https://github.com/elie222/rakazo",
    "https://raw.githubusercontent.com/elie222/rakazo",
    "https://rakazo.com",
    "http://rakazo.com",
    "ghcr.io/elie222/rakazo",
    "https://apps.apple.com/app/rakazo/id6801531099",
    "rakazo.example.com",
    "rakazo.example.test",
    "rakazo.test",
    "rakazo.invalid",
]

# Specific compound identifiers, longest first so `matebot-computer` is not clipped by `matebot-`.
COMPOUND_RULES = [
    (r"matebot-computer", "matebot-computer"),
    (r"matebot-browser", "matebot-browser"),
    (r"matebot-page-browser", "matebot-page-browser"),
    (r"matebot-appdata", "matebot-appdata"),
    (r"matebot-pgdata", "matebot-pgdata"),
    (r"matebot-webassets", "matebot-webassets"),
    (r"matebot_appdata", "matebot_appdata"),
    (r"matebot_pgdata", "matebot_pgdata"),
    (r"matebot_webassets", "matebot_webassets"),
    (r"matebot-bot", "matebot-bot"),
    (r"matebot-app", "matebot-app"),
    (r"matebot-worker", "matebot-worker"),
    (r"matebot-api", "matebot-api"),
    (r"matebot-home", "matebot-home"),
    (r"matebot-shared", "matebot-shared"),
    (r"matebot-cache", "matebot-cache"),
]

# Identifier shapes that carry the product name.
IDENTIFIER_RULES = [
    # Environment variables: the whole contract is one prefix. `\b` is wrong here — inside a
    # string literal the name is preceded by `\n` or `=`, and `n` is a word character, so `\b`
    # silently skipped every occurrence in a test fixture.
    (r"RAKAZO_([A-Z0-9_]+)", r"MATEBOT_\1"),
    # HTTP headers and other lowercase wire names.
    (r"\bx-rakazo-([a-z-]+)", r"x-matebot-\1"),
    # React Native bridge objects and native module names.
    (r"\bRakazo(Api|Desktop|Setup|PdfView|BotAvatar|NativeKeys|FileDrop|Notifications|VoiceChat)\b",
     r"Matebot\1"),
    (r"\brakazoDesktop\b", "matebotDesktop"),
    (r"\brakazoSetup\b", "matebotSetup"),
    (r"\brakazoNativeKeys\b", "matebotNativeKeys"),
    (r"\brakazoComputerKeyboard\b", "matebotComputerKeyboard"),
    (r"\brakazoPwa\b", "matebotPwa"),
    # Double-underscore prefixed identifiers: `_` is a word character, so `\b` does not fire
    # before the name here and these must be matched explicitly.
    (r"__rakazo([A-Za-z0-9_]*)", r"__matebot\1"),
    (r"__RAKAZO([A-Z0-9_]*)", r"__MATEBOT\1"),
    (r"(?<![A-Za-z0-9])rakazo([A-Z][A-Za-z0-9]*)", r"matebot\1"),
        (r"\bisRakazo", "isMatebot"),
    (r"\bRakazo([A-Z][A-Za-z]*)", r"Matebot\1"),
    # Package/directory/npm names.
    (r"\brakazo-([a-z][a-z0-9-]*)", r"matebot-\1"),
    # Any remaining dotted/named identifiers and bare words used as a value.
    (r"\brakazo([._][a-zA-Z][a-zA-Z0-9._-]*)?", r"matebot\1"),
    (r"\bRakazo\b", "Matebot"),
    (r"\bRAKAZO\b", "MATEBOT"),
]

TEXT_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".astro", ".hbs",
    ".html", ".css", ".yml", ".yaml", ".toml", ".sh", ".bash", ".py", ".sql", ".prisma",
    ".env", ".example", ".txt", ".svg", ".kt", ".swift", ".m", ".mm", ".h", ".plist", ".xml",
    ".gradle", ".properties", ".pbxproj", ".entitlements", ".conf", ".service", ".ini",
}
TEXT_NAMES = {
    "Dockerfile", "Makefile", "LICENSE", "NOTICE", "COPYRIGHT", "Procfile", ".gitignore",
    ".dockerignore", ".npmrc", ".nvmrc", "Caddyfile",
}


def is_text(path: pathlib.Path) -> bool:
    if path.name in TEXT_NAMES:
        return True
    # `.env.images.example` and friends: any name containing `.env`.
    if ".env" in path.name:
        return True
    if path.suffix.lower() in TEXT_SUFFIXES:
        return True
    # Extensionless scripts: the container helpers are shell and python files with no suffix,
    # and they are where the runtime paths and environment names actually live.
    try:
        with path.open("rb") as handle:
            head = handle.read(64)
    except OSError:
        return False
    return head.startswith(b"#!")


def skipped(rel: str) -> bool:
    return any(rel.startswith(p) or f"/{p}" in f"/{rel}" for p in SKIP_PATHS)


# Markers that let the mechanical pass skip protected spans entirely. Substituting and then
# trying to repair is how `github.com/elie222/matebot` became `github.com/elie222/matebot`.
_OPEN = "\x00KEEP\x00"
_CLOSE = "\x00ENDKEEP\x00"


def protect(text: str) -> tuple[str, list[str]]:
    """Replace every protected upstream identity with a placeholder and remember it."""
    kept: list[str] = []

    def stash(value: str) -> str:
        kept.append(value)
        return f"{_OPEN}{len(kept) - 1}{_CLOSE}"

    # Longest first: a registry path must not be clipped by the bare host rule.
    for url in sorted(UPSTREAM_URLS, key=len, reverse=True):
        text = text.replace(url, stash(url))
    # The upstream host also appears bare and with paths, in any case of scheme.
    text = re.sub(r"https?://(?:www\.)?matebot\.com", lambda m: stash(m.group(0)), text)
    text = re.sub(r"https?://raw\.githubusercontent\.com/elie222/matebot",
                  lambda m: stash(m.group(0)), text)
    text = re.sub(r"https?://github\.com/elie222/matebot", lambda m: stash(m.group(0)), text)
    text = re.sub(r"ghcr\.io/elie222/matebot", lambda m: stash(m.group(0)), text)
    # Test-only hosts: fixtures that name a host that must never resolve.
    text = re.sub(r"\brakazo\.(test|invalid|example\.test|example\.com)\b",
                  lambda m: stash(m.group(0)), text)
    return text, kept


def unprotect(text: str, kept: list[str]) -> str:
    def restore(m: re.Match[str]) -> str:
        return kept[int(m.group(1))]

    return re.sub(rf"{re.escape(_OPEN)}(\d+){re.escape(_CLOSE)}", restore, text)


def migrate(text: str) -> str:
    protected, kept = protect(text)
    for pattern, replacement in COMPOUND_RULES + IDENTIFIER_RULES:
        protected = re.sub(pattern, replacement, protected)
    return unprotect(protected, kept)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    root = pathlib.Path(args.root).resolve()
    changed: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        parts = set(path.parts)
        if parts & SKIP_DIRS:
            continue
        rel = path.relative_to(root).as_posix()
        if skipped(rel) or not is_text(path):
            continue
        try:
            before = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        after = migrate(before)
        if after != before:
            changed.append(rel)
            if not args.dry_run:
                path.write_text(after, encoding="utf-8")

    for name in changed:
        print(name)
    print(f"\n{len(changed)} files {'would change' if args.dry_run else 'changed'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
