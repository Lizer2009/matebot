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


class ProductLinksToTheOldHost(unittest.TestCase):
    """A URL the product links to is not attribution, however the host is owned.

    This is the defect that shipped in an APK: `SUBMIT_PLUGIN_URL` pointed at the old domain, and
    the guard excused it because the host text was on the same line as the sanctioned-attribution
    pattern. Nothing in the scan asked *who the link is for*.
    """

    def test_a_url_constant_pointing_at_the_old_host_is_a_defect(self) -> None:
        root = make_tree(
            {
                "packages/contracts/src/domain.ts": (
                    'export const SUBMIT_PLUGIN_URL = "https://rakazo.com/plugins/submit/";\n'
                )
            }
        )
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("VISIBLE DEFECTS", result.stdout)

    def test_an_href_and_an_openurl_are_both_defects(self) -> None:
        root = make_tree(
            {
                "apps/web/src/pages/x.tsx": '<a href="https://rakazo.com/privacy/">Privacy</a>\n',
                "apps/mobile/app/y.tsx": (
                    'void Linking.openURL("https://rakazo.com/terms/");\n'
                ),
            }
        )
        result = run_guard(root)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_the_same_defect_in_other_shapes_is_caught(self) -> None:
        # The first rule only matched `= "…"`, `href={"…"}` and `openURL("…")`, so the identical
        # mistake written as a table, a bare origin, or a router call passed the guard.
        cases = {
            "object literal": 'export const links = { submit: "https://rakazo.com/plugins/submit/" };\n',
            "bare origin": 'const OLD = "https://rakazo.com";\n',
            "router call": 'router.push("https://rakazo.com/terms/");\n',
            "template head": 'const u = `https://rakazo.com/privacy/`;\n',
        }
        for label, source in cases.items():
            root = make_tree({"packages/contracts/src/x.ts": source})
            result = run_guard(root)
            self.assertEqual(result.returncode, 1, f"{label} passed: {result.stdout}")

    def test_attribution_to_the_upstream_project_still_passes(self) -> None:
        # Crediting the upstream project is not the same as sending users to the old product.
        root = make_tree(
            {
                "apps/www/src/site.ts": (
                    'export const UPSTREAM_URL = "https://github.com/elie222/rakazo";\n'
                ),
                "apps/www/src/pages/terms.astro": (
                    'const X = "https://rakazo.com/terms/"; // upstream terms\n'
                ),
            }
        )
        result = run_guard(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_link_inside_the_upstream_service_section_passes(self) -> None:
        # The terms page links Rakazo's own terms *about that service*. The heading is above the
        # link, which is why the rule looks at the section rather than only the line.
        root = make_tree(
            {
                "apps/www/src/pages/terms.astro": (
                    "<h2>Hosted Rakazo service</h2>\n"
                    "<p>If you use the hosted service the upstream project operates, that\n"
                    "service has its own <a href=\"https://rakazo.com/terms/\">terms</a>.\n"
                    "</p>\n"
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
            # Environment and stored-key families are enumerated, not wildcarded: a new setting
            # or storage key has to be registered with a reason rather than inherited.
            "RAKAZO_A_BRAND_NEW_SETTING",
            "rakazo.aBrandNewStoredKey",
        ):
            self.assertIsNone(module.classify(token), f"{token} must not be auto-approved")

    def test_a_known_environment_name_is_still_accepted(self) -> None:
        import importlib.util

        spec = importlib.util.spec_from_file_location("brand_guard", GUARD)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        # Tightening the rule must not break the variables a deployment actually reads.
        for token in ("RAKAZO_COMPUTER_IMAGE", "RAKAZO_DEPLOY_DIR", "rakazo.session_token"):
            self.assertIsNotNone(module.classify(token), f"{token} must stay classified")


if __name__ == "__main__":
    unittest.main()
