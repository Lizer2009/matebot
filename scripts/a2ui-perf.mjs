#!/usr/bin/env node
/**
 * A reproducible measurement of the numbers the spec asks about (§9.6).
 *
 * This is deliberately narrow. It measures the server's own work on an A2UI turn
 * — validating a decision, compiling a surface, bounding a result, aggregating
 * rows — and reports the p95 over many iterations. It does not measure the model
 * or the network, because those would dominate and would make the number a
 * property of the provider rather than of this code.
 *
 *   node scripts/a2ui-perf.mjs                 # default 2000 iterations
 *   node scripts/a2ui-perf.mjs --runs 5000
 *   node scripts/a2ui-perf.mjs --json
 *
 * Exits nonzero when the server-side p95 for first feedback exceeds the budget,
 * so a regression fails a check rather than being discovered in production.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TSX = join(root, "node_modules/.bin/tsx");
if (!existsSync(TSX)) {
  console.error("Cannot find tsx. Run this from a full checkout after pnpm install.");
  process.exit(2);
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const runsIndex = args.indexOf("--runs");
const runs = runsIndex >= 0 ? Number(args[runsIndex + 1]) : 2000;
if (!Number.isInteger(runs) || runs <= 0) {
  console.error("--runs must be a positive integer");
  process.exit(2);
}

/**
 * The server-side budget for "first feedback" work on one turn. The spec's target
 * is 1s end to end excluding model and network, which leaves this much room for
 * everything that is ours.
 */
const BUDGET_MS = 50;

const child = `
import { performance } from "node:perf_hooks";
import {
  aggregateResultRows,
  buildResultSurface,
  percentile95,
  timingReport,
  validateDecisionForCapability,
} from "${join(root, "packages/core/src/index.ts")}";
import { compileInteractionPlan } from "${join(root, "packages/a2ui-adapter/src/index.ts")}";

const runs = ${runs};

const plan = {
  intent: "email.compose",
  title: "Email",
  fields: [
    { name: "to", value: "a@example.com", required: true, status: "resolved" },
    { name: "subject", value: "Hello", required: true, status: "resolved" },
    { name: "body", value: "Body text", required: true, status: "resolved" },
  ],
  nextStep: "render",
  riskLevel: "medium",
};

const decision = {
  taskIdentity: "task-1",
  capabilityCandidates: ["email.compose"],
  missingFields: [],
  presentationChoice: "form",
  version: 1,
};

const rows = Array.from({ length: 200 }, (_, index) => ({
  quarter: "Q" + ((index % 4) + 1),
  amount: 100 + index,
}));

async function measure(label, work) {
  // Warm up first: the first call pays for module loading and JIT, which is not
  // the cost of a turn in a running server and would otherwise dominate the max.
  for (let index = 0; index < Math.min(50, runs); index += 1) await work();
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await work();
    samples.push(performance.now() - started);
  }
  return { label, ...timingReport(samples) };
}

async function main() {
const results = [];
results.push(
  await measure("decision-validation", async () => {
    validateDecisionForCapability(decision);
  }),
);
results.push(
  await measure("compile-surface", async () => {
    const compiled = await compileInteractionPlan({ plan, surfaceId: "surface-perf", protocolFamily: "v0_9" });
    if (!compiled.ok) throw new Error(compiled.error);
  }),
);
results.push(
  await measure("build-result-200-rows", async () => {
    const built = buildResultSurface({
      title: "Perf",
      provenance: { source: "perf", asOf: new Date().toISOString() },
      rows,
    });
    if (!built.ok) throw new Error(built.error);
  }),
);
results.push(
  await measure("aggregate-200-rows", async () => {
    const aggregated = aggregateResultRows(
      { rows },
      { groupBy: "quarter", metrics: [{ key: "total", op: "sum", of: "amount" }] },
    );
    if (!aggregated.ok) throw new Error(aggregated.error);
  }),
);
results.push(
  await measure("turn-server-work", async () => {
    const verdict = validateDecisionForCapability(decision);
    if (!verdict.ok) throw new Error(verdict.error);
    const compiled = await compileInteractionPlan({ plan, surfaceId: "surface-perf", protocolFamily: "v0_9" });
    if (!compiled.ok) throw new Error(compiled.error);
  }),
);

const turn = results.find((entry) => entry.label === "turn-server-work");
process.stdout.write(
  JSON.stringify(
    {
      runs,
      budgetMs: ${BUDGET_MS},
      turnP95: turn?.p95 ?? null,
      withinBudget: (turn?.p95 ?? Number.POSITIVE_INFINITY) <= ${BUDGET_MS},
      results,
    },
    null,
    2,
  ),
);
}

void main();
`;

const childResult = spawnSync(TSX, ["--eval", child], { cwd: root, encoding: "utf8" });
if (childResult.status !== 0) {
  process.stderr.write(childResult.stderr || childResult.stdout || "measurement failed\n");
  process.exit(childResult.status ?? 1);
}

const report = JSON.parse(childResult.stdout);

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`A2UI server-side timings (${report.runs} runs each, ms)`);
  console.log("");
  console.log("  workload                 p50      p95      max");
  for (const entry of report.results) {
    const fmt = (value) => (value === null ? "-" : value.toFixed(3)).padStart(7);
    console.log(
      `  ${entry.label.padEnd(22)} ${fmt(entry.p50)} ${fmt(entry.p95)} ${fmt(entry.max)}`,
    );
  }
  console.log("");
  console.log(
    `  turn server work p95: ${report.turnP95?.toFixed(3)} ms (budget ${report.budgetMs} ms)`,
  );
  console.log("");
  console.log(
    "  Excluded on purpose: model latency and network. This measures only the work",
  );
  console.log("  this repository does, so the number is reproducible on any machine.");
}

if (!report.withinBudget) {
  console.error(`\nFAIL: turn server work p95 exceeded the ${report.budgetMs} ms budget.`);
  process.exit(1);
}
