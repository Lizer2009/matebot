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

/** Whether the A2UI Surface host may render `a2ui_surface` timeline blocks. Default: off. */
export function isA2uiEnabled(options?: { env?: FlagEnv; storage?: Storage | null }): boolean {
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
  options?: { env?: FlagEnv; storage?: Storage | null },
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
