import type { A2uiProtocolFamily } from "@matebot/contracts";
import { webCoreSchemaPath } from "./protocol.js";

export type ZodSafeParse = {
  success: boolean;
  data?: unknown;
  error?: { message: string; issues?: unknown };
};

export type ZodSchemaLike = {
  safeParse: (data: unknown) => ZodSafeParse;
};

export type WebCoreV09Module = {
  A2uiMessageSchema: ZodSchemaLike;
  A2uiMessageListSchema: ZodSchemaLike;
};

export type WebCoreV10Module = {
  AgentToRendererMessageSchema: ZodSchemaLike;
};

export type WebCoreSchemaModule = WebCoreV09Module | WebCoreV10Module;

/**
 * Dynamic import boundary for `@a2ui/web_core`.
 * Missing/broken deps fail here instead of at app module-evaluation time.
 */
export async function loadWebCoreSchemas(family: A2uiProtocolFamily): Promise<WebCoreSchemaModule> {
  const path = webCoreSchemaPath(family);
  try {
    if (path === "./v0_9") {
      return (await import("@a2ui/web_core/v0_9")) as WebCoreV09Module;
    }
    return (await import("@a2ui/web_core/v1_0")) as WebCoreV10Module;
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown";
    throw new Error(
      `@matebot/a2ui-adapter: failed to load @a2ui/web_core${path} (${message}). ` +
        "A2UI remains optional for non-adapter builds.",
      { cause },
    );
  }
}

export function isV09Module(mod: WebCoreSchemaModule): mod is WebCoreV09Module {
  return "A2uiMessageListSchema" in mod;
}
