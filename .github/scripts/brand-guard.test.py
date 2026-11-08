#!/usr/bin/env python3
"""Tests for brand-guard.py.

The guard is only worth having if it fails when it should. Each case below is a way the guard
used to report success while seeing nothing, so a future edit that reintroduces one of them
breaks a test instead of quietly approving an old-brand string into a shipped build.
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest

GUARD = pathlib.Path(__file__).with_name("brand-guard.py")


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
    def test_an_unfamiliar_identifier_is_unclassified(self) -> None:
        root = make_tree({"apps/web/src/new.ts": 'export const x = "rakazo-brand-new-thing";\n'})
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("unclassified       : 1", result.stdout)

    def test_a_heading_naming_the_old_product_is_a_visible_defect(self) -> None:
        root = make_tree({"apps/web/src/page.tsx": "export const X = <h1>Welcome to Rakazo</h1>;\n"})
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("VISIBLE DEFECTS: 1", result.stdout)

    def test_a_placeholder_naming_the_old_product_is_a_visible_defect(self) -> None:
        root = make_tree({"apps/web/src/form.tsx": '<Input placeholder="rakazo-<space>" />\n'})
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout)

    def test_a_scan_that_finds_no_files_fails(self) -> None:
        # A guard run from the wrong directory used to print success after scanning nothing.
        root = pathlib.Path(tempfile.mkdtemp(prefix="brand-guard-empty-"))
        result = run_guard(root)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("no files matched", result.stderr + result.stdout)

    def test_a_stale_allowlist_entry_fails_only_when_asked(self) -> None:
        # On a partial tree most rules legitimately match nothing, so staleness is opt-in. With
        # the flag, a rule that outlived its subject must fail instead of absorbing a future
        # string that happens to fit it.
        root = make_tree({"apps/web/src/ok.ts": "export const y = 1;\n"})
        lenient = run_guard(root)
        self.assertEqual(lenient.returncode, 0, lenient.stdout)

        strict = subprocess.run(
            [sys.executable, str(GUARD), "--check-stale-allowlist"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        self.assertEqual(strict.returncode, 1, strict.stdout)
        self.assertIn("STALE ALLOWLIST", strict.stdout)


class GuardPassesRealLegacyIdentities(unittest.TestCase):
    def test_a_documented_storage_key_is_not_a_defect(self) -> None:
        root = make_tree(
            {
                "apps/web/src/store.ts": 'export const K = "rakazo.signedInUser";\n',
                "packages/core/src/probe.ts": 'export const P = "rakazo_probe";\n',
            }
        )
        result = run_guard(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_upstream_attribution_stays_visible(self) -> None:
        root = make_tree(
            {
                "apps/www/src/pages/about.astro": (
                    "<p>Matebot is a fork of Rakazo, the upstream project.</p>\n"
                )
            }
        )
        result = run_guard(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class SpecificityOrdering(unittest.TestCase):
    def test_the_narrow_rule_reports_a_narrow_reason(self) -> None:
        sys.path.insert(0, str(GUARD.parent))
        import importlib.util

        spec = importlib.util.spec_from_file_location("brand_guard", GUARD)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        # `rakazo.dump` matches both the backup-artifact rule and the broader stored-key family.
        verdict = module.classify("rakazo.dump")
        self.assertIsNotNone(verdict, "rakazo.dump must stay classified")
        self.assertIn("dump", verdict[1], verdict[1])

    def test_no_catch_all_pattern_accepts_any_suffix(self) -> None:
        import importlib.util

        spec = importlib.util.spec_from_file_location("brand_guard", GUARD)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        # A rule shaped like `^rakazo.*$` or `^rakazo[a-z]*$` waves through any new string that
        # starts with the six letters. Assert by behaviour: tokens that no real identity uses
        # must stay unclassified.
        for token in (
            "rakazo-brand-new-thing",
            "rakazo-newSetting",
            "rakazo-somethingElse-entirely",
            "rakazo/new/feature/flag",
        ):
            self.assertIsNone(module.classify(token), f"{token} must not be auto-approved")


if __name__ == "__main__":
    unittest.main()
