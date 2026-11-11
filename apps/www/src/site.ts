/**
 * Site identity for the Matebot fork's marketing site.
 *
 * Every self-referencing URL points at this fork so the site never sends readers
 * to the upstream product's pages or download links. Upstream credit lives in
 * text and in the GitHub repository link, which is where Apache-2.0 attribution
 * belongs.
 */
import { appOrigin, marketingOrigin } from "./origins";

export const SITE_NAME = "Matebot";
/** Where this marketing site is served (canonicals, hreflang, structured data). */
export const SITE_URL = marketingOrigin(process.env);
export const SITE_DESCRIPTION =
  "Matebot is an open source Grok Bot alternative for persistent AI teammates that do real work. Your keys, your model, your machine.";

export const GITHUB_URL = "https://github.com/Lizer2009/matebot";
/** The Apache-2.0 project Matebot is a fork of; credited, never presented as this site. */
export const UPSTREAM_URL = "https://github.com/elie222/rakazo";
export const GITHUB_API_REPO = "https://api.github.com/repos/Lizer2009/matebot";

/** Where the web app is served. Sign-in and account links open it, never the marketing root. */
export const APP_URL = appOrigin(process.env);
export const PLUGIN_SUBMISSIONS_URL = `${APP_URL}/api/v1/plugin-submissions`;
export const INTEGRATION_CLAIMS_URL = `${APP_URL}/api/v1/integration-claims`;

/** True for a link this site serves, so it keeps its own target instead of opening a new tab. */
export function isSiteUrl(href: string): boolean {
  return href === SITE_URL || href.startsWith(`${SITE_URL}/`);
}

/**
 * The integration catalog is published by the upstream sync job. A self-hosted
 * install can point `CATALOG_URL` somewhere else, and the site falls back to a
 * built-in list when the fetch fails, so this stays reachable-but-external
 * rather than pretending to be part of this fork.
 */
export const CATALOG_URL =
  "https://matebot-public.fsn1.your-objectstorage.com/integrations/catalog.json";

/**
 * This fork publishes no App Store or Play Store listing yet. The site hides
 * those actions rather than linking the upstream app under a Matebot label;
 * `docs/self-host-clients.md` covers running the clients against your own server.
 */
export const IOS_APP_URL: string | null = null;

export const DOCS_URL = `${GITHUB_URL}/blob/main/docs/self-host.md`;
export const SELF_HOST_SECRETS_URL = `${GITHUB_URL}/blob/main/docs/self-host-secrets.md`;
export const SELF_HOST_RESTRICTED_URL = `${GITHUB_URL}/blob/main/docs/self-host-restricted-network.md`;
export const SETUP_PROMPT_URL = `${GITHUB_URL}/blob/main/SETUP_PROMPT.md`;
export const SELF_HOST_GUIDE_PATH = "/self-hosted-ai-agent/";
export const PLUGIN_SUBMIT_PATH = "/plugins/submit/";
export const OPENCLAW_ALTERNATIVE_PATH = "/openclaw-alternative/";
export const CHANGELOG_URL = `${GITHUB_URL}/releases`;
export const LATEST_RELEASE_URL = `${CHANGELOG_URL}/latest`;
