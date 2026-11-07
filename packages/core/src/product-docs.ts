/**
 * The product's own documentation index, as the help skill needs it.
 *
 * Two things were wrong with the old list. It named another product's host, so a
 * fork answering "how do I connect an MCP server" sent the model to a site that
 * describes a different build; and it was written by hand, so nothing tied it to
 * the pages that actually ship. Both are fixed here: the topics come from the same
 * slug list the site builds from, and the origin comes from deployment
 * configuration rather than a literal.
 *
 * The paths are a closed set. The skill may fetch one of these and nothing else,
 * so a model cannot construct a neighbouring URL and get a 404 — or worse, land on
 * a page that looks authoritative and is not.
 */

/** One documentation page: what it covers, and its path relative to the docs root. */
export type DocumentationPage = {
  /** Shown to the model so it can pick the closest page for a question. */
  topics: string;
  /** Slug as it appears in `docs/<slug>.md`; the first page is the docs root. */
  slug: string;
};

/**
 * The pages this build ships, in the order a reader meets them.
 *
 * Kept in step with `docs/*.md` and the site's own navigation by
 * `product-docs.test.ts`, which fails when a slug has no file. Anything an answer
 * needs that is not on this list must be answered from the fallback text below or
 * declined, not invented.
 */
export const PRODUCT_DOCUMENTATION: readonly DocumentationPage[] = [
  { topics: "Getting started, first bot, what the product does", slug: "getting-started" },
  { topics: "Creating bots, chatting, bot settings, sidebar, search", slug: "bots-and-chats" },
  { topics: "Importing an external agent", slug: "import-an-agent" },
  {
    topics: "Connecting apps, MCP servers and tools, including Cursor cloud agents",
    slug: "integrations",
  },
  { topics: "Slack, Telegram, WhatsApp and other chat apps", slug: "messaging-apps" },
  { topics: "Routines, schedules and triggers", slug: "routines" },
  { topics: "The bot's computer, files, using your own computer", slug: "computer" },
  { topics: "Memory", slug: "memory" },
  { topics: "Skills", slug: "skills" },
  { topics: "Approvals, Allow and Block lists", slug: "approvals" },
  { topics: "Group chats, bots working together, subagents", slug: "groups" },
  { topics: "Voice, calls, spoken replies", slug: "voice-and-calls" },
  { topics: "Models, providers, API keys, fallbacks, usage", slug: "models" },
  { topics: "Spaces", slug: "spaces" },
  { topics: "Saved credentials and website logins", slug: "bot-secrets" },
  { topics: "Account, preferences, data export, credits, plans, billing", slug: "account" },
  { topics: "Desktop app", slug: "desktop-app" },
  { topics: "Mobile app", slug: "mobile-app" },
  { topics: "Bots that create and manage bots", slug: "fleet-management" },
  { topics: "Building a plugin", slug: "build-a-plugin" },
  { topics: "Self-hosting overview", slug: "self-host" },
  { topics: "Self-hosted server configuration", slug: "self-host-configuration" },
];

/** Where the site publishes docs, relative to its origin. One definition, not two. */
export const DOCS_ROOT_PATH = "/docs/";

/**
 * The absolute URL of a page, or the docs root for the first page.
 *
 * `origin` is the deployment's own marketing origin. A trailing slash is tolerated
 * because an operator writing the value by hand may include one.
 */
export function documentationUrl(origin: string, slug: string): string {
  const base = origin.replace(/\/+$/, "");
  return slug === PRODUCT_DOCUMENTATION[0]!.slug
    ? `${base}${DOCS_ROOT_PATH}`
    : `${base}${DOCS_ROOT_PATH}${slug}/`;
}

/**
 * The same answer, without a network read.
 *
 * The skill tells the model to fetch the matching page first. When that read is
 * unavailable — offline, refused by the egress policy, or the page is gone — the
 * model must still be able to answer the questions this build actually supports,
 * or say plainly that it cannot. This text is that floor: it is short, it is
 * about this product, and it names no vendor-specific step that could be wrong for
 * a different deployment.
 */
export const PRODUCT_DOCS_FALLBACK = [
  "Connecting an app or MCP server: open Integrations, choose the app or add your server URL, then",
  "pick an authentication method (none, bearer token, or API key header) and verify. The credential is",
  "encrypted and never sent to the model.",
  "",
  "A bot asks before it uses a server it has not used yet; approve it in the chat, or authorize if the",
  "server needs you to sign in. One run reuses one session per server, so a paused step can be resumed",
  "while that run is still going.",
  "",
  "Cursor cloud agents are connected the same way, from Integrations. They run in their own cloud and",
  "bill to that account; nothing runs on this computer. After connecting, a bot can launch a task,",
  "check its status, add instructions, or cancel the run.",
  "",
  "Self-hosted deployments can serve their own app catalog; if the integration you want is not listed,",
  "add it by URL or ask the operator to configure the catalog.",
].join("\n");
