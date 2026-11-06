/** Mobile A2UI gate. Default off. Read at call time so tests can stub the env. */
export function isA2uiEnabled(): boolean {
  const value = process.env.EXPO_PUBLIC_FEATURE_A2UI?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}
