#!/usr/bin/env python3
"""Tests for brand-guard.py.

The guard is only worth having if it fails when it should. Each case below is a way the old name
could reach shipped output, so a future edit that reintroduces one of them breaks a test instead
of quietly approving it.
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest

GUARD = pathlib.Path(__file__).with_name("brand-guard.py")
UPSTREAM = "https://github.com/elie222/rakazo"


def run_guard(root: pathlib.Path, *flags: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(GUARD), *flags],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def make_tree(files: dict[str, str]) -> pathlib.Path:
    root = pathlib.Path(tempfile.mkdtemp(prefix="brand-guard-"))
    for relative, content in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(textwrap.dedent(content), encoding="utf-8")
    return root


class GuardFailsWhenItShould(unittest.TestCase):
    def test_any_identifier_with_the_old_name_fails(self) -> None:
        # Identity was renamed, so there is no class of identifier left to excuse. A new one is a
        # regression, not a legacy exception.
        identifiers = {
            "environment variable": 'export const A = process.env.RAKAZO_IMAGE;\n',
            "header": 'export const B = "x-rakazo-client-build";\n',
            "storage key": 'export const C = "rakazo.signedInUser";\n',
            "compose project": 'const D = { name: "rakazo" };\n',
            "database role": 'const E = "postgres://rakazo@db:5432/rakazo";\n',
            "native module": "const F = 'RakazoVoiceChat';\n",
            "image": 'const G = "ghcr.io/elie222/rakazo/app:edge";\n',
            "host path": 'const H = "/var/lib/rakazo-pitr";\n',
        }
        for label, source in identifiers.items():
            root = make_tree({"packages/core/src/x.ts": source})
            result = run_guard(root)
            self.assertEqual(result.returncode, 1, f"{label} passed: {result.stdout}")

    def test_a_heading_naming_the_old_product_fails(self) -> None:
        root = make_tree({"apps/web/src/page.tsx": "export const X = <h1>Welcome to Rakazo</h1>;\n"})
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("VISIBLE OCCURRENCES", result.stdout)

    def test_a_placeholder_naming_the_old_product_fails(self) -> None:
        root = make_tree({"apps/web/src/form.tsx": '<Input placeholder="rakazo-<space>" />\n'})
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout)

    def test_a_scan_that_finds_no_files_fails(self) -> None:
        # A guard run from the wrong directory used to print success after scanning nothing.
        root = pathlib.Path(tempfile.mkdtemp(prefix="brand-guard-empty-"))
        result = run_guard(root)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("no files matched", result.stderr + result.stdout)

    def test_a_product_link_to_the_old_host_fails(self) -> None:
        # The defect that shipped in an APK: a link the product opens for the user.
        cases = {
            "constant": 'export const U = "https://rakazo.com/plugins/submit/";\n',
            "href": '<a href="https://rakazo.com/privacy/">Privacy</a>\n',
            "template": "const u = `https://rakazo.com/privacy/`;\n",
            "router": 'router.push("https://rakazo.com/terms/");\n',
        }
        for label, source in cases.items():
            root = make_tree({"packages/contracts/src/x.ts": source})
            result = run_guard(root)
            self.assertEqual(result.returncode, 1, f"{label} passed: {result.stdout}")

    def test_an_install_command_naming_the_upstream_repo_fails(self) -> None:
        # Someone following "install this" must clone the project they are installing.
        cases = {
            "clone": f"export const S = `git clone {UPSTREAM}.git`;\n",
            "mkdir": "export const I = `mkdir -p rakazo && cd rakazo &&`;\n",
            "curl": (
                "export const F = `curl -fsSLO "
                "https://raw.githubusercontent.com/elie222/rakazo/main/x.sh`;\n"
            ),
        }
        for label, source in cases.items():
            root = make_tree({"apps/www/src/guide.ts": source})
            result = run_guard(root)
            self.assertEqual(result.returncode, 1, f"{label} passed: {result.stdout}")

    def test_a_credit_line_that_also_holds_a_command_still_fails(self) -> None:
        root = make_tree(
            {"README.md": f"Matebot is a fork of Rakazo. Install: `git clone {UPSTREAM}.git`\n"}
        )
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)


class GuardPassesUpstreamCredit(unittest.TestCase):
    def test_a_link_to_the_upstream_repository_passes(self) -> None:
        root = make_tree(
            {
                "README.md": (
                    f"This repository is a fork of **[Rakazo]({UPSTREAM})**, the Apache-2.0 "
                    "project it is built on.\n"
                ),
                "apps/www/src/site.ts": f'export const UPSTREAM_URL = "{UPSTREAM}";\n',
            }
        )
        result = run_guard(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_naming_the_project_without_a_link_does_not_pass(self) -> None:
        # A bare mention is this product using the old name. Credit has to say where it came from.
        root = make_tree({"apps/web/src/about.tsx": "<p>Powered by Rakazo.</p>\n"})
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)


class GuardPassesNoRuntimeReference(unittest.TestCase):
    """No runtime code may keep the old name, including for migrating old installs.

    The product was renamed in full and an install may be replaced cleanly, so there is no legacy
    profile, slug, or folder the code has to keep recognising. A migration helper is exactly the
    kind of thing that reintroduces the old identity, so it must fail like anything else.
    """

    def test_a_legacy_slug_constant_fails(self) -> None:
        root = make_tree(
            {
                "apps/desktop/src/user-data-migration.ts": (
                    'export const LEGACY_PRODUCT_SLUG = "Rakazo";\n'
                )
            }
        )
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_a_documented_old_folder_fails(self) -> None:
        root = make_tree(
            {
                "docs/MATEBOT_DEPLOY.md": (
                    "**Migration**: `%APPDATA%\\Rakazo` moves on first launch.\n"
                )
            }
        )
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
