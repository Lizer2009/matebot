/**
 * Dynamic import boundary for `@a2ui/*` (optional capability).
 * Call only when the `a2ui` feature flag is on — keeps the default bundle free
 * of the renderer when production leaves the flag off.
 */

/** One payload the renderer emits when a user presses a compiled button. */
export type A2uiActionPayload = {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context: Record<string, unknown>;
};

/**
 * A surface's action listener. The host passes it to `MessageProcessor`, which
 * routes every `action.event` in the tree through it — one bridge for all
 * compiled surfaces, not a handler per domain.
 */
export type A2uiActionListener = (action: A2uiActionPayload) => void | Promise<void>;

export type A2uiRendererModules = {
  A2uiSurface: typeof import("@a2ui/react").A2uiSurface;
  MarkdownContext: typeof import("@a2ui/react").MarkdownContext;
  MessageProcessor: typeof import("@a2ui/web_core").MessageProcessor;
  basicCatalog: typeof import("@a2ui/web_core/v0_9/basic_catalog").basicCatalog;
  injectBasicCatalogStyles: typeof import("@a2ui/web_core/v0_9/basic_catalog").injectBasicCatalogStyles;
};

let stylesInjected = false;

export async function loadA2uiRenderer(): Promise<A2uiRendererModules> {
  const [react, webCore, catalog] = await Promise.all([
    import("@a2ui/react"),
    import("@a2ui/web_core"),
    import("@a2ui/web_core/v0_9/basic_catalog"),
  ]);
  if (!stylesInjected) {
    catalog.injectBasicCatalogStyles();
    stylesInjected = true;
  }
  return {
    A2uiSurface: react.A2uiSurface,
    MarkdownContext: react.MarkdownContext,
    MessageProcessor: webCore.MessageProcessor,
    basicCatalog: catalog.basicCatalog,
    injectBasicCatalogStyles: catalog.injectBasicCatalogStyles,
  };
}

/**
 * Build the processor for one surface. `onAction` is what turns a compiled
 * Button into a server call; without it the renderer draws a dead control, which
 * is exactly the gap this bridge closes. Keeping it here means every host gets
 * the same wiring instead of each screen remembering to pass one.
 */
export function createA2uiProcessor(
  mods: A2uiRendererModules,
  onAction: A2uiActionListener,
): InstanceType<A2uiRendererModules["MessageProcessor"]> {
  return new mods.MessageProcessor([mods.basicCatalog], onAction);
}

/** Escape-only markdown so Text never injects raw HTML from the model. */
export async function safePlainMarkdown(markdown: string): Promise<string> {
  return markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
