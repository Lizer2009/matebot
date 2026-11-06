import type { EmailConnectionSnapshot } from "./interaction-preflight.js";
import { emailCapabilityAllowsSend, preflightEmailCapability } from "./interaction-preflight.js";
import type { InteractionLifecycleStatus } from "./interaction-runtime.js";
import type { EmailSurfaceLifecycle, EmailSurfaceTemplate } from "./interaction-template.js";
import {
  emailDeliveryOutcome,
  emailSurfaceBlockFields,
  resolveEmailSurfaceTemplate,
} from "./interaction-template.js";

/**
 * A deterministic model of one interaction turn: the connection state goes in,
 * the surface stamps and the single primary card action come out. No database,
 * no provider, no network — the same inputs always produce the same card, so the
 * orchestration matrix can be checked without deploying to a real workspace.
 */
export type SimulatedConnectionState =
  /** No saved authorization at all. */
  | "not_connected"
  /** Saved, but the provider reports it dead and the user must authorize again. */
  | "requires_reauth"
  /** Saved and usable. */
  | "ready"
  /** The local row still says connected while the provider already killed the account. */
  | "stale_local_connected";

export const SIMULATED_CONNECTION_STATES: readonly SimulatedConnectionState[] = [
  "not_connected",
  "requires_reauth",
  "ready",
  "stale_local_connected",
];

export type SimulatedConnection = {
  connections: EmailConnectionSnapshot[];
  reconnectRefs: string[];
  providerReady: Record<string, boolean>;
};

const SIMULATED_ACCOUNT = "ca_simulated";
const SIMULATED_REVOKED_ACCOUNT = "ca_simulated_revoked";

/**
 * Connection rows as the database would hold them, plus the provider's own view.
 * `stale_local_connected` is the production shape that broke Send: the row says
 * connected while the provider lists a dead account.
 */
export function simulatedConnection(state: SimulatedConnectionState): SimulatedConnection {
  switch (state) {
    case "ready":
      return {
        connections: [{ provider: "gmail", status: "connected", providerRef: SIMULATED_ACCOUNT }],
        reconnectRefs: [],
        providerReady: { gmail: true },
      };
    case "requires_reauth":
      return {
        connections: [
          { provider: "gmail", status: "error", providerRef: SIMULATED_REVOKED_ACCOUNT },
        ],
        reconnectRefs: [SIMULATED_REVOKED_ACCOUNT],
        providerReady: { gmail: false },
      };
    case "stale_local_connected":
      return {
        connections: [
          { provider: "gmail", status: "connected", providerRef: SIMULATED_REVOKED_ACCOUNT },
        ],
        reconnectRefs: [SIMULATED_REVOKED_ACCOUNT],
        providerReady: { gmail: false },
      };
    default:
      return { connections: [], reconnectRefs: [], providerReady: {} };
  }
}

/** The one button the review card may offer for a lifecycle. */
export type SimulatedPrimaryAction =
  | "connect"
  | "reconnect"
  | "send"
  | "retry"
  | "check_status"
  | "none";

export type SimulatedSurface = {
  capability: ReturnType<typeof preflightEmailCapability>["surfaceCapability"];
  interactionStatus: InteractionLifecycleStatus;
  template: EmailSurfaceTemplate;
  lifecycle: EmailSurfaceLifecycle;
  primaryAction: SimulatedPrimaryAction;
  /** Whether the server would accept Send right now. */
  canSend: boolean;
};

export type SimulatedTurnInput = {
  connection: SimulatedConnectionState;
  interactionStatus: InteractionLifecycleStatus;
  effectStatus?: string | null;
  error?: string | null;
};

const ACTION_BY_TEMPLATE: Record<EmailSurfaceTemplate, SimulatedPrimaryAction> = {
  "email-connection-card": "connect",
  "email-reauth-card": "reconnect",
  "email-draft-card": "send",
  "action-submitting-card": "none",
  "action-progress-card": "none",
  "action-result-success": "none",
  "action-result-failed": "retry",
  "action-reconcile-card": "check_status",
};

/** Render one email surface for a connection state and lifecycle. */
export function simulateEmailSurface(input: SimulatedTurnInput): SimulatedSurface {
  const sim = simulatedConnection(input.connection);
  const preflight = preflightEmailCapability({
    connections: sim.connections,
    reconnectRefs: sim.reconnectRefs,
    providerReady: sim.providerReady,
  });
  const stamps = emailSurfaceBlockFields({
    intent: "email.compose",
    capability: preflight.surfaceCapability,
    interactionStatus: input.interactionStatus,
    effectStatus: input.effectStatus,
    error: input.error,
  });
  return {
    capability: preflight.surfaceCapability,
    interactionStatus: input.interactionStatus,
    template: stamps.template,
    lifecycle: stamps.lifecycle,
    primaryAction: ACTION_BY_TEMPLATE[stamps.template],
    // Send is on screen only on the editable draft of a usable mailbox; every
    // other template owns its own single action or none at all.
    canSend: stamps.template === "email-draft-card" && emailCapabilityAllowsSend(preflight.status),
  };
}

/** What the provider did when the user pressed the single Send gesture. */
export type SimulatedDelivery = "ok" | "provider_error" | "timeout" | "reconnect_error";

export const SIMULATED_DELIVERIES: readonly SimulatedDelivery[] = [
  "ok",
  "provider_error",
  "timeout",
  "reconnect_error",
];

/** Provider text the real connector emits when the saved account died. */
export const SIMULATED_RECONNECT_ERROR =
  "The gmail connection is no longer active. Ask the user to reconnect gmail.";

const DELIVERY_ERRORS: Record<SimulatedDelivery, string | undefined> = {
  ok: undefined,
  provider_error: "550 Mailbox unavailable",
  timeout: "Request timed out",
  reconnect_error: SIMULATED_RECONNECT_ERROR,
};

/**
 * Run one Send against a delivery outcome and report the surface a host would
 * render from the server's own stamps. Never reports success the provider did
 * not confirm: only `ok` reaches the success template.
 */
export function simulateEmailSend(input: {
  connection: SimulatedConnectionState;
  delivery: SimulatedDelivery;
}): SimulatedSurface & { interactionStatus: InteractionLifecycleStatus; effectStatus: string } {
  const error = DELIVERY_ERRORS[input.delivery];
  if (input.delivery === "ok") {
    return {
      ...simulateEmailSurface({
        connection: input.connection,
        interactionStatus: "succeeded",
        effectStatus: "completed",
      }),
      interactionStatus: "succeeded",
      effectStatus: "completed",
    };
  }
  const outcome = emailDeliveryOutcome({ error });
  const interactionStatus = outcome === "unknown" ? "unknown" : "failed";
  const effectStatus = outcome === "unknown" ? "ambiguous" : "failed";
  return {
    ...simulateEmailSurface({
      connection: input.connection,
      interactionStatus,
      effectStatus,
      error,
    }),
    interactionStatus,
    effectStatus,
  };
}

/** Server gate for Send: confirmed draft, usable mailbox, no UNKNOWN in flight. */
export function simulateSendGate(input: { connection: SimulatedConnectionState }): {
  accepted: boolean;
  reason?: "not_connected" | "requires_reauth" | "no_effect";
} {
  const sim = simulatedConnection(input.connection);
  const preflight = preflightEmailCapability({
    connections: sim.connections,
    reconnectRefs: sim.reconnectRefs,
    providerReady: sim.providerReady,
  });
  if (emailCapabilityAllowsSend(preflight.status)) return { accepted: true };
  return {
    accepted: false,
    reason: preflight.status === "REQUIRES_REAUTH" ? "requires_reauth" : "not_connected",
  };
}

/** Which app an intent needs, mirrored for calendar resume scenarios. */
export type SimulatedApp = "email" | "calendar" | "none";

export function simulatedApp(intent: string): SimulatedApp {
  if (intent === "email.compose" || intent === "email.send") return "email";
  if (intent.startsWith("calendar.")) return "calendar";
  return "none";
}

/**
 * The connect → resume handshake: a surface that waited for an app must produce
 * another surface once that app is connected, not a free-text reply.
 */
export function simulateConnectionResume(input: {
  intent: string;
  interactionStatusBefore: InteractionLifecycleStatus;
  connectedProvider: string | null;
}): { resumed: boolean; template: EmailSurfaceTemplate | null } {
  const app = simulatedApp(input.intent);
  if (input.interactionStatusBefore !== "needs_connection" || !input.connectedProvider) {
    return { resumed: false, template: null };
  }
  const providerIsApp =
    app === "email"
      ? input.connectedProvider.toLowerCase().includes("gmail")
      : app === "calendar"
        ? input.connectedProvider.toLowerCase().includes("calendar")
        : false;
  if (!providerIsApp) return { resumed: false, template: null };
  return {
    resumed: true,
    template: resolveEmailSurfaceTemplate({
      intent: input.intent,
      capability: "ready",
      interactionStatus: "collecting",
    }),
  };
}
