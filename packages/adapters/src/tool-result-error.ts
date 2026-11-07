export function isFailedToolResult(value: unknown): value is { error: unknown } {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  return error !== undefined && error !== null;
}

/**
 * Tools can return an `error` or MCP `isError: true` instead of throwing. Pi keeps that
 * result in `details` without populating `completion.error`. Read the failure for auditing
 * without changing the result that reaches the model and lets it react to the failure.
 */
export function toolResultError(result: unknown): unknown {
  const payload = (result as { details?: unknown } | null)?.details ?? result;
  if (isFailedToolResult(payload)) {
    const message = (payload.error as { message?: unknown })?.message;
    return typeof message === "string" ? message : payload.error;
  }
  if (!payload || typeof payload !== "object") return undefined;
  if ((payload as { isError?: unknown }).isError !== true) return undefined;
  const content = (payload as { content?: unknown }).content;
  const text = Array.isArray(content)
    ? content
        .map((part) => (part as { text?: unknown } | null)?.text)
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .trim()
    : "";
  return text || "tool reported an error result";
}

/**
 * The failure itself, not its message.
 *
 * `toolResultError` returns text for display. Classification needs the original
 * value so it can read an error class, a `code` or an HTTP status, which the
 * message has already dropped. Both paths a tool can fail through are covered:
 * a returned `{ error }` and an MCP `isError: true` result.
 */
export function toolResultFailure(result: unknown): unknown {
  const payload = (result as { details?: unknown } | null)?.details ?? result;
  if (!payload || typeof payload !== "object") return undefined;
  if (isFailedToolResult(payload)) {
    const error = (payload as { error?: unknown }).error;
    // A plain string carries no structure, so it is the message and nothing more.
    return typeof error === "string" ? { message: error } : error;
  }
  if ((payload as { isError?: unknown }).isError !== true) return undefined;
  return payload;
}
