import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * An A2UI card is a thread message, the same as ask / app_connect. Android used
 * ModalBottomSheet (and iOS BottomSheet) so "帮我发一封邮件" covered the chat
 * instead of landing in the transcript, and matchContents sized the form past
 * the phone width. Cards stay StyleSheet in the row; native sheets are for
 * menus, not conversation surfaces.
 */
const android = readFileSync(
  path.resolve(import.meta.dirname, "../components/thread/a2ui-native-controls.android.tsx"),
  "utf8",
);
const ios = readFileSync(
  path.resolve(import.meta.dirname, "../components/thread/a2ui-native-controls.ios.tsx"),
  "utf8",
);

describe("A2UI sheets stay in the thread", () => {
  it("does not present Android cards as a modal bottom sheet", () => {
    expect(android).not.toMatch(/\bModalBottomSheet\b/);
    expect(android).toMatch(/export function A2uiSheet/);
    expect(android).toMatch(/width:\s*"100%"/);
  });

  it("does not present iOS cards as a system bottom sheet", () => {
    expect(ios).not.toMatch(/\bBottomSheet\b/);
    expect(ios).toMatch(/export function A2uiSheet/);
    expect(ios).toMatch(/width:\s*"100%"/);
  });

  it("lets Android fields take the row width instead of their intrinsic size", () => {
    expect(android).toMatch(/matchContents=\{\{\s*vertical:\s*true,\s*horizontal:\s*false\s*\}\}/);
  });
});
