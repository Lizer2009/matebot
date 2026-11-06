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
  simulateConnectionResume,
  simulateEmailSend,
  simulateEmailSurface,
  simulateSendGate,
} from ${JSON.stringify(simModule)};
import { A2UI_SURFACE_NUDGE, surfaceNudgeFor } from ${JSON.stringify(nudgeModule)};

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
      "Scenarios: connection-states, send-outcomes, unknown-reconcile, calendar-resume",
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
