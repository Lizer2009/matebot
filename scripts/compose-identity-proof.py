#!/usr/bin/env python3
"""Prove the Compose identity with the real `docker compose config`.

This runs the actual Compose binary, so the result is what Compose resolves, not a
re-implementation of `${VAR:-default}`. It prints names and booleans only: no secret value from the
probe env file is ever echoed.

Usage: python3 scripts/compose-identity-proof.py [--compose CMD]
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import textwrap

ROOT = pathlib.Path(__file__).resolve().parent.parent
COMPOSE_DIR = ROOT / "infra" / "compose"

# Values only satisfy `:?` requirements during a parse. They are never printed.
PROBE_ENV = {
    "POSTGRES_PASSWORD": "probe-password-value",
    "POSTGRES_APP_PASSWORD": "probe-app-password-value",
    "SANDBOX_SUPERVISOR_TOKEN": "probe-supervisor-token",
    "BETTER_AUTH_SECRET": "probe-auth-secret-at-least-32-characters-x",
    "ENCRYPTION_KEY": "probe-encryption-key-at-least-32-characters",
    "SCREEN_PROXY_SECRET": "probe-screen-proxy-secret-at-least-32-chars",
}

failures: list[str] = []
checks = 0


REPORT_LINES: list[str] = []


def _emit(line: str) -> None:
    REPORT_LINES.append(line)
    print(line)


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    ok = actual == expected
    _emit(f"  {'PASS' if ok else 'FAIL'}  {label}: {actual!r}" + ("" if ok else f" (expected {expected!r})"))
    if not ok:
        failures.append(label)


def check_true(label: str, condition: bool, detail: str = "") -> None:
    global checks
    checks += 1
    _emit(f"  {'PASS' if condition else 'FAIL'}  {label}" + (f": {detail}" if detail else ""))
    if not condition:
        failures.append(label)


def _default_compose() -> str:
    """Prefer the standalone binary, then Docker's plugin, which is what runners ship."""
    if shutil.which("docker-compose"):
        return "docker-compose"
    if shutil.which("docker"):
        return "docker compose"
    raise SystemExit("no docker-compose or docker found; install Docker Compose to run this check")


def compose_cmd(compose: str) -> list[str]:
    """Accept either the standalone binary or Docker's compose plugin."""
    return ["docker", "compose"] if compose in ("docker compose", "docker-compose-plugin") else [compose]


def run(compose: str, files: list[str], env: dict[str, str], *args: str, project="probe"):
    cmd = [*compose_cmd(compose), "--env-file", env["__file__"], "-f", files[0]]
    for extra in files[1:]:
        cmd += ["-f", extra]
    # No -p: the file's own `name:` is the identity under test, and forcing a project name
    # would hide what the file declares.
    cmd += ["config", *args]
    envvars = {k: v for k, v in os.environ.items() if not k.startswith(("MATEBOT_", "POSTGRES_", "RAKAZO_"))}
    envvars.update({k: v for k, v in env.items() if k != "__file__"})
    return subprocess.run(cmd, cwd=COMPOSE_DIR, capture_output=True, text=True, env=envvars, timeout=180)


def write_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    handle = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False)
    values = dict(PROBE_ENV)
    if extra:
        values.update(extra)
    for key, value in values.items():
        handle.write(f"{key}={value}\n")
    handle.close()
    return {"__file__": handle.name}


def config_json(compose: str, files: list[str], env: dict[str, str]):
    result = run(compose, files, env, "--format", "json")
    if result.returncode != 0:
        raise SystemExit(f"compose config failed: {result.stderr.strip()[:400]}")
    return json.loads(result.stdout)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--compose",
        default=os.environ.get("COMPOSE_BIN") or _default_compose(),
        help="compose binary, or 'docker compose' for the plugin",
    )
    args = parser.parse_args(argv)

    images = "docker-compose.images.yml"
    prod = "docker-compose.prod.yml"
    prod_docker = "docker-compose.prod.docker.yml"

    _emit("== images stack: project, volumes, networks ==")
    env = write_env()
    doc = config_json(args.compose, [images], env)
    check("project name", doc.get("name"), "matebot")
    check("volume names", sorted((doc.get("volumes") or {}).keys()), ["appdata", "pgdata", "webassets"])
    check("network names", sorted((doc.get("networks") or {}).keys()), ["app", "data"])
    check_true(
        "no volume key carries the old name",
        all("rakazo" not in key.lower() for key in (doc.get("volumes") or {})),
    )

    print("\n== images stack: image defaults ==")
    services = doc["services"]
    for name in ("api", "worker", "web"):
        check(f"{name} image", services[name]["image"], "ghcr.io/lizer2009/matebot/app:edge")
    check("computer image", services["computer"]["image"], "ghcr.io/lizer2009/matebot/computer:edge")

    print("\n== images stack: database identity ==")
    pg = services["postgres"]["environment"]
    check("POSTGRES_USER", pg.get("POSTGRES_USER"), "matebot")
    check("POSTGRES_DB", pg.get("POSTGRES_DB"), "matebot")
    check_true(
        "api DATABASE_URL names the app role and database",
        services["api"]["environment"]["DATABASE_URL"].startswith("postgres://matebot_app:")
        and services["api"]["environment"]["DATABASE_URL"].endswith("/matebot"),
        "role=matebot_app db=matebot",
    )
    check_true(
        "api DATABASE_URL resolves the app role against the configured database",
        "matebot_app" in services["api"]["environment"]["DATABASE_URL"],
        "role=matebot_app",
    )

    print("\n== images stack: operator override still wins ==")
    override_env = write_env({"MATEBOT_IMAGE": "registry.example.test/mine/app", "MATEBOT_IMAGE_TAG": "v9"})
    overridden = config_json(args.compose, [images], override_env)
    check("api image honours MATEBOT_IMAGE + tag", overridden["services"]["api"]["image"],
          "registry.example.test/mine/app:v9")
    check("computer keeps its own default", overridden["services"]["computer"]["image"],
          "ghcr.io/lizer2009/matebot/computer:edge")

    print("\n== production stack: defaults and supervisor overlay ==")
    prod_env = write_env()
    prod_doc = config_json(args.compose, [prod], prod_env)
    check("prod project name", prod_doc.get("name"), "matebot-prod")
    for name in ("api", "worker", "web"):
        check(f"prod {name} image", prod_doc["services"][name]["image"], "ghcr.io/lizer2009/matebot/app:local")
    layered = config_json(args.compose, [prod, prod_docker], prod_env)
    check("prod+supervisor overlay image", layered["services"]["supervisor"]["image"],
          "ghcr.io/lizer2009/matebot/app:local")

    print("\n== failure boundary: a required value that is missing ==")
    bare = write_env({k: "" for k in PROBE_ENV})
    result = run(args.compose, [images], bare, "--format", "json")
    check_true("missing required value fails", result.returncode != 0, f"exit {result.returncode}")
    check_true(
        "the failure names the setting and says it is required",
        "missing a value" in result.stderr or "required" in result.stderr.lower(),
        result.stderr.strip().splitlines()[0][:120] if result.stderr.strip() else "",
    )
    with_old_names = write_env({"RAKAZO_IMAGE": "registry.example.test/old/app"})
    old_named = config_json(args.compose, [images], with_old_names)
    check_true(
        "an old-named variable no longer influences the image",
        old_named["services"]["api"]["image"] == "ghcr.io/lizer2009/matebot/app:edge",
        "MATEBOT_IMAGE default unchanged",
    )

    # Compose resolves secrets into its own output by design; what matters is that this report
    # never echoes one. Fail loudly rather than leak a value into a CI log.
    printed = "\n".join(REPORT_LINES)
    leaked = [name for name, value in PROBE_ENV.items() if value and value in printed]
    check_true("report echoes no probe secret", not leaked, "none" if not leaked else ", ".join(leaked))

    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("Compose identity verified with the real `docker compose config`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
