import { I18nProvider } from "@lingui/react";
import type { ThreadMessage } from "@matebot/contracts";
import { createRoot } from "react-dom/client";
import { A2uiSurfaceCard } from "../../src/components/a2ui/A2uiSurfaceCard";
import {
  fixtureA2uiSurfaceBlock,
  unknownComponentSurfaceMessages,
} from "../../src/components/a2ui/fixtures";
import { A2UI_STORAGE_KEY } from "../../src/lib/feature-flags";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";
import { FixtureTranscript } from "./thread-fixture";

/**
 * Dev / Playwright fixture for PR-3 A2UI Surface host.
 *
 * Open: `/e2e/fixtures/a2ui-surface.html`
 * - default: timeline card with minimal v0.9 surface (flag on via localStorage)
 * - `?refuse=1`: also shows a host fed unknown-component messages (refuse-safe)
 * - `?flag=off`: clears the flag so MessageView hides `a2ui_surface` blocks
 */

const params = new URLSearchParams(location.search);
const refuse = params.get("refuse") === "1";

if (params.get("flag") !== "off") {
  localStorage.setItem(A2UI_STORAGE_KEY, "1");
} else {
  localStorage.removeItem(A2UI_STORAGE_KEY);
}

const surfaceBlock = fixtureA2uiSurfaceBlock();

const messages: ThreadMessage[] = [
  {
    id: "message-1",
    threadId: "thread-1",
    seq: 1,
    role: "user",
    createdAt: "2026-11-06T12:00:00.000Z",
    blocks: [{ kind: "text", text: "Show me an A2UI surface fixture." }],
  },
  {
    id: "message-2",
    threadId: "thread-1",
    seq: 2,
    role: "bot",
    botId: "bot-1",
    createdAt: "2026-11-06T12:00:01.000Z",
    blocks: [surfaceBlock],
  },
];

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <FixtureTranscript messages={messages} running={false} showToolActivity={false} />
        {refuse ? (
          <div className="mx-auto w-full max-w-xl p-6">
            <A2uiSurfaceCard
              block={fixtureA2uiSurfaceBlock({
                surfaceId: "fixture-unknown",
                title: "Unknown component",
                summary: "Should refuse safely",
                documentRef: undefined,
              })}
              messages={unknownComponentSurfaceMessages()}
            />
          </div>
        ) : null}
      </div>
    </I18nProvider>,
  );
});
