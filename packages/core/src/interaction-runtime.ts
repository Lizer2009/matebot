import type { InteractionField, InteractionPlan } from "@matebot/contracts";

/** Server-side Interaction lifecycle (design §7.4). Client cannot claim SUCCEEDED. */
export type InteractionLifecycleStatus =
  | "collecting"
  | "ready_for_review"
  | "awaiting_approval"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "needs_connection"
  | "cancelled";

export type InteractionDraftState = {
  status: InteractionLifecycleStatus;
  draftVersion: number;
  confirmedVersion: number | null;
  plan: InteractionPlan;
  slots: Record<string, unknown>;
};

export type FieldChangeResult =
  | {
      ok: true;
      draftVersion: number;
      confirmedVersion: null;
      status: InteractionLifecycleStatus;
      slots: Record<string, unknown>;
      plan: InteractionPlan;
    }
  | { ok: false; error: "version_conflict" | "terminal" | "unknown_field"; message: string };

const TERMINAL: ReadonlySet<InteractionLifecycleStatus> = new Set(["succeeded", "cancelled"]);
const LOCKED: ReadonlySet<InteractionLifecycleStatus> = new Set([
  "executing",
  "failed",
  "unknown",
  ...TERMINAL,
]);

export function interactionSlotsFromPlan(plan: InteractionPlan): Record<string, unknown> {
  const slots: Record<string, unknown> = {};
  for (const field of plan.fields) {
    if (field.value !== undefined) slots[field.name] = field.value;
  }
  return slots;
}

export function requiredFieldsSatisfied(
  plan: InteractionPlan,
  slots: Record<string, unknown>,
): boolean {
  return plan.fields.every((field) => {
    if (!field.required) return true;
    const value = slots[field.name];
    if (value === undefined || value === null) return false;
    if (typeof value === "string" && value.trim() === "") return false;
    return true;
  });
}

/** Derive collecting vs ready_for_review from required slots (never invents approval/execute). */
export function deriveCollectingStatus(
  plan: InteractionPlan,
  slots: Record<string, unknown>,
  current: InteractionLifecycleStatus,
): InteractionLifecycleStatus {
  if (current === "needs_connection" || LOCKED.has(current)) {
    return current;
  }
  if (current === "awaiting_approval") {
    // Edits after confirm return to collecting/ready; caller clears confirmation.
    return requiredFieldsSatisfied(plan, slots) ? "ready_for_review" : "collecting";
  }
  return requiredFieldsSatisfied(plan, slots) ? "ready_for_review" : "collecting";
}

export function applyInteractionFieldChange(
  state: InteractionDraftState,
  input: {
    expectedDraftVersion: number;
    name: string;
    value: unknown;
    /**
     * Who is writing. A value the person typed is stamped `source: "user"` on
     * the field itself, so a later model edit can tell it apart from a value the
     * model proposed and leave it alone (spec §6.4.3).
     */
    origin?: "user" | "model";
  },
): FieldChangeResult {
  if (LOCKED.has(state.status)) {
    return {
      ok: false,
      error: "terminal",
      message: `Interaction is ${state.status} and cannot accept field edits`,
    };
  }
  if (state.draftVersion !== input.expectedDraftVersion) {
    return {
      ok: false,
      error: "version_conflict",
      message: `Expected draftVersion ${input.expectedDraftVersion}, found ${state.draftVersion}`,
    };
  }
  const field = state.plan.fields.find((entry) => entry.name === input.name);
  if (!field) {
    return { ok: false, error: "unknown_field", message: `Unknown field: ${input.name}` };
  }

  const slots = { ...state.slots, [input.name]: input.value };
  const origin = input.origin ?? "model";
  const plan = {
    ...state.plan,
    fields: state.plan.fields.map((entry) =>
      entry.name === input.name ? { ...withFieldValue(entry, input.value), source: origin } : entry,
    ),
  };
  const status = deriveCollectingStatus(plan, slots, state.status);
  return {
    ok: true,
    draftVersion: state.draftVersion + 1,
    confirmedVersion: null,
    status,
    slots,
    plan,
  };
}

export function withFieldValue(field: InteractionField, value: unknown): InteractionField {
  const empty =
    value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  let status = field.status;
  if (empty) {
    status = field.required ? "missing" : field.status === "invalid" ? "invalid" : "resolved";
  } else if (status === "missing" || status === "needs_confirmation") {
    status = "resolved";
  }
  return { ...field, value, status };
}

export type ConfirmDraftResult =
  | { ok: true; confirmedVersion: number; status: "awaiting_approval" }
  | { ok: false; error: "version_conflict" | "not_ready" | "terminal"; message: string };

/** Confirm only when draftVersion matches and required fields are present. */
export function confirmInteractionDraftState(
  state: InteractionDraftState,
  draftVersion: number,
): ConfirmDraftResult {
  if (LOCKED.has(state.status)) {
    return {
      ok: false,
      error: "terminal",
      message: `Interaction is ${state.status} and cannot be confirmed`,
    };
  }
  if (state.draftVersion !== draftVersion) {
    return {
      ok: false,
      error: "version_conflict",
      message: `Expected draftVersion ${draftVersion}, found ${state.draftVersion}`,
    };
  }
  if (!requiredFieldsSatisfied(state.plan, state.slots)) {
    return {
      ok: false,
      error: "not_ready",
      message: "Required fields are missing",
    };
  }
  return { ok: true, confirmedVersion: state.draftVersion, status: "awaiting_approval" };
}

/** Send gate: confirmedVersion must equal draftVersion. */
export function canExecuteConfirmedInteraction(state: {
  draftVersion: number;
  confirmedVersion: number | null;
  status: InteractionLifecycleStatus;
}): { ok: true } | { ok: false; error: "unconfirmed" | "terminal" | "unknown"; message: string } {
  if (state.status === "unknown") {
    return {
      ok: false,
      error: "unknown",
      message: "Send result is unknown; do not send again",
    };
  }
  if (state.status === "executing") {
    return {
      ok: false,
      error: "unconfirmed",
      message: "Send is already in progress",
    };
  }
  if (TERMINAL.has(state.status)) {
    return { ok: false, error: "terminal", message: `Interaction is ${state.status}` };
  }
  if (state.confirmedVersion === null || state.confirmedVersion !== state.draftVersion) {
    return {
      ok: false,
      error: "unconfirmed",
      message: "Send requires confirmedVersion to equal draftVersion",
    };
  }
  return { ok: true };
}
