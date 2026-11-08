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
 * The deployment decides, reported by `/me` as `a2uiEnabled`. Precedence, and why:
 *
 * 1. The server, when it says yes. It publishes the cards; drawing them is always right.
 * 2. The server, when it says no. Its own routes refuse every action, so drawing a card
 *    would only offer controls that fail.
 * 3. With no answer (a server that predates the field, or `/me` not yet loaded) the
 *    build variable decides, then the storage key an operator can set locally.
 *
 * The client used to have only step 3, and a production image was built without the
 * variable: every card was dropped before rendering with no frame and no explanation,
 * while the turn described a draft waiting in a card nobody could see.
 */
export function isA2uiEnabled(options?: {
  env?: FlagEnv;
  storage?: Storage | null;
  /** `me.a2uiEnabled`. Undefined means the server did not say. */
  server?: boolean;
}): boolean {
  if (options?.server === true) return true;
  if (options?.server === false) return false;
  const fromEnv = envEnablesA2ui(
    options?.env ??
      (typeof import.meta !== "undefined"
        ? ((import.meta as ImportMeta).env as FlagEnv | undefined)
        : undefined),
  );
  if (fromEnv !== undefined) return fromEnv;
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
