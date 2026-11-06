#!/usr/bin/env node
/**
 * Local A2UI orchestration simulator.
 *
 * Runs the real preflight, template, and lifecycle functions against scripted
 * connection states, so a card's behaviour can be checked without a workspace, a
 * provider, an OAuth round trip, or a container rebuild. It is the fast loop for
 * this area: change a rule in `packages/core`, run this, read the table.
 *
 *   node scripts/a2ui-sim.mjs                 # the whole matrix
 *   node scripts/a2ui-sim.mjs --scenario calendar-resume
 *   node scripts/a2ui-sim.mjs --json          # machine-readable
 *   node scripts/a2ui-sim.mjs --list
 *
 * Exits nonzero when a row contradicts the invariants in
 * docs/architecture/matebot-a2ui-orchestration-addendum.md, so it can gate a PR.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const simModule = join(root, "packages/core/src/interaction-simulation.ts");
const nudgeModule = join(root, "packages/core/src/interaction-nudge.ts");
const capabilityModule = join(root, "packages/core/src/interaction-capability.ts");
const planBridgeModule = join(root, "packages/core/src/interaction-plan-bridge.ts");

if (!existsSync(simModule)) {
  console.error(`Cannot find ${simModule}. Run this from a full checkout.`);
  process.exit(2);
}

const TSX = join(root, "node_modules/.bin/tsx");

/**
 * The simulator is TypeScript, so it is loaded through tsx rather than
 * reimplemented here — the point is to exercise the shipping functions.
 */
const childSource = `
import {
  SIMULATED_CONNECTION_STATES,
  SIMULATED_DELIVERIES,
  simulateCalendarSurface,
  simulateConnectionResume,
  simulateEmailSend,
  simulateEmailSurface,
  simulatedIntentForRequest,
  simulatedIntentSupported,
  simulateSendGate,
} from ${JSON.stringify(simModule)};
import { A2UI_SURFACE_NUDGE, surfaceNudgeFor } from ${JSON.stringify(nudgeModule)};
import {
  INTERACTION_CAPABILITIES,
  findInteractionCapability,
} from ${JSON.stringify(capabilityModule)};
import {
  surfaceFallback,
  surfacePlanForCapability,
} from ${JSON.stringify(planBridgeModule)};

const lifecycleFor = (state) =>
  state === "not_connected" || state === "requires_reauth" || state === "stale_local_connected"
    ? "needs_connection"
    : "ready_for_review";

/** The one card each delivery outcome must land on. */
const EXPECTED_SEND_OUTCOMES = {
  ok: { template: "action-result-success", action: "none" },
  provider_error: { template: "action-result-failed", action: "retry" },
  timeout: { template: "action-reconcile-card", action: "check_status" },
  reconnect_error: { template: "email-reauth-card", action: "reconnect" },
};

/** The line the turn would actually say, or "-" when the card owns the outcome. */
const surfaceNudge = (capability, lifecycle) => {
  const state = surfaceNudgeFor({ capability, lifecycle });
  return state ? A2UI_SURFACE_NUDGE[state] : "-";
};

/**
 * Real Chinese prompts typed into the desktop app, run through the shipping
 * simulators with the workspace states that were true in production. Each row is
 * one thing the user would do next, so the table reads like the session did.
 */
function buildDialogueScenario() {
  const rows = [];

  // 1. Email to a fixed address, subject and body supplied by the assistant.
  //    Tonight's mailbox was revoked while the local row still said connected.
  const emailRequest = "帮我发邮件:给 418452732@qq.com 主题: 秋后问候，内容: 自理";
  const staleDraft = simulateEmailSurface({
    connection: "stale_local_connected",
    interactionStatus: "needs_connection",
  });
  const staleSend = simulateEmailSend({
    connection: "stale_local_connected",
    delivery: "reconnect_error",
  });
  rows.push({
    prompt: emailRequest,
    step: "1a draft, revoked mailbox",
    template: staleDraft.template,
    action: staleDraft.primaryAction,
    canSend: staleDraft.canSend,
    resumed: "-",
    nudge: surfaceNudge(staleDraft.capability, staleDraft.lifecycle),
    expect: "reconnect",
  });
  rows.push({
    prompt: emailRequest,
    step: "1a send on revoked mailbox",
    template: staleSend.template,
    action: staleSend.primaryAction,
    canSend: staleSend.canSend,
    resumed: "-",
    nudge: surfaceNudge(staleSend.capability, staleSend.lifecycle),
    expect: "reconnect",
  });
  const readySend = simulateEmailSend({ connection: "ready", delivery: "ok" });
  rows.push({
    prompt: emailRequest,
    step: "1b send on live mailbox",
    template: readySend.template,
    action: readySend.primaryAction,
    canSend: readySend.canSend,
    resumed: "-",
    nudge: surfaceNudge(readySend.capability, readySend.lifecycle),
    expect: "sent",
  });

  // 2. A week of schedule, details left to the assistant. Today the closest
  //    shipping intent is calendar.create; nothing carries a date range, and no
  //    host renders a calendar editor. The connect step runs through the
  //    connect_app card, not a calendar connection card.
  const calendarRequest = "确定下周日程，主题和内容自理";
  const calendarIntent = simulatedIntentForRequest(calendarRequest);
  const calendarUnbound = simulateCalendarSurface({
    connection: "not_connected",
    interactionStatus: "needs_connection",
  });
  rows.push({
    prompt: calendarRequest,
    step: "2a unbound: connect_app card",
    template: calendarUnbound.template,
    action: "none",
    canSend: false,
    resumed: "-",
    nudge: surfaceNudge(calendarUnbound.capability, calendarUnbound.lifecycle),
    expect: "connect-via-app-card",
  });
  const calendarResume = simulateConnectionResume({
    intent: calendarIntent ?? "calendar.create",
    interactionStatusBefore: "needs_connection",
    connectedProvider: "googlecalendar",
  });
  const calendarConnected = simulateCalendarSurface({
    connection: "ready",
    interactionStatus: "collecting",
  });
  rows.push({
    prompt: calendarRequest,
    step: "2b after googlecalendar connect",
    template: calendarConnected.template,
    action: calendarConnected.action,
    canSend: calendarConnected.canSend,
    resumed: calendarResume.resumed,
    nudge: surfaceNudge(calendarConnected.capability, calendarConnected.lifecycle),
    expect: "resumed-readonly",
    // The honest gap: the turn resumes, but there is nothing to type into.
    gap:
      calendarConnected.gap +
      '; a date range ("下周") has no slot on that plan, and the nudge points at a card with nothing to tap',
  });

  // 3. A shell job on the user's own computer. The orchestrator presents
  //    compose/send and calendar surfaces only, so this has no surface at all.
  const githubRequest = "登录 Github 做一次简单的代码拉取到本地电脑，项目你自选";
  const githubIntent = simulatedIntentForRequest(githubRequest);
  rows.push({
    prompt: githubRequest,
    step: "3 github pull to local computer",
    template: githubIntent ?? "none",
    action: "none",
    canSend: false,
    resumed: false,
    nudge: "-",
    expect: "out_of_scope",
    gap: githubIntent
      ? "mapped to an intent the orchestrator has no editor for"
      : "no InteractionPlan/intent exists: this is a computer/shell task, not an A2UI surface",
  });

  return {
    id: "dialogue-prompts",
    title: "three real Chinese prompts, run against tonight's workspace states",
    rows,
    check: (row) => {
      if (row.expect === "reconnect") {
        return (
          row.template === "email-reauth-card" &&
          row.action === "reconnect" &&
          !row.canSend &&
          row.nudge === A2UI_SURFACE_NUDGE.reconnect
        );
      }
      if (row.expect === "sent") {
        return (
          row.template === "action-result-success" &&
          row.nudge === "-" &&
          !row.canSend
        );
      }
      if (row.expect === "connect-via-app-card") {
        // No template is stamped for a non-email intent, so the calendar surface
        // carries none. The user connects through the connect_app card, and the
        // nudge says so; the row must not pretend an email draft exists.
        return (
          row.template === null &&
          row.action === "none" &&
          !row.canSend &&
          row.nudge === A2UI_SURFACE_NUDGE.awaiting_connection
        );
      }
      if (row.expect === "resumed-readonly") {
        return row.resumed === true && row.action === "none" && !row.canSend;
      }
      // Nothing presents a surface, and the row must say so rather than pass.
      return row.expect === "out_of_scope" && !simulatedIntentSupported(row.template);
    },
    invariant:
      "each prompt lands on the card its state calls for; an unsupported request reports out_of_scope instead of passing",
  };
}

/**
 * Which intents are actually registered, and what a request that names none of
 * them produces. This is the guard against "register one card per prompt": a
 * prompt with no capability must return a safe fallback, not a surface.
 */
function buildCapabilityScenario() {
  const registered = INTERACTION_CAPABILITIES.map((capability) => {
    const plan = surfacePlanForCapability(capability.intent);
    return {
      case: capability.intent,
      registered: findInteractionCapability(capability.intent) !== undefined,
      implemented: capability.implemented,
      presentation: capability.schema.presentation,
      action: capability.schema.action?.id ?? "-",
      connection: capability.requiresConnection ?? "-",
      renders: plan.ok ? "yes" : plan.reason,
      expect: capability.implemented ? "renders" : "not_implemented",
    };
  });

  const unregistered = [
    "github.clone",
    "sales.annualTrend",
    "schedule.week",
    "file.analyze",
  ].map((intent) => {
    const plan = surfacePlanForCapability(intent);
    const fallback = surfaceFallback(intent);
    return {
      case: intent,
      registered: findInteractionCapability(intent) !== undefined,
      implemented: false,
      presentation: "-",
      action: "-",
      connection: "-",
      renders: plan.ok ? "yes" : plan.reason,
      expect: "unregistered_intent",
      fallback: fallback.text,
    };
  });

  return {
    id: "capability-registry",
    title: "which intents exist, and what an unregistered one produces",
    rows: [...registered, ...unregistered],
    check: (row) => {
      // A form must offer exactly one action; a result surface must offer none.
      if (row.expect === "renders") {
        return row.presentation === "form"
          ? row.renders === "yes" && row.action !== "-"
          : row.renders === "yes" && row.action === "-";
      }
      if (row.expect === "not_implemented") {
        return row.renders === "not_implemented" && row.action === "-";
      }
      // No capability means no surface and no action, ever.
      return (
        row.renders === "unregistered_intent" &&
        row.action === "-" &&
        typeof row.fallback === "string" &&
        row.fallback.length > 0
      );
    },
    invariant:
      "an intent renders only when registered and implemented; anything else gets a text fallback and no action",
  };
}

const scenarios = [
  {
    id: "connection-states",
    title: "preflight three-state drives the card",
    rows: SIMULATED_CONNECTION_STATES.map((connection) => {
      const surface = simulateEmailSurface({
        connection,
        interactionStatus: lifecycleFor(connection),
      });
      const gate = simulateSendGate({ connection });
      return {
        case: connection,
        capability: surface.capability,
        template: surface.template,
        action: surface.primaryAction,
        sendOffered: surface.canSend,
        sendAccepted: gate.accepted,
        nudge: surfaceNudgeFor({ capability: surface.capability, lifecycle: surface.lifecycle }) ?? "-",
      };
    }),
    /** Send may only be offered where the server would also accept it. */
    check: (row) => (row.sendOffered ? row.sendAccepted : true),
    invariant: "Send is offered only when the server accepts it",
  },
  {
    id: "send-outcomes",
    title: "send lifecycle maps every provider outcome onto one card",
    rows: SIMULATED_DELIVERIES.map((delivery) => {
      const surface = simulateEmailSend({ connection: "ready", delivery });
      return {
        case: delivery,
        template: surface.template,
        lifecycle: surface.lifecycle,
        interaction: surface.interactionStatus,
        effect: surface.effectStatus,
        action: surface.primaryAction,
        success: surface.template === "action-result-success",
      };
    }),
    /**
     * Each outcome has one correct card: a confirmed send succeeds, an ordinary
     * provider error retries, a timeout reconciles, and a dead authorization
     * reconnects. Success is never claimed for anything but a confirmed send.
     */
    check: (row) => {
      const expected = EXPECTED_SEND_OUTCOMES[row.case];
      return row.template === expected.template && row.action === expected.action;
    },
    invariant: "each provider outcome maps onto its own card, success only when confirmed",
  },
  {
    id: "unknown-reconcile",
    title: "an UNKNOWN send never offers Send again",
    rows: [
      {
        case: "unknown",
        ...(() => {
          const surface = simulateEmailSurface({
            connection: "ready",
            interactionStatus: "unknown",
            effectStatus: "ambiguous",
          });
          return { template: surface.template, action: surface.primaryAction, sendOffered: surface.canSend };
        })(),
      },
    ],
    check: (row) => row.action === "check_status" && !row.sendOffered,
    invariant: "UNKNOWN reconciles instead of resending",
  },
  {
    id: "calendar-resume",
    title: "a waiting turn continues once its app connects",
    rows: [
      { case: "calendar connects", intent: "calendar.create", provider: "googlecalendar", status: "needs_connection" },
      { case: "mailbox connects", intent: "email.compose", provider: "gmail", status: "needs_connection" },
      { case: "wrong app connects", intent: "calendar.create", provider: "gmail", status: "needs_connection" },
      { case: "draft was not waiting", intent: "calendar.create", provider: "googlecalendar", status: "ready_for_review" },
    ].map((row) => {
      const resumed = simulateConnectionResume({
        intent: row.intent,
        interactionStatusBefore: row.status,
        connectedProvider: row.provider,
      });
      return { ...row, resumed: resumed.resumed, nextTemplate: resumed.template ?? "-" };
    }),
    check: (row) => {
      const shouldResume = row.case === "calendar connects" || row.case === "mailbox connects";
      return row.resumed === shouldResume;
    },
    invariant: "only the app the surface acts through resumes it",
  },
  buildDialogueScenario(),
  buildCapabilityScenario(),
];

const nudges = Object.entries(A2UI_SURFACE_NUDGE).map(([state, text]) => ({
  case: state,
  text,
  ok: text.length <= 20 && text.endsWith("。"),
}));

// Functions do not survive JSON, so each row carries its verdict instead.
const graded = scenarios.map((scenario) => ({
  id: scenario.id,
  title: scenario.title,
  invariant: scenario.invariant,
  rows: scenario.rows.map((row) => ({ ...row, ok: Boolean(scenario.check(row)) })),
  ok: scenario.rows.every((row) => scenario.check(row)),
})).map(({ rows, ...rest }) => ({
  ...rest,
  rows,
}));

process.stdout.write(JSON.stringify({ scenarios: graded, nudges }, null, 2));
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "A2UI orchestration simulator",
      "",
      "  node scripts/a2ui-sim.mjs              run every scenario",
      "  node scripts/a2ui-sim.mjs --scenario <id>",
      "  node scripts/a2ui-sim.mjs --json       print the raw rows",
      "  node scripts/a2ui-sim.mjs --list       list scenario ids",
      "",
      "Scenarios: connection-states, send-outcomes, unknown-reconcile, calendar-resume, dialogue-prompts, capability-registry",
    ].join("\n"),
  );
  process.exit(0);
}

const result = spawnSync(TSX, ["--eval", childSource], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});

if (result.status !== 0) {
  console.error(result.stderr || result.stdout || "Simulator failed to run.");
  process.exit(result.status ?? 1);
}

const { scenarios, nudges } = JSON.parse(result.stdout);
const only = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : undefined;
const asJson = args.includes("--json");

if (args.includes("--list")) {
  for (const scenario of scenarios) console.log(`${scenario.id}\t${scenario.title}`);
  process.exit(0);
}

const selected = only ? scenarios.filter((scenario) => scenario.id === only) : scenarios;
if (selected.length === 0) {
  console.error(`Unknown scenario "${only}". Try --list.`);
  process.exit(2);
}

if (asJson) {
  console.log(JSON.stringify({ scenarios: selected, nudges }, null, 2));
  process.exit(0);
}

let failed = 0;
for (const scenario of selected) {
  console.log(`\n${scenario.id} — ${scenario.title}`);
  console.log(`invariant: ${scenario.invariant}`);
  const columns = [...new Set(scenario.rows.flatMap((row) => Object.keys(row)))];
  const widths = columns.map((column) =>
    Math.max(column.length, ...scenario.rows.map((row) => String(row[column] ?? "-").length)),
  );
  console.log(columns.map((column, i) => column.padEnd(widths[i])).join("  "));
  for (const row of scenario.rows) {
    if (!row.ok) failed += 1;
    console.log(
      columns.map((column, i) => String(row[column] ?? "-").padEnd(widths[i])).join("  ") +
        (row.ok ? "" : "   <-- violates the invariant"),
    );
  }
}

console.log("\npost-surface nudges");
for (const nudge of nudges) {
  if (!nudge.ok) failed += 1;
  console.log(`  ${nudge.case.padEnd(20)} ${nudge.text}${nudge.ok ? "" : "   <-- too long"}`);
}

console.log(
  failed === 0 ? "\nAll rows hold." : `\n${failed} row(s) contradict the documented invariants.`,
);
process.exit(failed === 0 ? 0 : 1);
