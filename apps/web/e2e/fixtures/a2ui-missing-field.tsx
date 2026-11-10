import { I18nProvider } from "@lingui/react";
import type { InteractionPlan } from "@matebot/contracts";
import { createRoot } from "react-dom/client";
import { compileInteractionPlan } from "../../../../packages/a2ui-adapter/src/compile";
import { interactionCapabilityForIntent } from "../../../../packages/core/src/interaction-capability";
import { A2uiSurfaceCard } from "../../src/components/a2ui/A2uiSurfaceCard";
import { A2UI_STORAGE_KEY } from "../../src/lib/feature-flags";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";

/**
 * A real email draft card compiled from a plan whose body is still empty.
 *
 * The document is produced by the production compiler with the registered email schema, not
 * hand-written, so what renders here is what the server would have published. The case is the
 * one the field audit found: a card that used to collapse to a title and three text nodes, and
 * that now has to show its fields so they can be filled in, with Send held back until it can
 * actually run.
 *
 * `?body=filled` supplies a body.
 */
const params = new URLSearchParams(location.search);
const filled = params.get("body") === "filled";

localStorage.setItem(A2UI_STORAGE_KEY, "1");

const plan: InteractionPlan = {
  intent: "email.compose",
  title: "冬天的问候",
  fields: [
    { name: "to", value: "alex@example.test", required: true, status: "resolved" },
    { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
    filled
      ? { name: "body", value: "愿这个冬天顺遂。", required: true, status: "resolved" }
      : { name: "body", required: true, status: "missing" },
  ],
  nextStep: "render",
  riskLevel: "medium",
};

const schema = interactionCapabilityForIntent("email.compose")!.schema;

void compileInteractionPlan({ plan, surfaceId: "fixture-missing-field", schema }).then(
  async (compiled) => {
    await bootstrapI18n("en");
    const root = createRoot(document.getElementById("root")!);
    if (!compiled.ok) {
      root.render(
        <I18nProvider i18n={i18n}>
          <main className="p-6 text-foreground" data-testid="fixture-compile-error">
            compile failed: {compiled.error}
          </main>
        </I18nProvider>,
      );
      return;
    }
    root.render(
      <I18nProvider i18n={i18n}>
        <main className="flex min-h-dvh flex-col bg-background text-foreground">
          <div className="mx-auto w-full max-w-2xl p-4">
            <div data-testid="fixture-missing-required" className="mb-2 text-sm">
              {compiled.missingRequired.join(",") || "none"}
            </div>
            <A2uiSurfaceCard
              block={
                {
                  kind: "a2ui_surface",
                  interactionId: "ix-fixture",
                  surfaceId: "fixture-missing-field",
                  protocolFamily: "v0_9",
                  draftVersion: 1,
                  intent: "email.compose",
                  title: plan.title,
                  template: "email-draft-card",
                  lifecycle: "draft",
                  capability: "ready",
                  senderLabel: params.get("sender") ?? "Gmail · alex@example.test",
                } as never
              }
              messages={compiled.messages as never}
              onAction={() => undefined}
              onFieldChange={() => undefined}
              onConfirm={async () => undefined}
              onSend={async () => undefined}
              onDiscard={() => undefined}
            />
          </div>
        </main>
      </I18nProvider>,
    );
  },
);
