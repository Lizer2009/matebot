/** Customer-facing product name for this Matebot fork (UI shell, PWA, desktop title). */
export const PRODUCT_DISPLAY_NAME = "Matebot";

/** Reverse-DNS namespace for the fork's installers, bundles, and data directories. */
export const PRODUCT_APPLICATION_ID = "dev.matebot";

/**
 * Stable identifier the desktop app uses for its own on-disk files.
 *
 * Electron derives `userData` from this, so it also names the Windows `%APPDATA%`
 * folder, the local-stack Compose project, and the setup folder. Keeping it a
 * constant (rather than the display name) means a display-name tweak never
 * strands an existing install's data.
 */
export const PRODUCT_SLUG = "matebot";
