import type { AgentToolCompletion } from "@matebot/adapter-kit";
import { redactSecrets } from "@matebot/core";
import type { ThreadEvents } from "@matebot/db";
import { RunHistoryWriteError } from "@matebot/db";
import { getLogger } from "@matebot/logging";
import { isToolPauseResult } from "./approval-effect.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { classifyToolFailure } from "./tool-failure.js";
import { isFailedToolResult, toolResultError, toolResultFailure } from "./tool-result-error.js";

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
    // The same id the request was recorded with. It is the only join key between
    // `agent.tool.called` and this completion, so it is always present.
    executionId: redactSecrets(completion.executionId, secrets),
    durationMs,
    outcome: completion.paused ? "paused" : error === undefined ? "succeeded" : "error",
  };
  if (error !== undefined) {
    payload.error = sanitizeConnectorError(error, secrets);
    // What kind of failure, decided from the error's own class, code or status
    // rather than from its wording, so a reworded provider message changes nothing.
    // The original failure is classified, not the message: `error` above is prose.
    const failure = classifyToolFailure(
      completion.error !== undefined
        ? completion.error
        : (toolResultFailure(completion.result) ?? error),
    );
    payload.failure = failure.detail
      ? { class: failure.class, detail: redactSecrets(failure.detail, secrets) }
      : { class: failure.class };
  }
  // Where a network tool went. The query, fragment and userinfo never reach this
  // point, and the path only when `reachableDestinationOf` judged it a page this
  // build ships.
  if (completion.destination) {
    const { host, origin, path, pathWithheld } = completion.destination;
    payload.destination = {
      host: redactSecrets(host, secrets),
      origin: redactSecrets(origin, secrets),
      ...(path !== undefined ? { path: redactSecrets(path, secrets) } : {}),
      ...(pathWithheld ? { pathWithheld } : {}),
    };
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
 * Where a network tool went, as far as it is safe to write down.
 *
 * The host alone could not answer the audit's question — which page a run opened —
 * so a path is recorded too, but only when something other than its shape vouches
 * for it. Shape is not evidence: `/users/alex` and `/users/ada` are equally
 * word-like, and a short token or a person's name looks exactly like a section
 * name. So the rule is an allow list, not a pattern:
 *
 * - The path of a page this build ships (the product documentation, a closed set)
 *   is kept, because the set itself guarantees no user data is in it.
 * - Everything else keeps only the origin, with a marker saying the path was
 *   withheld, so a reader knows something was omitted rather than believing the
 *   log is complete.
 *
 * The query string, the fragment and any userinfo are dropped, always: those are
 * where a token, a search phrase or an address travels.
 */
export type ReachableDestination = {
  host: string;
  /** Full origin (scheme + host + port) — enough to tell two ports apart. */
  origin: string;
  /** The path when something vouches for it; absent when withheld. */
  path?: string;
  /** Present when the path was withheld, naming the reason without the value. */
  pathWithheld?: "unrecognised" | "credential_shaped" | "too_long";
};

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
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
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

  if (url.pathname.length > 200) return { host, origin, pathWithheld: "too_long" };
  const segments = url.pathname.split("/").filter(Boolean);
  // A credential-shaped segment is reported as such even when the route is one we
  // would otherwise keep, so the marker says why rather than only that.
  if (segments.some((segment) => SUSPICIOUS_SEGMENT.test(segment))) {
    return { host, origin, pathWithheld: "credential_shaped" };
  }
  // Not a page this build ships: the path may name a person, a document or a
  // token, so it is withheld rather than trusted.
  return { host, origin, pathWithheld: "unrecognised" };
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
  const destination = payload.destination as ReachableDestination | undefined;
  const failure = payload.failure as { class: string; detail?: string } | undefined;
  // The log line carries the same facts as the stored payload, so a run can be
  // followed from the request (`agent.tool.called`) to this completion by
  // execution id alone, and to the page it opened without the path being guessed
  // from a tool name. Only what `reachableDestinationOf` judged safe is here.
  getLogger().info("agent.tool.completed", {
    "run.id": target.runId,
    "space.id": target.spaceId,
    "thread.id": target.threadId,
    "bot.id": target.botId,
    "tool.call_id": payload.executionId,
    tool: payload.name,
    "tool.outcome": payload.outcome,
    "tool.duration_ms": payload.durationMs,
    ...(failure ? { "tool.failure.class": failure.class } : {}),
    ...(failure?.detail ? { "tool.failure.detail": failure.detail } : {}),
    ...(destination
      ? {
          "tool.destination.host": destination.host,
          "tool.destination.origin": destination.origin,
          ...(destination.path ? { "tool.destination.path": destination.path } : {}),
          ...(destination.pathWithheld
            ? { "tool.destination.path_withheld": destination.pathWithheld }
            : {}),
        }
      : {}),
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
