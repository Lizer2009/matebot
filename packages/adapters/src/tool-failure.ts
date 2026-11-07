/**
 * What kind of failure a tool call had.
 *
 * The audit could see that a call failed but not what kind of failure it was, so a
 * refused address, an expired credential and a dead network all read the same. The
 * classification is decided from structured signals first — an error's own class,
 * its `code`, its HTTP status — because a message is prose that changes when a
 * provider rewords it. A message pattern is the last resort and is only consulted
 * for the few shapes that have no structured form at all.
 *
 * The ordering matters for safety: a refusal by the network policy is recognised
 * before anything that could be read as an ordinary network error, so a blocked
 * destination is never recorded as "the network was down" and retried as though
 * nothing had been decided about it. The converse is equally important — a host
 * that simply did not resolve is a connectivity problem, not a policy decision, and
 * is classified as one.
 */

export type ToolFailureClass =
  | "cancelled"
  | "timeout"
  /** The egress policy refused this destination. Never retried as a network blip. */
  | "security_refused"
  /** A credential is missing, expired, or rejected. */
  | "auth_required"
  /** The credential store itself could not be read. */
  | "credential_unavailable"
  | "rate_limited"
  | "invalid_input"
  /** Name resolution or connection failed; nothing was decided about the destination. */
  | "network_error"
  /** A provider or sandbox we depend on is down or unreachable. */
  | "provider_unavailable"
  | "unknown";

export type ToolFailure = {
  class: ToolFailureClass;
  /** A structured code, HTTP status, or the refusal reason. Never a message. */
  detail?: string;
};

/** Codes and class names that mean a credential problem. */
const AUTH_CODES = new Set([
  "CONNECTOR_AUTH_UNAVAILABLE",
  "AUTH_REQUIRED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "invalid_grant",
  "invalid_token",
]);

const AUTH_ERROR_NAMES = new Set([
  "ConnectorAuthUnavailableError",
  "ModelSignInError",
  "McpOAuthClientRequiredError",
]);

const CREDENTIAL_STORE_CODES = new Set(["SECRET_STORE_UNAVAILABLE"]);
const CREDENTIAL_MISSING_CODES = new Set(["SECRET_NOT_FOUND"]);

const RATE_LIMIT_CODES = new Set(["SANDBOX_RATE_LIMIT", "RATE_LIMITED", "rate_limit_exceeded"]);
const RATE_LIMIT_NAMES = new Set(["SandboxRateLimitError", "TooManyRequestsError"]);

const INVALID_INPUT_NAMES = new Set(["SandboxRequestRejectedError", "WorkspaceTooLargeError"]);

const PROVIDER_UNAVAILABLE_NAMES = new Set([
  "SandboxUnavailableError",
  "SandboxUnresponsiveError",
  "SandboxDamagedError",
]);

/** Node's own network error codes. Nothing here says a destination was refused. */
const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/** Codes that mean the destination was refused by policy rather than unreachable. */
const SECURITY_CODES = new Set(["EGRESS_REFUSED"]);

/** The guard's reason for a host that resolved to nothing: a connectivity problem. */
const UNRESOLVED_REASON = "URL did not resolve to any address";

type ErrorFacts = {
  name: string;
  code?: string;
  status?: number;
  /** A structured refusal reason carried by our own egress error. */
  refusal?: string;
};

/**
 * Read the structured facts off an error and, when it has none of its own, off its
 * causes.
 *
 * A frame that carries a class name is a fact in itself — `AbortError` and
 * `TimeoutError` are recognised by name and by nothing else — so a named error is
 * returned rather than skipped in favour of its cause. The cause is consulted only
 * when this frame says nothing at all, which is the wrapping case it exists for.
 */
function factsOf(error: unknown, depth = 0): ErrorFacts | undefined {
  if (!error || typeof error !== "object" || depth > 3) return undefined;
  const record = error as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  const code = typeof record.code === "string" ? record.code : undefined;
  // Our guard marks the error it refused with this, whether or not it made the error.
  const refusal = typeof record.egressReason === "string" ? record.egressReason : undefined;
  const status = httpStatus(record) ?? httpStatus(record.response);
  if (code || refusal || status !== undefined) return { name, code, status, refusal };
  // A name this classifier knows is enough on its own.
  if (KNOWN_NAMES.has(name)) return { name };
  if (name && name !== "Error") return { name };
  return factsOf(record.cause, depth + 1);
}

const KNOWN_NAMES = new Set([
  ...AUTH_ERROR_NAMES,
  ...RATE_LIMIT_NAMES,
  ...INVALID_INPUT_NAMES,
  ...PROVIDER_UNAVAILABLE_NAMES,
  "TimeoutError",
  "AbortError",
]);

function httpStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["status", "statusCode"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Classify one tool failure.
 *
 * `message` is consulted only after every structured signal has been ruled out, and
 * only for the sentence our own guard produces verbatim. A provider that rewords
 * its errors therefore changes nothing here.
 */
export function classifyToolFailure(error: unknown): ToolFailure {
  const facts = factsOf(error);
  if (facts) {
    // A refusal is a policy decision, unless the guard's own reason says the host
    // simply did not resolve — that is connectivity, and is recorded as such.
    if (facts.refusal) {
      return facts.refusal === UNRESOLVED_REASON
        ? { class: "network_error", detail: "unresolved" }
        : { class: "security_refused", detail: facts.refusal };
    }
    if (facts.code && SECURITY_CODES.has(facts.code)) {
      return { class: "security_refused", detail: facts.code };
    }
    if (facts.code && CREDENTIAL_STORE_CODES.has(facts.code)) {
      return { class: "credential_unavailable", detail: facts.code };
    }
    if (facts.code && CREDENTIAL_MISSING_CODES.has(facts.code)) {
      return { class: "auth_required", detail: facts.code };
    }
    if (AUTH_ERROR_NAMES.has(facts.name)) {
      return { class: "auth_required", detail: facts.code ?? facts.name };
    }
    if (facts.code && AUTH_CODES.has(facts.code)) {
      return { class: "auth_required", detail: facts.code };
    }
    if (facts.status === 401 || facts.status === 403) {
      return { class: "auth_required", detail: `http_${facts.status}` };
    }
    if (facts.name === "TimeoutError" || (facts.code && TIMEOUT_CODES.has(facts.code))) {
      return { class: "timeout", detail: facts.code ?? "timeout" };
    }
    if (facts.name === "AbortError" || facts.code === "ABORT_ERR") {
      return { class: "cancelled", detail: facts.code ?? "aborted" };
    }
    if (facts.status === 429) return { class: "rate_limited", detail: "http_429" };
    if (facts.code && RATE_LIMIT_CODES.has(facts.code)) {
      return { class: "rate_limited", detail: facts.code };
    }
    if (facts.status === 408 || facts.status === 504) {
      return { class: "timeout", detail: `http_${facts.status}` };
    }
    if (facts.code && NETWORK_CODES.has(facts.code)) {
      return { class: "network_error", detail: facts.code };
    }
    if (RATE_LIMIT_NAMES.has(facts.name)) return { class: "rate_limited", detail: facts.name };
    if (INVALID_INPUT_NAMES.has(facts.name)) return { class: "invalid_input", detail: facts.name };
    if (PROVIDER_UNAVAILABLE_NAMES.has(facts.name)) {
      return { class: "provider_unavailable", detail: facts.name };
    }
    if (facts.status !== undefined && facts.status >= 500) {
      return { class: "provider_unavailable", detail: `http_${facts.status}` };
    }
  }
  return classifyByMessage(messageOf(error));
}

/** The one sentence our own guard produces, and nothing provider-specific. */
function classifyByMessage(message: string): ToolFailure {
  if (!message) return { class: "unknown" };
  if (message.includes(UNRESOLVED_REASON)) {
    return { class: "network_error", detail: "unresolved" };
  }
  return { class: "unknown" };
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (typeof error === "number" || typeof error === "boolean") return String(error);
    return JSON.stringify(error).slice(0, 500);
  }
  return "";
}
