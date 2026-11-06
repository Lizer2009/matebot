/**
 * Pre-flight catalog whitelist for A2UI Surface messages.
 * Unknown component names are refused — no arbitrary HTML/JSX from the model.
 */

/** Basic catalog component names (v0.9 / Phase 1 render pin). Keep in sync with `@a2ui/web_core` basic catalog. */
export const BASIC_CATALOG_COMPONENT_NAMES = [
  "Text",
  "Image",
  "Icon",
  "Video",
  "AudioPlayer",
  "Row",
  "Column",
  "List",
  "Card",
  "Tabs",
  "Modal",
  "Divider",
  "Button",
  "TextField",
  "CheckBox",
  "ChoicePicker",
  "Slider",
  "DateTimeInput",
] as const;

export type BasicCatalogComponentName = (typeof BASIC_CATALOG_COMPONENT_NAMES)[number];

const ALLOWED = new Set<string>(BASIC_CATALOG_COMPONENT_NAMES);

/** Safe identifier: catalog component names are PascalCase letters only. */
const SAFE_COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export type CatalogGuardResult =
  | { ok: true }
  | { ok: false; reason: string; unknownComponents: string[] };

function componentNameOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.component === "string") return record.component;
  // Reject object-shaped "component" payloads (would look like JSX/custom trees).
  if (record.component !== undefined) return "[non-string]";
  return undefined;
}

/**
 * Scan A2UI agent→renderer messages for component names outside the basic catalog.
 * Refuses non-string component fields and names that are not safe identifiers.
 */
export function guardA2uiCatalogMessages(messages: unknown[]): CatalogGuardResult {
  if (!Array.isArray(messages)) {
    return { ok: false, reason: "messages must be an array", unknownComponents: [] };
  }

  const unknown = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      return { ok: false, reason: "each message must be an object", unknownComponents: [] };
    }
    const update = (message as { updateComponents?: { components?: unknown } }).updateComponents;
    if (!update) continue;
    const components = update.components;
    if (!Array.isArray(components)) {
      return {
        ok: false,
        reason: "updateComponents.components must be an array",
        unknownComponents: [],
      };
    }
    for (const entry of components) {
      const name = componentNameOf(entry);
      if (name === undefined) {
        return {
          ok: false,
          reason: "component entry is missing a component name",
          unknownComponents: [],
        };
      }
      if (!SAFE_COMPONENT_NAME.test(name) || !ALLOWED.has(name)) {
        unknown.add(name);
      }
    }
  }

  if (unknown.size > 0) {
    const list = [...unknown].sort();
    return {
      ok: false,
      reason: `Unknown catalog component(s): ${list.join(", ")}`,
      unknownComponents: list,
    };
  }

  return { ok: true };
}
