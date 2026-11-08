/**
 * Mobile A2UI gate.
 *
 * The deployment decides, reported by `/me` as `a2uiEnabled`, exactly as on web. It
 * publishes the cards and its own routes refuse every card action, so drawing one it
 * does not serve would only offer controls that fail, and hiding one it does serve
 * leaves a row that is silently empty — the failure this exists to prevent.
 *
 * The build variable remains for a build made deliberately with it, and only decides
 * when the server says nothing (a server that predates the field, or `/me` not yet
 * answered). Read at call time so tests can stub it.
 */
export function isA2uiEnabled(options?: {
  /** `me.a2uiEnabled`. Undefined means the server did not say. */
  server?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options?.server === true) return true;
  if (options?.server === false) return false;
  const value = (options?.env ?? process.env).EXPO_PUBLIC_FEATURE_A2UI?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}
