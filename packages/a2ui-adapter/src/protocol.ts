import type { A2uiProtocolFamily } from "@matebot/contracts";

/** Active compile/validate track for Phase 1 hosts. */
export const DEFAULT_PROTOCOL_FAMILY = "v0_9" as const satisfies A2uiProtocolFamily;

/** Wire version string inside A2UI messages for a Matebot protocol family. */
export function protocolWireVersion(family: A2uiProtocolFamily): "v0.9" | "1.0" {
  switch (family) {
    case "v0_9":
      return "v0.9";
    case "v1_0":
      return "1.0";
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
}

/** Basic catalog id for the given family (upstream specification URLs). */
export function basicCatalogId(family: A2uiProtocolFamily): string {
  switch (family) {
    case "v0_9":
      return "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";
    case "v1_0":
      return "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
}

/** `@a2ui/web_core` subpath export for this family. */
export function webCoreSchemaPath(family: A2uiProtocolFamily): "./v0_9" | "./v1_0" {
  switch (family) {
    case "v0_9":
      return "./v0_9";
    case "v1_0":
      return "./v1_0";
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
}
