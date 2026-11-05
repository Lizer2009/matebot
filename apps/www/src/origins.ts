/**
 * Deployment origins shared by `astro.config.mjs` and the site content.
 *
 * The marketing site and the app are separate hostnames, and both move: the
 * `test.` subdomains today, the primary domain later. Setting
 * `RAKAZO_MARKETING_URL` and `RAKAZO_APP_URL` at build time changes canonicals,
 * hreflang links, structured data, and every sign-in link at once.
 */
export const DEFAULT_MARKETING_ORIGIN = "https://test.matebot.dev";
export const DEFAULT_APP_ORIGIN = "https://app.test.matebot.dev";

export const MARKETING_URL_ENV = "RAKAZO_MARKETING_URL";
export const APP_URL_ENV = "RAKAZO_APP_URL";

/** An absolute origin, or the fallback when unset or not a valid http(s) URL. */
export function resolveOrigin(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  if (!value) return fallback;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : fallback;
  } catch {
    return fallback;
  }
}

export function marketingOrigin(env: Record<string, string | undefined> = {}): string {
  return resolveOrigin(env[MARKETING_URL_ENV], DEFAULT_MARKETING_ORIGIN);
}

export function appOrigin(env: Record<string, string | undefined> = {}): string {
  return resolveOrigin(env[APP_URL_ENV], DEFAULT_APP_ORIGIN);
}
