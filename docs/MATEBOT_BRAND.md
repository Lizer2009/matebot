# Matebot brand (fork)

**Product name:** Matebot (not Metabot)

**Positioning:** A self-hosted AI teammate you own. This repository is a fork of
[Rakazo](https://github.com/elie222/rakazo); upstream credit and Apache-2.0 attribution stay in
place.

## Colors

| Role | Hex |
| --- | --- |
| Indigo (primary ink) | `#312E81` |
| Teal (accent) | `#0D9488` |

The app UI remains on shared semantic tokens from `@matebot/ui-tokens`; these hex values define the
**mark** and fork documentation.

## Mark

Geometric, non-anthropomorphic identity only (no face, eyes, or robot-head art).

- **App icon:** Indigo→teal gradient square; white angular **M** with a caret/cursor accent on the right leg.
- **Wordmark:** Indigo and teal parallelogram shapes plus **Matebot** in indigo (`#312E81`).

Do not substitute a different logo or revert to earlier mascot-style marks.

## Asset paths

| Asset | Path |
| --- | --- |
| Source icon (JPG) | `branding/matebot-icon-source.jpg` |
| Source wordmark (JPG) | `branding/matebot-wordmark-source.jpg` |
| Exported icon (PNG) | `branding/matebot-icon.png`, `docs/assets/matebot-icon.png` |
| Exported wordmark (PNG) | `branding/matebot-wordmark.png`, `docs/assets/matebot-wordmark.png` |
| Web favicon / PWA icons | `apps/web/public/favicon*`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` |
| Web named copies | `apps/web/public/matebot-icon.png`, `matebot-wordmark.png` |
| Desktop (Linux/Windows) | `apps/desktop/assets/icon.png`, `icon.ico` |
| Desktop and mobile (macOS/iOS bundle) | `packages/ui-tokens/assets/Matebot.icon` (Icon Composer catalog) |
| Marketing kit | `apps/www/public/brand/matebot-mark.png`, `apps/www/public/brand/kit/matebot-*` |
| Marketing wordmark (SVG) | `apps/www/public/brand/kit/matebot-wordmark.svg` |
| Mobile favicon | `apps/mobile/assets/favicon.png` |

Regenerate the artwork from the sources:

```bash
pnpm --filter @matebot/ui-tokens export:matebot        # favicons, PWA icons, desktop icons
pnpm --filter @matebot/ui-tokens export:matebot-icon   # macOS/iOS Icon Composer layer
pnpm --filter @matebot/ui-tokens export:matebot-wordmark  # marketing SVG wordmark
```

`export:matebot-icon` matters on its own: Icon Composer composites the layer over the icon's own
squircle, so the artwork must be full-bleed. The script rebuilds the indigo→teal plate behind the
mark rather than leaving the source's white corners.

`export:matebot-wordmark` traces the flat-colour source art into two filled paths. It is a
build-time convenience, not a checked-in pipeline step: the committed SVG is what the site ships.

## Names the product uses

One constant drives the customer-facing name everywhere:

```1:15:packages/core/src/product-brand.ts
/** Customer-facing product name for this Matebot fork (UI shell, PWA, desktop title). */
export const PRODUCT_DISPLAY_NAME = "Matebot";
```

`PRODUCT_DISPLAY_NAME` names what a bot calls itself where the model sees it: the runtime's fallback
system prompt, its subagent framing, the automated-message label, the product help skill in the `/`
picker, and the name onboarding gives a space's first bot. Those are the strings behind a "who are
you?" answer, so a fork answers as itself instead of as upstream.

Packaging names are set where the tooling reads them, and must stay in step:

| Surface | Where | Value |
| --- | --- | --- |
| npm scope | every `package.json` | `@matebot/*`, root `matebot` |
| Electron `productName` | `apps/desktop/package.json` | `Matebot` |
| macOS bundle id | `apps/desktop/package.json` `build.appId` | `dev.matebot.desktop` |
| Profile folder / AppData | Electron derives it from `productName` | `Matebot` |
| Windows installer | `build.nsis.artifactName` | `${productName}-Setup-${version}.exe` |
| Linux executable | `build.linux.executableName` | `matebot` |
| Expo app name | `apps/mobile/app.json` `expo.name` | `Matebot` |

Electron names the per-user profile folder after `productName` (`%APPDATA%\Matebot` on Windows,
`~/.config/Matebot` on Linux, `~/Library/Application Support/Matebot` on macOS), not after
`extraMetadata.name`. That is why the migration in `user-data-migration.ts` looks for the old
`Rakazo` folder rather than the current one, and why the desktop app carries a pre-rename profile
over on first launch instead of stranding an existing install's setup.

Names that deliberately keep their upstream value are listed in
[MATEBOT_DEPLOY.md](./MATEBOT_DEPLOY.md#环境变量命名): the `RAKAZO_*` environment variables, the
`rakazo_app` database role, the `rakazo://` mobile scheme, and the mobile bundle id, which need
store-side coordination before they can change.
