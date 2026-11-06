import { describe, expect, it } from "vitest";
import { CORPUS_IMPLEMENTED, corpusByStatus, MULTI_TURN_CORPUS } from "./corpus.js";

/**
 * The 12-scenario gate from the spec, run as data.
 *
 * These are not twelve hardcoded prompt special-cases: each row declares what
 * the product must do for its class (QUERY / ANALYZE / CREATE / UPDATE / QA),
 * whether that capability is implemented in the current phase, and what the safe
 * behaviour is while it is not. A row marked `deferred` asserts the *fallback*,
 * so an absent chart or calendar implementation can never masquerade as a pass.
 */

describe("multi-turn corpus gate", () => {
  it("defines exactly the twelve spec scenarios", () => {
    expect(MULTI_TURN_CORPUS).toHaveLength(12);
    expect(new Set(MULTI_TURN_CORPUS.map((row) => row.id)).size).toBe(12);
  });

  it("tags every scenario with a class and a phase", () => {
    const classes = new Set(["QUERY", "ANALYZE", "CREATE", "UPDATE", "QA"]);
    for (const row of MULTI_TURN_CORPUS) {
      expect(classes.has(row.class)).toBe(true);
      expect(["phase0", "phase1", "phase2", "phase3"]).toContain(row.phase);
    }
  });

  // The heart of the honest gate: an unimplemented capability must declare its
  // fallback, and the fallback must never claim a side effect.
  it("gives every deferred or unsupported row an explicit safe behaviour", () => {
    for (const row of MULTI_TURN_CORPUS) {
      if (row.status === "implemented") continue;
      expect(row.status === "deferred" || row.status === "unsupported").toBe(true);
      expect(row.safeBehaviour).toBeTruthy();
      expect(row.safeBehaviour ?? "").not.toMatch(/已发送|已创建|sent|created|success/i);
      // A row without a capability must never promise an action.
      expect(row.expectsAction).toBe(false);
    }
  });

  it("marks the two Phase 0 capabilities as implemented", () => {
    const implemented = corpusByStatus("implemented").map((row) => row.id);
    // Email compose/edit is the one end-to-end capability this phase ships.
    expect(implemented).toContain(7);
    // Basic Q&A never renders a card, and is satisfied today.
    expect(implemented).toContain(8);
  });

  it("does not claim calendar, chart, or GitHub capability is implemented", () => {
    const implemented = new Set(corpusByStatus("implemented").map((row) => row.id));
    // 1/2 sales trend (Phase 2), 4/5 calendar (Phase 1), 9 GitHub (Phase 3).
    for (const id of [1, 2, 4, 5, 9]) expect(implemented.has(id)).toBe(false);
  });

  it("keeps each scenario's expectation internally consistent", () => {
    for (const row of MULTI_TURN_CORPUS) {
      // A read-only class must never expect an action.
      if (row.class === "QUERY" || row.class === "ANALYZE") expect(row.expectsAction).toBe(false);
      // Neither may an unsupported path, and it renders no surface either.
      if (row.status === "unsupported") {
        expect(row.expectsAction).toBe(false);
        expect(row.rendersSurface).toBe(false);
      }
      // A QA row renders no surface at all.
      if (row.class === "QA") expect(row.rendersSurface).toBe(false);
      // An implemented row must name the surface it renders.
      if (row.status === "implemented" && row.rendersSurface) {
        expect(row.surfaceKind).toBeTruthy();
      }
    }
  });

  it("declares the multi-turn requirement on the rows that need it", () => {
    const multiTurn = MULTI_TURN_CORPUS.filter((row) => row.multiTurn);
    // Same-card edit (2, 7), ambiguous reference (10), resume (11), repeat (12).
    expect(multiTurn.map((row) => row.id).sort((a, b) => a - b)).toEqual([2, 7, 10, 11, 12]);
  });
});

describe("Phase 0 gate: only implemented rows count as passing", () => {
  it("reports the implemented subset rather than all twelve", () => {
    // A guard against a report that says "12/12 green" while most are deferred.
    expect(CORPUS_IMPLEMENTED.length).toBeLessThan(MULTI_TURN_CORPUS.length);
    expect(CORPUS_IMPLEMENTED.every((row) => row.status === "implemented")).toBe(true);
  });

  it("records the phase that will implement each deferred row", () => {
    for (const row of corpusByStatus("deferred")) {
      expect(row.implementingPhase).toBeTruthy();
      expect(row.implementingPhase).not.toBe("phase0");
    }
  });
});
