import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The row factory must re-create itself when the server's answer changes.
 *
 * `/me` resolves after the first render. `renderMessageRow` is memoised and passed to the
 * list as `extraData`, so a value it reads but does not depend on is frozen at the first
 * render: the thread keeps drawing "cards are off" after the server says they are on, and
 * only an unrelated change ever fixes it.
 *
 * This is a structural assertion on purpose. The alternative is mounting the whole row
 * list, which drags in Expo native modules; the contract being checked is exactly "is this
 * name in that dependency array", and nothing weaker would catch a silent removal.
 */
const source = readFileSync(
  path.resolve(import.meta.dirname, "../components/thread/thread-rows.tsx"),
  "utf8",
);

/** The dependency array of the `renderMessageRow` callback, as written. */
function renderMessageRowDeps(text: string): string | null {
  const start = text.indexOf("const renderMessageRow = useCallback(");
  if (start < 0) return null;
  // The array is the last argument: find the `[` that follows the body's closing `},`.
  const end = text.indexOf("\n    ],", start);
  if (end < 0) return null;
  const open = text.lastIndexOf("[\n", end);
  if (open < 0 || open < start) return null;
  return text.slice(open, end);
}

describe("the row factory's dependencies", () => {
  it("includes the server's card answer, so it is not frozen at first render", () => {
    const deps = renderMessageRowDeps(source);
    expect(deps, "renderMessageRow's dependency array was not found").not.toBeNull();
    expect(deps).toContain("a2uiEnabled");
  });
});
