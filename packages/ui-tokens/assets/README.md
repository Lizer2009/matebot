# App icon sources

Two Icon Composer catalogs live here:

- `Matebot.icon` is this fork's product icon. It is the one macOS and iOS packaging use,
  set by `build.mac.icon` in `apps/desktop/package.json` and `expo.ios.icon` in
  `apps/mobile/app.json`.
- `Matebot.icon` is the upstream artwork. It is kept because a few specs still measure the
  animated avatar against its silhouette, and because it is part of the Apache-2.0 history.
  Nothing packages it.

Open either in Apple's Icon Composer with Xcode 26 or newer. macOS packaging compiles the
catalog into a Tahoe asset catalog and generates the legacy ICNS fallback; Expo copies it
into the iOS project.

## Exports

`pnpm --filter @matebot/ui-tokens export:matebot` regenerates every Matebot raster export
from `branding/matebot-icon-source.jpg`:

- `apps/web/public/favicon*`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`
- `apps/web/public/matebot-icon.png`, `matebot-wordmark.png`
- `apps/desktop/assets/icon.png`, `icon.ico` for Linux and Windows
- `apps/mobile/assets/favicon.png`
- `branding/` and `docs/assets/` PNGs

`pnpm --filter @matebot/ui-tokens export:matebot-icon` writes the full-bleed layer that
`Matebot.icon` composites, and `export:matebot-wordmark` traces the marketing wordmark into
an SVG. See [MATEBOT_BRAND.md](../../docs/MATEBOT_BRAND.md) for which surface reads which
file.

Android supplies its own mask; never bake Mac corners, a rim, or an outer shadow into
adaptive layers. `apps/mobile/assets/adaptive-icon.png`, `icon-background.png`, and
`monochrome-icon.png` are hand-maintained and not covered by the export scripts.

After exporting, run `pnpm exec tsx apps/www/scripts/render-og.mjs` to refresh the marketing
social cards; set `CHROME_PATH` to a headless Chrome executable when it is not available at
the script's default location.

## Animated vector avatars

The animated avatar uses SVG paths and gradients in the shared `logo-avatar-art.ts`
definition. Its contour was sampled from the upstream icon's alpha silhouette. The hands and
lighting are simplified vector shapes; the original photographic skin grain is intentionally
not reproduced. No raster body is embedded or loaded by the vector renderer.
