import { createHash } from "node:crypto";

/**
 * The identity of one action card: a thread plus an intent.
 *
 * Hashing keeps the key fixed-width and independent of intent spelling, so the
 * partial unique index is a plain single-column index. `node:crypto` is already
 * used in this package (`approval-effect-key.ts`).
 *
 * Reached through `@matebot/core/node/interaction-card-key`, never the barrel:
 * `node:crypto` is externalized for the browser, and a barrel re-export put it on
 * the web bundle's import path, where the whole app failed to start.
 *
 * The separator is a NUL byte, which no intent may contain, so
 * `(thread "a", intent "bc")` and `(thread "ab", intent "c")` cannot collide.
 *
 * The migration backfills the same digest in SQL
 * (`encode(sha256(convert_to(...)), 'hex')`), so old and new rows share one
 * identity. Changing this function without changing that SQL splits the table.
 */
export function interactionCardKey(threadId: string, intent: string): string {
  if (!threadId) throw new TypeError("interaction card key needs a thread id");
  if (!intent) throw new TypeError("interaction card key needs an intent");
  return createHash("sha256").update(`${threadId}\u0000${intent}`, "utf8").digest("hex");
}
