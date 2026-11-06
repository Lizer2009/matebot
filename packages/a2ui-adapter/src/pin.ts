/**
 * Upstream A2UI pin for Matebot (design §4).
 * Re-pin: bump this SHA, re-run adapter schema tests, update README + design §4.3 table.
 */
export const A2UI_UPSTREAM_REPO = "Lizer2009/a2ui" as const;

/** Full commit SHA — never a floating branch name. */
export const A2UI_UPSTREAM_COMMIT = "dee8167996b0a802b18b3ebe51f3515c55b757de" as const;

/** Monorepo subpath that publishes as `@a2ui/web_core`. */
export const A2UI_WEB_CORE_PATH = "typescript/core/web_core" as const;

/** Design §4.3 strategy A specifier (git commit + subpath) — also the package.json dep. */
export const A2UI_PNPM_GIT_SPEC =
  `github:${A2UI_UPSTREAM_REPO}#${A2UI_UPSTREAM_COMMIT}&path:${A2UI_WEB_CORE_PATH}` as const;

/** Package version field at the pin commit (npm semver ≠ protocol version). */
export const A2UI_WEB_CORE_PACKAGE_VERSION = "0.15.0" as const;
