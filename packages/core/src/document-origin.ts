/**
 * Which origin this deployment's own documentation lives on.
 *
 * The marketing site and the app are separate hosts and both move between
 * environments, so the help skill must not embed a literal. `RAKAZO_MARKETING_URL`
 * is the existing setting the site itself builds from; reading the same variable
 * here means a fork that sets it once gets consistent links everywhere.
 */

/** The name the site already uses for its own origin. */
export const DOCUMENT_ORIGIN_ENV = "RAKAZO_MARKETING_URL";

/**
 * The product's default origin when nothing is configured.
 *
 * This is the same default `apps/www` falls back to, so an unconfigured build and
 * the skill agree instead of pointing at different hosts.
 */
export const DEFAULT_DOCUMENT_ORIGIN = "https://test.matebot.dev";

/**
 * The origin to build documentation links from.
 *
 * Anything that is not an http(s) URL is ignored rather than pasted into a link: a
 * malformed or hostile value becomes the default, never a `javascript:` URL the
 * model might be told to fetch.
 */
export function documentOriginFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env[DOCUMENT_ORIGIN_ENV]?.trim();
  if (!raw) return DEFAULT_DOCUMENT_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_DOCUMENT_ORIGIN;
    return url.origin;
  } catch {
    return DEFAULT_DOCUMENT_ORIGIN;
  }
}
