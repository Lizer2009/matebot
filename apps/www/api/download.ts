import type { DesktopDownloads } from "../src/github.js";
import { fetchAndroidDownload, fetchDesktopDownloads } from "../src/github.js";
import { CHANGELOG_URL, LATEST_RELEASE_URL } from "../src/site.js";

// Edge functions are bundled, which resolves the extensionless source imports.
export const config = { runtime: "edge" };

/**
 * Where the Windows installer is hosted until a GitHub Release publishes one.
 * Deployments set this to an absolute `https://` URL or a site path such as
 * `/downloads/Matebot-Setup-0.6.0.exe` once the binary is in place; see
 * `docs/MATEBOT_DEPLOY.md`. Unset, the redirect falls back to the releases page,
 * which explains where the builds come from instead of handing out a dead link.
 */
export const WINDOWS_INSTALLER_ENV = "MATEBOT_WINDOWS_INSTALLER";

/**
 * A published release asset wins, so cutting a release needs no site change. The
 * configured path is the fallback for a build that a workflow uploaded but no
 * release published. The APK comes from the rolling `android` release, so it is
 * resolved separately from the newest desktop release.
 */
function resolveLocation(
  platform: string | null,
  desktop: DesktopDownloads,
  android: string | null,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "android") return android ?? CHANGELOG_URL;
  const asset = platform ? desktop[platform as keyof DesktopDownloads] : undefined;
  if (asset) return asset;
  const configured = platform === "windows" ? env[WINDOWS_INSTALLER_ENV]?.trim() : undefined;
  return configured && /^(https:\/\/|\/)/.test(configured) ? configured : LATEST_RELEASE_URL;
}

/** Redirects to the newest build so a release needs no site rebuild. */
export async function fetchDownload(
  request: Request,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const platform = new URL(request.url).searchParams.get("platform");
  const [desktop, android] = await Promise.all([
    fetchDesktopDownloads(fetchImpl),
    platform === "android" ? fetchAndroidDownload(fetchImpl) : null,
  ]);
  return new Response(null, {
    status: 302,
    headers: {
      Location: resolveLocation(platform, desktop, android, env),
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
    },
  });
}

export function GET(request: Request): Promise<Response> {
  return fetchDownload(request);
}
