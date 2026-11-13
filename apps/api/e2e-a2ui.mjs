/**
 * E2E launcher that mirrors `packages/testkit/src/cli/harness.ts --e2e` but takes
 * an already-running Postgres instead of starting a container.
 *
 * The container harness needs Docker; this environment has none. Everything else
 * is the production path: the real `createApp` (real oRPC router, real services),
 * the real Vite dev server, real Playwright against a browser, and a disposable
 * migrated database. External services are emulated at the boundary only, which
 * is exactly what the container harness does.
 *
 * Usage: node apps/api/e2e-a2ui.mjs [playwright args...]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(path.dirname(apiDir));
const require = createRequire(import.meta.url);

const apiPort = Number(process.env.API_PORT ?? 3110);
const webPort = Number(process.env.WEB_PORT ?? 5180);
const webOrigin = `http://127.0.0.1:${webPort}`;

const databaseUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? databaseUrl;
if (!databaseUrl || !migrationUrl) {
  // biome-ignore lint/suspicious/noConsole: CLI entry point reports its own usage errors.
  console.error("DATABASE_URL and DATABASE_MIGRATION_URL must point at the disposable database.");
  process.exit(2);
}

Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  DATABASE_MIGRATION_URL: migrationUrl,
  REALTIME_DATABASE_URL: databaseUrl,
  VERIFY_DATABASE: "1",
  WAKEUP_DRIVER: "memory",
  SANDBOX_PROVIDER: "fake",
  AGENT_RUNTIME: "scripted",
  MATEBOT_LIVE_MODEL_CATALOG: "off",
  TICKET_BOARD_ENABLED: "true",
  PHONE_CALLS_ENABLED: "true",
  PAYMENT_WALLET_PROVIDER: "emulator",
  CLOUD_AGENT_PROVIDER: "emulator",
  COMPOSIO_API_KEY: "",
  BETTER_AUTH_SECRET: "test-secret-test-secret-32chars!",
  ENCRYPTION_KEY: "test-encryption-key-test-encryption-key",
  SANDBOX_SUPERVISOR_TOKEN: "test-supervisor-token-test-32chars",
  SCREEN_PROXY_SECRET: "test-screen-proxy-secret-test-32chars",
  BETTER_AUTH_URL: webOrigin,
  WEB_ORIGIN: webOrigin,
  API_PORT: String(apiPort),
  API_URL: `http://127.0.0.1:${apiPort}`,
  API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
  WEB_PORT: String(webPort),
  PLAYWRIGHT_BASE_URL: webOrigin,
  DATA_DIR: path.join(root, "test-report", "e2e-a2ui", "data"),
  SIGNUPS_ENABLED: "true",
  SIGNUP_ALLOWLIST: "",
  MCP_ALLOW_PRIVATE_ENDPOINT: "true",
  MCP_STDIO_ENABLED: "true",
  MCP_STDIO_ALLOWED_COMMANDS: "echo",
  VITE_FEATURE_A2UI: "1",
  FEATURE_A2UI: "1",
  // Marks these specs as the dedicated A2UI run; the regular suite skips them.
  A2UI_LIVE_E2E: "1",
  CI: "1",
});
delete process.env.CURSOR_API_KEY;

mkdirSync(process.env.DATA_DIR, { recursive: true });

const { serve } = await import("@hono/node-server");
const adapters = await import("@matebot/adapters");
const { createApp } = await import("@matebot/api/app");

const email = new adapters.EmailEmulator();
const thirdParties = new adapters.ThirdPartyConnectorEmulator();
const { PluginMarketplaceFixture } = await import(
  path.join(root, "packages/testkit/src/plugin-marketplace-fixture.ts")
);
const marketplace = new PluginMarketplaceFixture(thirdParties.fetch);
const pipedream = new adapters.PipedreamConnector(
  {
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    projectId: "fake-project-id",
    environment: "development",
    identitySecret: process.env.ENCRYPTION_KEY,
  },
  { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
);
const { createModelConnectionFixtureFetch } = await import(
  path.join(root, "packages/testkit/src/model-connection-fixture.ts")
);

const handles = await createApp({
  databaseUrl,
  modelConnectionFetch: createModelConnectionFixtureFetch(adapters.listPiCatalog()),
  prisma: undefined,
  composio: new adapters.ComposioConnector({ client: new adapters.FakeComposioClient() }),
  connectors: [new adapters.DestinationEmulator()],
  pipedream,
  email,
  remoteConnectors: { fetch: marketplace.fetch, resolveHostname: thirdParties.resolveHostname },
  pluginRepoFetcher: marketplace.repo,
  pluginMarketplaceRead: marketplace.index,
  integrationsCatalogUrl: "https://catalog.example.test/",
  userDevices: new adapters.UserDeviceEmulator(),
});

const { seedExpiredSurface, inspectSeededSurface } = await import(
  "./src/e2e-seed-expired-surface.ts"
);
const { markAwaitingApprovalExpired, expireDueLiveInteractions } = await import(
  "./src/e2e-expire-due-interactions.ts"
);

const server = serve({
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/emails") {
      return Response.json(email.sent, { headers: { "cache-control": "no-store" } });
    }
    // Isolated Batch B seed only. Not mounted on the production app.
    if (url.pathname === "/__e2e/seed-expired-surface" && request.method === "POST") {
      try {
        const body = await request.json();
        const interactionId =
          body && typeof body === "object" && typeof body.interactionId === "string"
            ? body.interactionId
            : "";
        if (!interactionId) {
          return Response.json({ error: "interactionId required" }, { status: 400 });
        }
        return Response.json(await seedExpiredSurface(handles.prisma, interactionId), {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "seed failed" },
          { status: 400 },
        );
      }
    }
    if (url.pathname === "/__e2e/mark-awaiting-approval-expired" && request.method === "POST") {
      try {
        const body = await request.json();
        const interactionId =
          body && typeof body === "object" && typeof body.interactionId === "string"
            ? body.interactionId
            : "";
        if (!interactionId) {
          return Response.json({ error: "interactionId required" }, { status: 400 });
        }
        return Response.json(await markAwaitingApprovalExpired(handles.prisma, interactionId), {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "mark failed" },
          { status: 400 },
        );
      }
    }
    if (url.pathname === "/__e2e/expire-due-interactions" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const interactionId =
          body && typeof body === "object" && typeof body.interactionId === "string"
            ? body.interactionId
            : undefined;
        return Response.json(await expireDueLiveInteractions(handles.prisma, interactionId), {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "expire failed" },
          { status: 400 },
        );
      }
    }
    if (url.pathname === "/__e2e/inspect-surface" && request.method === "GET") {
      try {
        const interactionId = url.searchParams.get("interactionId") ?? "";
        if (!interactionId) {
          return Response.json({ error: "interactionId required" }, { status: 400 });
        }
        return Response.json(await inspectSeededSurface(handles.prisma, interactionId), {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "inspect failed" },
          { status: 400 },
        );
      }
    }
    return handles.app.fetch(request);
  },
  port: apiPort,
  hostname: "127.0.0.1",
});

for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/health`);
    if (response.ok) break;
  } catch {
    // not up yet
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

let exitCode = 1;
try {
  const { spawn } = await import("node:child_process");
  // The package's own dev script is the supported way to start Vite here.
  const dev = spawn("pnpm", ["--filter", "@matebot/web", "dev", "--port", String(webPort)], {
    cwd: root,
    env: { ...process.env, VITE_DEFAULT_UI_LOCALE: "en", VITE_FEATURE_A2UI: "1" },
    stdio: "inherit",
  });

  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(webOrigin);
      if (response.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const extra = process.argv.slice(2);
  await new Promise((resolve, reject) => {
    const run = spawn(
      "pnpm",
      ["--filter", "@matebot/web", "exec", "playwright", "test", ...extra],
      {
        cwd: root,
        // The launcher already runs Vite; let Playwright reuse it instead of
        // starting a second server on the same port.
        env: { ...process.env, CI: "1", PLAYWRIGHT_REUSE_SERVER: "1" },
        stdio: "inherit",
      },
    );
    run.on("error", reject);
    run.on("exit", (code) => {
      exitCode = code ?? 1;
      resolve();
    });
  });
  dev.kill("SIGTERM");
} catch (error) {
  // biome-ignore lint/suspicious/noConsole: CLI entry point reports the run outcome.
  console.error("E2E run failed:", error);
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  await handles.stop().catch(() => undefined);
}

process.exit(exitCode);
