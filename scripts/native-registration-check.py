#!/usr/bin/env python3
"""Check that every native module is registered under the same Matebot name everywhere.

An Expo native module is addressed by name from four places that have to agree: the podspec that
builds it, the Swift/Kotlin class that exposes it, the module config that tells Expo what to load,
and the JavaScript that looks it up. A rename that touches some of them fails at build time or, for
an optional module, silently disables a feature.

This reads the tree instead of building, so it runs without Xcode or the Android SDK. It proves the
names agree; it does not prove the app compiles, which needs a native toolchain.

Usage: python3 scripts/native-registration-check.py
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODULES = ROOT / "apps" / "mobile" / "modules"
MOBILE_LIB = ROOT / "apps" / "mobile" / "lib"

failures: list[str] = []
checks = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f": {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def main() -> int:
    configs = sorted(MODULES.glob("*/expo-module.config.json"))
    check("found native modules", bool(configs), f"{len(configs)} modules")

    # The lookup can be in lib/ or in a component; both are JavaScript that addresses the module
    # by name, so scan the whole app rather than assuming one directory.
    app_root = ROOT / "apps" / "mobile"
    js_sources = "\n".join(
        source.read_text(encoding="utf-8")
        for pattern in ("lib/**/*.ts", "lib/**/*.tsx", "components/**/*.tsx", "app/**/*.tsx")
        for source in app_root.glob(pattern)
        if "modules" not in source.parts
    )

    for config_path in configs:
        module_dir = config_path.parent
        name = module_dir.name
        print(f"\n== {name} ==")
        config = json.loads(config_path.read_text(encoding="utf-8"))

        for platform in ("apple", "android"):
            for class_name in config.get(platform, {}).get("modules", []):
                tail = class_name.rsplit(".", 1)[-1]
                check(f"{platform} module class is Matebot-named", tail.startswith("Matebot"), tail)

                if platform == "apple":
                    podspecs = sorted(module_dir.glob("ios/*.podspec"))
                    check("apple module has a podspec", bool(podspecs), podspecs[0].name if podspecs else "none")
                    if podspecs:
                        text = podspecs[0].read_text(encoding="utf-8")
                        declared = re.search(r"s\.name\s*=\s*'([^']+)'", text)
                        check(
                            "podspec name is Matebot-named",
                            bool(declared and declared.group(1).startswith("Matebot")),
                            declared.group(1) if declared else "missing",
                        )
                        swift = sorted(module_dir.glob("ios/*.swift"))
                        check("apple sources exist", bool(swift), f"{len(swift)} files")
                        joined = "\n".join(p.read_text(encoding="utf-8") for p in swift)
                        check(
                            "swift declares the configured class",
                            f"class {tail}" in joined or f"struct {tail}" in joined,
                            tail,
                        )

                if platform == "android":
                    package = class_name.rsplit(".", 1)[0]
                    package_path = module_dir / "android" / "src" / "main" / "java" / pathlib.Path(
                        *package.split(".")
                    )
                    check("android package directory matches config", package_path.is_dir(), package)
                    gradle = module_dir / "android" / "build.gradle"
                    if gradle.exists():
                        text = gradle.read_text(encoding="utf-8")
                        ns = re.search(r"namespace\s+'([^']+)'", text)
                        check(
                            "gradle namespace matches config package",
                            bool(ns and ns.group(1) == package),
                            ns.group(1) if ns else "missing",
                        )

        # The JS side must ask for the name the native side registers, or the module resolves to null.
        registered = [
            class_name.rsplit(".", 1)[-1] for p in ("apple", "android")
            for class_name in config.get(p, {}).get("modules", [])
        ]
        for class_name in registered:
            # Only the module class's own `Name(...)` is its registered name; a `Name(...)` on a
            # notification or event type is a different thing and must not be read as one.
            exposed: str | None = None
            for source in list(module_dir.rglob("*.swift")) + list(module_dir.rglob("*.kt")):
                text = source.read_text(encoding="utf-8")
                match = re.search(
                    r"class\s+"
                    + re.escape(class_name.rsplit(".", 1)[-1])
                    + r'\b[\s\S]{0,600}?Name\("([^"]+)"\)',
                    text,
                )
                if match:
                    exposed = match.group(1)
                    break
            if exposed:
                check(
                    "the name the module exposes is looked up from JS",
                    f'"{exposed}"' in js_sources,
                    exposed,
                )
            else:
                check("the module exposes a name", False, class_name)

    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("Native registration names agree across podspecs, sources, Expo config, and JS.")
    print("This does not build the app: an iOS or Android compile needs a native toolchain.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
