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
 * Whether this deployment has named its own documentation origin.
 *
 * The default below is where the hosted product publishes its docs, and it is a
 * reasonable fallback for building a *link*. It is not reasonable grounds for
 * exempting a fetch from the site-approval gate: on a self-hosted deployment the
 * operator never configured that host, so a pre-approved fetch to it would be a
 * weaker guard than asking. Only a configured origin is exempt.
 */
export function documentOriginConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isValidOrigin(env[DOCUMENT_ORIGIN_ENV]?.trim());
}

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
  return isValidOrigin(raw) ? new URL(raw!).origin : DEFAULT_DOCUMENT_ORIGIN;
}

function isValidOrigin(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
