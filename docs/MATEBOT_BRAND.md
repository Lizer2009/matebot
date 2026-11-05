# Matebot brand (fork)

**Product name:** Matebot (not Metabot)

**Positioning:** Companion AI teammate for online secondary development without a local desktop. This repository is a fork of [Rakazo](https://github.com/elie222/rakazo); upstream credit and Apache-2.0 attribution stay in place.

## Colors

| Role | Hex |
| --- | --- |
| Indigo (primary ink) | `#312E81` |
| Teal (accent) | `#0D9488` |

The app UI remains on shared semantic tokens from `@matebot/ui-tokens`; these hex values define the **mark** and fork documentation.

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
| Desktop (macOS bundle) | Still built from upstream `packages/ui-tokens/assets/Rakazo.icon` until a Matebot `.icon` catalog lands; Electron `productName` stays `Rakazo` so packaging/CI paths stay stable |
| Mobile favicon | `apps/mobile/assets/favicon.png` |

Regenerate web/desktop/mobile icon sizes from the sources:

```bash
pnpm --filter @matebot/ui-tokens export:matebot
```

## Product title in code

Customer-facing shell strings use `PRODUCT_DISPLAY_NAME` from `@matebot/core` (`packages/core/src/product-brand.ts`). npm packages remain `@matebot/*` in this fork phase.

The same constant names what a bot calls itself where the model sees it: the runtime's fallback system prompt, its subagent framing, the automated-message label, the product help skill in the `/` picker, and the name onboarding gives a space's first bot. Those are the strings behind a "who are you?" answer, so a fork answers as itself instead of as upstream.
