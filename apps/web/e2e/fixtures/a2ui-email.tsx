import { I18nProvider } from "@lingui/react";
import type { ThreadMessage } from "@matebot/contracts";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { A2uiSurfaceCard } from "../../src/components/a2ui/A2uiSurfaceCard";
import type { EmailDraftFields } from "../../src/components/a2ui/email-fields";
import { fixtureA2uiSurfaceBlock } from "../../src/components/a2ui/fixtures";
import { A2UI_STORAGE_KEY } from "../../src/lib/feature-flags";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";
import { FixtureTranscript } from "./thread-fixture";

/**
 * Playwright fixture for email review-card → Send (confirm+execute) / Discard.
 *
 * Open: `/e2e/fixtures/a2ui-email.html`
 * - default: local draft that mirrors confirm-before-send on the server
 * - `?flag=off`: timeline hides the a2ui_surface block
 */

const params = new URLSearchParams(location.search);
const flagOff = params.get("flag") === "off";
const capabilityParam = params.get("capability");
const fixtureCapability =
  capabilityParam === "not_connected" ||
  capabilityParam === "requires_reauth" ||
  capabilityParam === "ready"
    ? capabilityParam
    : undefined;

if (!flagOff) {
  localStorage.setItem(A2UI_STORAGE_KEY, "1");
} else {
  localStorage.removeItem(A2UI_STORAGE_KEY);
}

const initialFields: EmailDraftFields = {
  from: "bot@example.com",
  to: "a@example.com",
  cc: "",
  subject: "Hi",
  body: "Hello",
};

function emailMessages(fields: EmailDraftFields): unknown[] {
  return [
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "fixture-minimal",
        value: {
          intent: "email.compose",
          fields: [
            { name: "from", value: fields.from },
            { name: "to", value: fields.to },
            { name: "cc", value: fields.cc },
            { name: "subject", value: fields.subject },
            { name: "body", value: fields.body },
          ],
        },
      },
    },
  ];
}

function EmailComposeFixture() {
  const [draftVersion, setDraftVersion] = useState(1);
  const [confirmedVersion, setConfirmedVersion] = useState<number | undefined>(undefined);
  const [fields, setFields] = useState(initialFields);
  const versionRef = useRef(1);
  const confirmedRef = useRef<number | undefined>(undefined);

  const block = fixtureA2uiSurfaceBlock({
    intent: "email.compose",
    documentRef: undefined,
    title: "Send email",
    summary: undefined,
    draftVersion,
    confirmedVersion,
    ...(fixtureCapability ? { capability: fixtureCapability } : {}),
  });

  return (
    <div className="mx-auto w-full max-w-xl p-6">
      <A2uiSurfaceCard
        block={block}
        messages={emailMessages(fields)}
        onFieldChange={async (name, value, expectedDraftVersion) => {
          if (expectedDraftVersion !== versionRef.current) {
            throw new Error("Draft was updated elsewhere");
          }
          versionRef.current += 1;
          confirmedRef.current = undefined;
          setFields((current) => ({ ...current, [name]: value }));
          setDraftVersion(versionRef.current);
          setConfirmedVersion(undefined);
          return { draftVersion: versionRef.current };
        }}
        onConfirm={async (version) => {
          if (version !== versionRef.current) throw new Error("Draft was updated elsewhere");
          confirmedRef.current = version;
          setConfirmedVersion(version);
        }}
        onSend={async (version) => {
          if (confirmedRef.current !== version) {
            throw new Error("Confirm this draft before sending.");
          }
        }}
        onDiscard={() => undefined}
      />
    </div>
  );
}

const hiddenMessages: ThreadMessage[] = [
  {
    id: "message-1",
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    botId: "bot-1",
    createdAt: "2026-11-06T12:00:01.000Z",
    blocks: [
      fixtureA2uiSurfaceBlock({
        intent: "email.compose",
        documentRef: undefined,
        title: "Send email",
      }),
    ],
  },
];

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        {flagOff ? (
          <FixtureTranscript messages={hiddenMessages} running={false} showToolActivity={false} />
        ) : (
          <EmailComposeFixture />
        )}
      </div>
    </I18nProvider>,
  );
});
