import type { SurfaceStatus } from "./surface-revision.js";

/**
 * Which card a natural-language edit refers to.
 *
 * A chat can hold several live surfaces, so "把它改一下" or "change the subject"
 * has no single answer. Rather than guess by recency or position — which is how
 * a user's correction lands on the wrong email — the caller supplies what it
 * actually knows, and this decides whether a target is unambiguous.
 */

export type OpenSurface = {
  taskId: string;
  surfaceId: string;
  intent: string;
  /** Short description shown in the clarifying question. */
  label: string;
  status: SurfaceStatus;
};

export type SurfaceReference = {
  /** The user named a specific task (for example by tapping it). */
  taskId?: string;
  /** The user used a pronoun or an unnamed reference such as "it". */
  pronoun?: boolean;
};

export type SurfaceTargetResult =
  | { kind: "target"; taskId: string }
  /** Several candidates: the caller must ask, and must not edit any of them. */
  | { kind: "clarify"; candidates: OpenSurface[] }
  | { kind: "none" }
  | { kind: "not_found" };

/**
 * An executed card is immutable, so it never competes for a reference: a
 * correction starts a new draft linked to it instead.
 */
function editable(surfaces: readonly OpenSurface[]): OpenSurface[] {
  return surfaces.filter((surface) => surface.status !== "executed");
}

export function resolveSurfaceTarget(input: {
  surfaces: readonly OpenSurface[];
  reference: SurfaceReference | undefined;
}): SurfaceTargetResult {
  const open = editable(input.surfaces);

  if (input.reference?.taskId) {
    const named = open.find((surface) => surface.taskId === input.reference?.taskId);
    return named ? { kind: "target", taskId: named.taskId } : { kind: "not_found" };
  }

  if (open.length === 0) return { kind: "none" };
  if (open.length === 1) return { kind: "target", taskId: open[0]!.taskId };

  // More than one live card: only an explicit choice is safe.
  return { kind: "clarify", candidates: open };
}

/** The question to ask, naming each candidate so the answer is unambiguous. */
export function clarificationQuestion(candidates: readonly OpenSurface[]): string {
  const names = candidates.map((candidate) => candidate.label).join("、");
  return `你指的是哪一张卡片？${names}`;
}
