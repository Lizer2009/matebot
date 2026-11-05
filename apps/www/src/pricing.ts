import type { SandboxKind } from "@matebot/contracts";
import { SELF_HOST_GUIDE_PATH, SITE_URL } from "./site";

export type PricingPlan = {
  name: string;
  price: string;
  note?: string;
  features: string[];
  action: { label: string; href: string };
};

/** Display names for every sandbox a self-hosted deployment can use; typed so a new kind must be named. */
const SANDBOX_NAMES: Record<Exclude<SandboxKind, "none" | "desktop" | "fake">, string> = {
  docker: "Docker",
  kubernetes: "Kubernetes",
  incus: "Incus",
  boat: "Boat",
  boxd: "Boxd",
  createos: "CreateOS",
  daytona: "Daytona",
  e2b: "E2B",
  novita: "Novita",
  railway: "Railway",
  wuying: "Wuying",
};
const SANDBOX_PROVIDERS = Object.values(SANDBOX_NAMES);

/**
 * Pricing for this fork.
 *
 * Matebot is self-hosted here, so the site advertises no hosting plans or credits.
 * The app still builds the hosted plans upstream sells from the shared billing
 * constants in `@matebot/contracts`; this page only describes what you get by
 * running Matebot yourself.
 */
export const PRICING_PLANS: PricingPlan[] = [
  {
    name: "Self-hosted",
    price: "Free",
    features: [
      "Open source, Apache-2.0",
      "Your server or your own computer",
      "Bot computers in Docker or a sandbox",
      "Any model you connect",
      "No seat fees or usage metering",
    ],
    action: { label: "Self-hosting guide", href: SELF_HOST_GUIDE_PATH },
  },
];

/** A comparison cell: included, not included, or a short value with optional detail on hover. */
export type PricingCell = boolean | string | { label: string; detail: string };

export const PRICING_COMPARISON = {
  columns: [{ name: "Self-hosted", price: "Free" }],
  /** What a self-hosted deployment gives you, in the order someone evaluating it asks. */
  rows: [
    {
      feature: "Any model",
      cells: [{ label: "Any provider", detail: "Claude, ChatGPT, OpenRouter, Grok, or a local server" }],
    },
    {
      feature: "Sandbox",
      cells: [
        {
          label: `Your computer or any of ${SANDBOX_PROVIDERS.length}`,
          detail: `Your own computer through the desktop app, or ${SANDBOX_PROVIDERS.join(", ")}`,
        },
      ],
    },
    { feature: "Model usage", cells: ["Your own key or subscription"] },
    { feature: "Integrations and MCP", cells: ["Included"] },
    {
      feature: "Computer hours",
      hint: "Bounded only by the machine or provider you run.",
      cells: ["Unlimited"],
    },
    { feature: "Open source", cells: ["Apache-2.0"] },
  ] satisfies { feature: string; hint?: string; cells: PricingCell[] }[],
};

function markdownCell(cell: PricingCell) {
  if (cell === true) return "Yes";
  if (cell === false) return "—";
  return typeof cell === "string" ? cell.replaceAll("\n", ", ") : `${cell.label} (${cell.detail})`;
}

function planMarkdown(plan: PricingPlan) {
  return `## ${plan.name}

${plan.price}${plan.note ? ` (${plan.note})` : ""}

${plan.features.map((feature) => `- ${feature}`).join("\n")}

[${plan.action.label}](${new URL(plan.action.href, SITE_URL).href})`;
}

export const PRICING_MARKDOWN = `# Matebot pricing

${PRICING_PLANS.map(planMarkdown).join("\n\n")}

## Compare plans

| | ${PRICING_COMPARISON.columns.map((column) => `${column.name} (${column.price})`).join(" | ")} |
| --- | ${PRICING_COMPARISON.columns.map(() => "---").join(" | ")} |
${PRICING_COMPARISON.rows.map((row) => `| ${"hint" in row ? `${row.feature} (${row.hint})` : row.feature} | ${row.cells.map(markdownCell).join(" | ")} |`).join("\n")}
`;
