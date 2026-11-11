#!/usr/bin/env python3
"""
Brand-guard: the product is Matebot, and no old name survives in shipped output.

What this enforces
    Every occurrence of the old name in a scanned tree is a defect, unless the line is credit for
    the Apache-2.0 project this product was forked from. That is the only category left: identity
    (environment variables, headers, storage keys, compose and volume names, database roles,
    native modules, package names, image repositories, host paths) was renamed, so there is
    nothing about it to keep excusing.

    Credit stays because the licence requires it. It is matched by the *meaning* of the line, not
    by a wildcard: a token-shaped allowlist would accept any new identifier that happens to start
    with the six letters, which is exactly the drift this guard exists to catch.

Run:  python3 brand-guard.py
      python3 brand-guard.py --list     show every occurrence with its verdict
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(os.environ.get("BRAND_GUARD_ROOT") or pathlib.Path.cwd()).resolve()

# Trees whose output reaches a user, a running deployment, or the build that produces them.
SCAN_ROOTS = (
    "apps/api/src",
    "apps/web/src",
    "apps/web/index.html",
    "apps/web/e2e",
    "apps/mobile/app",
    "apps/mobile/app.json",
    "apps/mobile/lib",
    "apps/mobile/components",
    "apps/mobile/modules",
    "apps/mobile/plugins",
    "apps/desktop/src",
    "apps/desktop/scripts",
    "apps/desktop/package.json",
    "apps/www/src",
    "apps/www/api",
    "packages/adapters/src",
    "packages/auth/src",
    "packages/contracts/src",
    "packages/core/src",
    "packages/db/src",
    "infra/compose",
    "infra/sandboxes",
    "infra/systemd",
    "infra/updater",
    "docs/self-host.md",
    "docs/self-host-configuration.md",
    "docs/self-host-upgrading.md",
    "docs/MATEBOT_DEPLOY.md",
    "docs/MATEBOT_BRAND.md",
    "examples/plugins",
    "README.md",
    "README.zh-CN.md",
    "README.ja.md",
    "SETUP_PROMPT.md",
)

SKIP_SUFFIXES = (
    ".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx",
    ".snap", ".lock", ".po", ".png", ".jpg", ".webp", ".woff", ".woff2", ".ttf", ".ico", ".svg",
)
SKIP_DIRS = ("node_modules", "dist", "build", "out", ".turbo", "generated", "locales")

TOKEN = re.compile(r"[A-Za-z0-9_./:@${}-]*rakazo[A-Za-z0-9_./:@${}-]*", re.I)

# The upstream project, named exactly. Credit is a line that links to its repository: the licence
# requires naming the source, and a link is unambiguous evidence of what the line is for.
UPSTREAM_REPO = "https://github.com/elie222/rakazo"

# References a migration cannot avoid: an install already has this folder, and a documented path
# is how an operator finds it. Each entry is one file and the marker that identifies the reference,
# so this stays a short, auditable list rather than a shape that accepts any old name.
# References to objects that already exist on an install cannot be renamed, but the desktop app
# no longer reads any such path, so this list is empty rather than carrying dead entries.
MIGRATION_REFERENCES: tuple[tuple[str, str, str], ...] = ()

# A command a reader copies and runs is an instruction for this product, even when it is written
# as prose about the upstream project: it tells them what to install.
COPIED_COMMAND = re.compile(
    r"(git\s+clone\s+\S*rakazo|raw\.githubusercontent\.com/\S*rakazo|curl[^\n]*rakazo"
    r"|mkdir\s+-p\s+rakazo|cd\s+rakazo(?![\w-]))",
    re.I,
)

# Anything a user reads. A hit here is reported separately because it is the defect that matters
# most: the old name shown as this product.
VISIBLE_LINE = re.compile(
    r"""(<title>|aria-label=|placeholder=|alt=|<h[1-6][^>]*>|description=|og:title"""
    r"""|og:description|subject:|message:|label=|title=\{)""",
    re.I,
)


def _iter_files():
    found = 0
    for entry in SCAN_ROOTS:
        path = ROOT / entry
        if not path.exists():
            continue
        if path.is_file():
            found += 1
            yield path
            continue
        for candidate in path.rglob("*"):
            if not candidate.is_file():
                continue
            if any(part in SKIP_DIRS for part in candidate.relative_to(ROOT).parts):
                continue
            if candidate.name.endswith(SKIP_SUFFIXES):
                continue
            found += 1
            yield candidate
    if found == 0:
        # A scan that finds nothing is a broken scan, not a clean repository. Without this the
        # guard reports success from any directory that has none of the scanned trees.
        raise SystemExit(
            f"brand-guard: no files matched SCAN_ROOTS under {ROOT}; "
            "run it from the repository root or set BRAND_GUARD_ROOT"
        )


# Credit that carries no link of its own: a heading naming what the product was built on, where the
# paragraph beneath it points at the upstream repository. Kept to this one shape so a heading that
# names the old product as this product still fails.
BUILT_ON = re.compile(r"^<h[1-6][^>]*>\s*Built on Rakazo\s*</h[1-6]>$|^#+\s*Built on Rakazo\s*$")


# Credit often links through a constant rather than the literal URL, because the site keeps one
# definition of the upstream repository. Recognising the name is what makes those lines credit.
UPSTREAM_CONST = re.compile(r"\{UPSTREAM_URL\}")


def is_attribution(path: pathlib.Path, line: str) -> bool:
    """Whether this line credits the project this product was forked from.

    Credit means a link to the upstream repository, either written out or through the constant the
    site defines for it, or the heading that introduces such a link. A line that names the old
    product without pointing at where it came from is this product using the old name, not credit.
    """
    if COPIED_COMMAND.search(line):
        return False
    if BUILT_ON.match(line):
        return True
    return bool(UPSTREAM_REPO in line or UPSTREAM_CONST.search(line))


def is_migration_reference(path: pathlib.Path, line: str) -> tuple[bool, str]:
    """Whether a line refers to something that already exists on an install and cannot be renamed."""
    relative = path.relative_to(ROOT).as_posix()
    for entry, marker, reason in MIGRATION_REFERENCES:
        if relative == entry and marker in line:
            return True, reason
    return False, ""


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Fail on any surviving use of the old name.")
    parser.add_argument("--list", action="store_true", help="print every occurrence")
    args = parser.parse_args(argv)

    defects: list[tuple[pathlib.Path, int, str, str]] = []
    visible: list[tuple[pathlib.Path, int, str]] = []
    credited = 0
    migrated = 0
    total = 0

    for path in _iter_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if "rakazo" not in line.lower():
                continue
            stripped = line.strip()
            if is_attribution(path, stripped):
                credited += 1
                continue
            migrated_here, _ = is_migration_reference(path, stripped)
            if migrated_here:
                migrated += 1
                continue
            for token in TOKEN.findall(line):
                total += 1
                defects.append((path, number, token, stripped[:120]))
                if VISIBLE_LINE.search(line):
                    visible.append((path, number, stripped[:120]))
                    break

    print(f"surviving occurrences: {len(defects)}")
    print(f"credited to upstream : {credited}")
    print(f"existing install     : {migrated}")
    print(f"in a visible slot    : {len(visible)}")

    if defects and args.list:
        print("\nUNEXPLAINED:")
        for path, number, token, text in defects[:200]:
            print(f"  {path.relative_to(ROOT)}:{number}  {token}  | {text}")

    if visible:
        print("\nVISIBLE OCCURRENCES (the old name where a person reads it):")
        for path, number, text in visible[:50]:
            print(f"  {path.relative_to(ROOT)}:{number} | {text}")

    if defects:
        return 1
    print("\nNo surviving use of the old name outside upstream credit.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
