/**
 * Product feature flags. Default off so production matches the 0.6.0 line until
 * a later PR enables a capability after persistence and runtime land.
 *
 * Enable A2UI locally with either:
 * - `VITE_FEATURE_A2UI=1` at build/dev time, or
 * - `localStorage.setItem("matebot.feature.a2ui", "1")` then reload.
 */

export type FeatureFlag = "a2ui";

const A2UI_STORAGE_KEY = "matebot.feature.a2ui";

type FlagEnv = {
  VITE_FEATURE_A2UI?: string;
};

function envEnablesA2ui(env: FlagEnv | undefined): boolean | undefined {
  const value = env?.VITE_FEATURE_A2UI?.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return undefined;
}

function storageEnablesA2ui(storage: Storage | null | undefined): boolean {
  if (!storage) return false;
  try {
    const value = storage.getItem(A2UI_STORAGE_KEY)?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "on";
  } catch {
    return false;
  }
}

/**
 * Whether the A2UI Surface host may render `a2ui_surface` timeline blocks.
 *
 * The deployment's own setting decides, reported by `/me` as `a2uiEnabled`. The
 * environment and storage overrides remain for local development and the browser
 * suite, but they only ever *add* to the server's answer for a build that was made
 * with them; a production image is built without either, so it follows the server.
 *
 * This used to be the only source, and nothing set the build variable on a production
 * image: every card was dropped before rendering, with no frame and no explanation,
 * while the turn said the draft was waiting in the card above.
 */
export function isA2uiEnabled(options?: {
  env?: FlagEnv;
  storage?: Storage | null;
  /** `me.a2uiEnabled`. Undefined means the server predates the field. */
  server?: boolean;
}): boolean {
  if (options?.server === true) return true;
  const fromEnv = envEnablesA2ui(
    options?.env ??
      (typeof import.meta !== "undefined"
        ? ((import.meta as ImportMeta).env as FlagEnv | undefined)
        : undefined),
  );
  if (fromEnv !== undefined) return fromEnv;
  // With no env override, the server's answer is final: a card this deployment does
  // not serve must not be drawn from a stale local flag either.
  if (options?.server !== undefined) return false;
  const storage =
    options && "storage" in options
      ? options.storage
      : typeof localStorage !== "undefined"
        ? localStorage
        : null;
  return storageEnablesA2ui(storage);
}

export function isFeatureEnabled(
  flag: FeatureFlag,
  options?: { env?: FlagEnv; storage?: Storage | null; server?: boolean },
): boolean {
  switch (flag) {
    case "a2ui":
      return isA2uiEnabled(options);
    default: {
      const _exhaustive: never = flag;
      return _exhaustive;
    }
  }
}

export { A2UI_STORAGE_KEY };
