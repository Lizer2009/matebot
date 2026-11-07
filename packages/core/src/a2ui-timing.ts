import type { MessageBlock } from "@matebot/contracts";

/**
 * The seven moments the spec asks us to measure (§9.6), and what each one means.
 *
 * The reason these are named rather than ad hoc log lines is that the interesting
 * number is not "how long did the run take" but "how long until the user saw
 * something they could act on". A surface is first feedback exactly like a text
 * reply, so an A2UI turn must not look like it produced nothing for ten seconds
 * while a card sat on screen.
 */
export const A2UI_METRICS = [
  /** The user's own submission for a draft or action. */
  "user-submit",
  /** The first thing the user can read or act on in this turn. */
  "first-feedback",
  /** The server ruled on the decision and knows which surface to build. */
  "plan-ready",
  /** The surface was persisted and pushed to the client. */
  "surface-visible",
  /** The user's action was accepted and is now running. */
  "action-confirmed",
  /** The provider answered (or failed in a classified way). */
  "provider-result",
  /** An UNKNOWN outcome was resolved by reconciling it. */
  "reconciled",
] as const;

export type A2uiMetric = (typeof A2UI_METRICS)[number];

/** A point in the turn these offsets are measured from. */
export type A2uiClockOrigin = "user-message" | "run-created";

export type A2uiTimingSample = {
  metric: A2uiMetric;
  /** Milliseconds from the origin, never negative. */
  ms: number;
  /** Which origin the offset is against, so two numbers are never compared wrongly. */
  origin: A2uiClockOrigin;
};

/**
 * A surface counts as first feedback.
 *
 * This mirrors `isRunResponse` in `packages/db/src/run-timing.ts`, which does not
 * list `a2ui_surface`. Without this, an A2UI turn that renders a card and nothing
 * else records no first response at all, and its p95 silently disappears from the
 * very measurement the spec asks for.
 */
export function isA2uiFirstFeedback(type: string, payload: Record<string, unknown>): boolean {
  if (type !== "thread.message.created" || payload.role !== "bot") return false;
  if (!Array.isArray(payload.blocks)) return false;
  return payload.blocks.some((block: unknown) => {
    if (!block || typeof block !== "object" || !("kind" in block)) return false;
    if (block.kind === "a2ui_surface") return true;
    if (block.kind === "text") {
      return "text" in block && typeof block.text === "string" && block.text.trim().length > 0;
    }
    return false;
  });
}

export function timingSample(input: {
  metric: A2uiMetric;
  origin: Date | number;
  at: Date | number;
  originLabel: A2uiClockOrigin;
}): A2uiTimingSample {
  const origin = typeof input.origin === "number" ? input.origin : input.origin.getTime();
  const at = typeof input.at === "number" ? input.at : input.at.getTime();
  return {
    metric: input.metric,
    ms: Math.max(0, at - origin),
    origin: input.originLabel,
  };
}

/** The log fields for a sample; prefixed so a metric is never confused with a run field. */
export function timingFields(sample: A2uiTimingSample): Record<string, string | number> {
  return {
    "a2ui.metric": sample.metric,
    "a2ui.origin": sample.origin,
    "a2ui.ms": sample.ms,
  };
}

/**
 * p95 over a set of samples. Nearest-rank, so the number is an actual observed
 * value rather than an interpolated one that never happened.
 */
export function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

export type A2uiTimingReport = {
  samples: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

export function timingReport(values: readonly number[]): A2uiTimingReport {
  if (values.length === 0) return { samples: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    p50: sorted[Math.floor((sorted.length - 1) / 2)] ?? null,
    p95: percentile95(values),
    max: sorted[sorted.length - 1] ?? null,
  };
}

export type { MessageBlock };
