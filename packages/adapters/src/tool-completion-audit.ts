import type { AgentToolCompletion } from "@matebot/adapter-kit";
import { redactSecrets } from "@matebot/core";
import type { ThreadEvents } from "@matebot/db";
import { RunHistoryWriteError } from "@matebot/db";
import { getLogger } from "@matebot/logging";
import { isToolPauseResult } from "./approval-effect.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { isFailedToolResult, toolResultError } from "./tool-result-error.js";

function isAuditableToolResult(value: unknown): value is {
  kind: "agent_tool_result";
  content: unknown[];
  details: unknown;
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "agent_tool_result" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function toolCompletionFromResult(
  base: Pick<AgentToolCompletion, "name" | "executionId" | "durationMs">,
  result: unknown,
): AgentToolCompletion {
  const paused = isToolPauseResult(result);
  if (isFailedToolResult(result)) return { ...base, error: result.error, paused };
  return { ...base, result, paused };
}

export function toolCompletionAuditPayload(
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Record<string, unknown> {
  const durationMs = Number.isFinite(completion.durationMs)
    ? Math.max(0, Math.round(completion.durationMs))
    : 0;
  const error =
    completion.error === undefined ? toolResultError(completion.result) : completion.error;
  const payload: Record<string, unknown> = {
    name: redactSecrets(completion.name, secrets),
    executionId: redactSecrets(completion.executionId, secrets),
    durationMs,
    outcome: completion.paused ? "paused" : error === undefined ? "succeeded" : "error",
  };
  if (error !== undefined) {
    payload.error = sanitizeConnectorError(error, secrets);
  }
  // Where a network tool went. The query, fragment and userinfo never reach this
  // point; the path does only when `reachableDestinationOf` judged it safe.
  if (completion.destination) {
    const { host, origin, path, pathWithheld } = completion.destination;
    payload.host = redactSecrets(host, secrets);
    payload.origin = redactSecrets(origin, secrets);
    if (path !== undefined) payload.path = redactSecrets(path, secrets);
    if (pathWithheld) payload.pathWithheld = pathWithheld;
  }
  if (!isAuditableToolResult(completion.result)) return payload;

  payload.contentTypes = completion.result.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const type = (part as { type?: unknown }).type;
    return type === "text" || type === "image" ? [type] : [];
  });
  const details = completion.result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return payload;
  }
  const record = details as Record<string, unknown>;
  if (typeof record.frameId === "string") {
    payload.frameId = redactSecrets(record.frameId, secrets);
  }
  if (typeof record.capturedAt === "string") {
    payload.capturedAt = record.capturedAt;
  }
  if (typeof record.width === "number" && Number.isFinite(record.width)) {
    payload.width = record.width;
  }
  if (typeof record.height === "number" && Number.isFinite(record.height)) {
    payload.height = record.height;
  }
  return payload;
}

/**
 * The registrable host a network tool reached, or nothing.
 *
 * The audit could see which tool ran and whether it failed, but not where it was
 * pointed — so a run that opened a product documentation page could not be traced
 * to the address that was opened. The host is enough to answer that and nothing
 * more: the path and query are omitted because they can carry a token, a search
 * phrase, or a private identifier, and the scheme is dropped because it adds
 * nothing to the question "which site".
 */
export function reachableHostOf(args: Record<string, unknown>): string | undefined {
  const raw = args.url ?? args.endpoint ?? args.href;
  if (typeof raw !== "string") return undefined;
  try {
    const host = new URL(raw).hostname.trim().toLowerCase();
    if (!host) return undefined;
    // A bare IP or a very long name is not a site name worth the space in a log.
    return host.length <= 253 ? host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a network tool went, as far as it is safe to write down.
 *
 * The host alone could not answer the audit's question — which page a run opened —
 * so the path is recorded too, but only when it is provably harmless. Three rules:
 *
 * - The query string, the fragment and any userinfo are dropped, always. Those are
 *   where a token, a search phrase or an address travels.
 * - A path is kept when it is a product documentation page (a closed set this build
 *   ships) or a plain word-like path: letters, digits, `-`, `_`, `.` and `/`, with
 *   no segment that looks like an identifier, an email or a credential.
 * - Otherwise only the origin is kept, with a marker saying the path was withheld,
 *   so a reader knows something was omitted rather than believing the log is
 *   complete.
 */
export type ReachableDestination = {
  host: string;
  /** Full origin (scheme + host + port) — enough to tell two ports apart. */
  origin: string;
  /** The path when it is safe to record; absent when withheld. */
  path?: string;
  /** Present when the path was withheld, naming the reason without the value. */
  pathWithheld?: "unrecognised" | "credential_shaped" | "too_long";
};

/** A path segment that is plainly a word, not an identifier or a secret. */
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,40})$/;

/** Shapes that usually carry a credential or a personal identifier. */
const SUSPICIOUS_SEGMENT =
  /^(?:[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/=_-]{16,}|.*@.*|[0-9a-f]{16,}|sk[_-].*|gh[pousr]_.*)$/i;

export function reachableDestinationOf(
  args: Record<string, unknown>,
  documentationUrls: readonly string[] = [],
): ReachableDestination | undefined {
  const raw = args.url ?? args.endpoint ?? args.href;
  if (typeof raw !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.trim().toLowerCase();
  if (!host || host.length > 253) return undefined;
  const origin = url.origin;

  // A page this build ships is safe by construction, and is the case the audit
  // needed: it names the documentation page that was opened.
  if (documentationUrls.some((safe) => sameDestination(safe, url))) {
    return { host, origin, path: url.pathname };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (url.pathname.length > 200) return { host, origin, pathWithheld: "too_long" };
  if (segments.some((segment) => SUSPICIOUS_SEGMENT.test(segment))) {
    return { host, origin, pathWithheld: "credential_shaped" };
  }
  if (segments.some((segment) => !SAFE_SEGMENT.test(segment))) {
    return { host, origin, pathWithheld: "unrecognised" };
  }
  return { host, origin, path: url.pathname };
}

/** Whether two URLs name the same page, ignoring case and a trailing slash. */
function sameDestination(safe: string, actual: URL): boolean {
  try {
    const expected = new URL(safe);
    const normalize = (value: string) => value.replace(/\/+$/, "").toLowerCase();
    return (
      expected.origin.toLowerCase() === actual.origin.toLowerCase() &&
      normalize(expected.pathname) === normalize(actual.pathname)
    );
  } catch {
    return false;
  }
}

export async function appendToolCompletionAudit(
  deps: { events: Pick<ThreadEvents, "append"> },
  target: { spaceId: string; threadId: string; botId: string; runId: string },
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Promise<void> {
  const payload = toolCompletionAuditPayload(completion, secrets);
  getLogger().info("agent.tool.completed", {
    "run.id": target.runId,
    "space.id": target.spaceId,
    "thread.id": target.threadId,
    "bot.id": target.botId,
    tool: payload.name,
    "tool.outcome": payload.outcome,
    "tool.duration_ms": payload.durationMs,
  });
  try {
    await deps.events.append({
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.runId,
      type: "agent.tool.completed",
      payload,
    });
  } catch (error) {
    // A tool that finishes after its run was cancelled has no history to join.
    if (error instanceof RunHistoryWriteError) return;
    // Audit persistence must not change the tool result or strand the run.
    getLogger().warn("agent tool completion audit append failed", {
      "error.detail": sanitizeConnectorError(error, secrets),
      tool: redactSecrets(completion.name, secrets),
      executionId: redactSecrets(completion.executionId, secrets),
    });
  }
}
