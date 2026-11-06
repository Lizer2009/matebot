/**
 * Server-side A2UI gate. Default off so production matches 0.6.0.
 * Enable with FEATURE_A2UI=1|true|on (env only; no RAKAZO_* rename).
 */
export function isA2uiFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FEATURE_A2UI?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}
