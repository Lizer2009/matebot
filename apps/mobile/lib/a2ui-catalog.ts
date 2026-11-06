export type NativeCatalogNode =
  | { type: "Text"; text: string }
  | { type: "Column"; children: NativeCatalogNode[] }
  | { type: "TextField"; id: string; label: string; value: string }
  | { type: "Button"; id: string; label: string }
  | { type: "Sheet"; title?: string; children: NativeCatalogNode[] };

export type NativeCatalogResult =
  | { ok: true; nodes: NativeCatalogNode[] }
  | { ok: false; component: string };

const ALLOWED = new Set(["Text", "Column", "TextField", "Button", "Sheet"]);

type ComponentRecord = {
  id: string;
  component: string;
  children?: unknown;
  text?: unknown;
  label?: unknown;
  value?: unknown;
};

export function emailFieldsFromSurfaceMessages(messages: unknown[] | undefined): {
  to: string;
  subject: string;
  body: string;
} {
  const empty = { to: "", subject: "", body: "" };
  if (!messages) return empty;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const value = (message as { updateDataModel?: { value?: unknown } }).updateDataModel?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const fields = (value as { fields?: unknown }).fields;
    if (!Array.isArray(fields)) continue;
    const read = (name: string) => {
      const field = fields.find(
        (entry) =>
          entry && typeof entry === "object" && (entry as { name?: unknown }).name === name,
      ) as { value?: unknown } | undefined;
      return typeof field?.value === "string" ? field.value : "";
    };
    return { to: read("to"), subject: read("subject"), body: read("body") };
  }
  return empty;
}

export function isEmailComposeIntent(intent: string | undefined): boolean {
  return intent === "email.compose" || intent === "email.send";
}

/** Parse a v0.9 component list into the native catalog. Unknown components refuse the surface. */
export function parseNativeCatalog(messages: unknown[] | undefined): NativeCatalogResult {
  const components = componentRecords(messages);
  if (!components) return { ok: true, nodes: [] };
  for (const component of components) {
    if (!ALLOWED.has(component.component)) {
      return { ok: false, component: component.component || "unknown" };
    }
  }
  const data = dataModel(messages);
  const byId = new Map(components.map((component) => [component.id, component]));
  const childIds = new Set<string>();
  for (const component of components) {
    for (const id of stringList(component.children)) childIds.add(id);
  }
  const roots = components.filter((component) => !childIds.has(component.id));
  const start = roots.length > 0 ? roots : components.slice(0, 1);
  return {
    ok: true,
    nodes: start.map((component) => nodeFrom(component, byId, data)),
  };
}

function nodeFrom(
  component: ComponentRecord,
  byId: Map<string, ComponentRecord>,
  data: unknown,
): NativeCatalogNode {
  if (component.component === "Column") {
    return {
      type: "Column",
      children: stringList(component.children).map((id) => {
        const child = byId.get(id);
        return child ? nodeFrom(child, byId, data) : { type: "Text", text: "" };
      }),
    };
  }
  if (component.component === "Sheet") {
    return {
      type: "Sheet",
      title: boundText(component.label, data) || boundText(component.text, data) || undefined,
      children: stringList(component.children).map((id) => {
        const child = byId.get(id);
        return child ? nodeFrom(child, byId, data) : { type: "Text", text: "" };
      }),
    };
  }
  if (component.component === "TextField") {
    return {
      type: "TextField",
      id: component.id,
      label: boundText(component.label, data) || component.id,
      value: boundText(component.value, data) || boundText(component.text, data),
    };
  }
  if (component.component === "Button") {
    return {
      type: "Button",
      id: component.id,
      label: boundText(component.text, data) || boundText(component.label, data) || component.id,
    };
  }
  return { type: "Text", text: boundText(component.text, data) };
}

function componentRecords(messages: unknown[] | undefined): ComponentRecord[] | null {
  if (!messages) return null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const components = (message as { updateComponents?: { components?: unknown } }).updateComponents
      ?.components;
    if (!Array.isArray(components)) continue;
    return components.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { id?: unknown; component?: unknown };
      if (typeof record.id !== "string" || typeof record.component !== "string") return [];
      return [{ ...(entry as ComponentRecord), id: record.id, component: record.component }];
    });
  }
  return null;
}

function dataModel(messages: unknown[] | undefined): unknown {
  if (!messages) return undefined;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const value = (message as { updateDataModel?: { value?: unknown } }).updateDataModel?.value;
    if (value && typeof value === "object") return value;
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function boundText(value: unknown, data: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const path = (value as { path?: unknown }).path;
  if (typeof path !== "string") return "";
  const resolved = valueAt(data, path);
  return typeof resolved === "string" ? resolved : "";
}

function valueAt(root: unknown, path: string): unknown {
  const parts = path.replace(/^\//, "").split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
