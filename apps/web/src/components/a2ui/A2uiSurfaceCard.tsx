import { Trans } from "@lingui/react/macro";
import type { A2uiSurfaceBlock } from "@matebot/contracts";
import { needsRecovery } from "@matebot/core";
import { Button } from "@matebot/ui-web";
import { A2uiSurfaceHost } from "./A2uiSurfaceHost";
import { EmailComposeEditor } from "./EmailComposeEditor";
import type { EmailFieldName } from "./email-fields";
import { emailFieldsFromSurfaceMessages, isEmailComposeIntent } from "./email-fields";
import type { A2uiActionListener } from "./load-a2ui";
import { useA2uiSurfaceDocument } from "./use-a2ui-surface-document";

/**
 * Timeline card for `MessageBlock.kind === "a2ui_surface"`.
 * Sibling to page-kit (`kind: page`) — never merged.
 *
 * Hydrates from fixture documentRef, explicit messages, or server fetch (PR-4).
 */
export function A2uiSurfaceCard({
  block,
  superseded = false,
  messages,
  fetchDocument,
  onFieldChange,
  onConfirm,
  onSend,
  onConnect,
  onCheckStatus,
  onAction,
  onDiscard,
  onManageRules,
}: {
  block: A2uiSurfaceBlock;
  /**
   * A later draft in this thread corrects this one. Its buttons must not act: two live cards for
   * the same event let a user create it twice, and the older card's button looked identical.
   */
  superseded?: boolean;
  /** Optional protocol messages; fixture documentRef fills this when omitted. */
  messages?: unknown[];
  /** Load a persisted documentRef from the API when not a fixture. */
  fetchDocument?: (documentRef: string) => Promise<unknown[] | undefined>;
  onFieldChange?: (
    name: EmailFieldName,
    value: string,
    expectedDraftVersion: number,
  ) => Promise<{ draftVersion: number } | undefined>;
  onConfirm?: (draftVersion: number) => Promise<void>;
  onSend?: (draftVersion: number) => Promise<void>;
  onConnect?: () => Promise<void>;
  onCheckStatus?: () => Promise<void>;
  /** The one bridge for a compiled surface's buttons. */
  onAction?: A2uiActionListener;
  onDiscard?: () => void | Promise<void>;
  onManageRules?: () => void;
}) {
  const document = useA2uiSurfaceDocument({
    documentRef: block.documentRef,
    // A republish keeps the ref and moves the revision, so the revision is what
    // tells this card its content changed.
    revision: block.draftVersion,
    messages,
    fetchDocument,
  });
  const title = block.title?.trim() || "Surface";
  const summary = block.summary?.trim();
  const emailCompose = isEmailComposeIntent(block.intent);

  if (block.protocolFamily !== "v0_9") {
    return (
      <div
        data-testid="a2ui-surface-card"
        data-protocol={block.protocolFamily}
        className="w-full max-w-[561px] rounded-[20px] border border-border bg-muted px-5 py-4 text-[14px] text-muted-foreground"
      >
        Protocol {block.protocolFamily} is not rendered by this host
      </div>
    );
  }

  return (
    <div
      data-testid="a2ui-surface-card"
      data-surface-id={block.surfaceId}
      data-interaction-id={block.interactionId}
      data-draft-version={block.draftVersion}
      className="w-full max-w-[561px] overflow-hidden rounded-[20px] bg-card ring-[0.5px] ring-border pointer-coarse:min-[900px]:max-w-[639px]"
    >
      {emailCompose ? null : (
        <div className="border-b border-border/60 px-5 py-3">
          <div className="truncate text-[15px] font-medium leading-[21px] text-foreground">
            {title}
          </div>
          {summary ? (
            <div className="mt-0.5 truncate text-[14px] leading-[20px] text-muted-foreground">
              {summary}
            </div>
          ) : null}
        </div>
      )}
      {superseded ? (
        <div
          data-testid="a2ui-surface-superseded"
          className="px-5 py-4 text-[14px] leading-[20px] text-muted-foreground"
        >
          <Trans>Replaced by a newer draft below.</Trans>
        </div>
      ) : (
        <div className="px-5 py-4">
          {emailCompose ? (
            <EmailComposeEditor
              draftVersion={block.draftVersion}
              confirmedVersion={block.confirmedVersion}
              capability={block.capability}
              template={block.template}
              lifecycle={block.lifecycle}
              error={block.error}
              fields={emailFieldsFromSurfaceMessages(document.messages)}
              {...(block.senderLabel ? { senderLabel: block.senderLabel } : {})}
              {...(block.senderAddress ? { senderAddress: block.senderAddress } : {})}
              onFieldChange={onFieldChange}
              onConfirm={onConfirm}
              onSend={onSend}
              onConnect={onConnect}
              onCheckStatus={onCheckStatus}
              onDiscard={onDiscard}
              onManageRules={onManageRules}
            />
          ) : document.messages ? (
            <>
              <A2uiSurfaceHost
                surfaceId={block.surfaceId}
                messages={document.messages}
                onAction={onAction}
              />
              {/*
              An early card stored a title and two lines of text, and nothing to press.
              The turn around it may still say "confirm in the card above", which nothing
              here can satisfy. It cannot grow the button that was never stored, so it
              says what is missing and offers a way forward.
            */}
              {needsRecovery(document.messages, { intent: block.intent }) ? (
                <div
                  data-testid="a2ui-surface-recovery"
                  className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3 text-[14px] text-muted-foreground"
                >
                  <span>
                    <Trans>
                      This is an older card: it was saved before cards could be edited, so it has
                      nothing to fill in or confirm.
                    </Trans>
                  </span>
                  <span>
                    <Trans>Ask for the draft again to get an editable card.</Trans>
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            /**
             * Never a blank region. A published card whose document has not arrived,
             * or whose load failed, says so and offers a way forward; the audit found
             * an empty frame here where a calendar card should have been.
             */
            <div
              data-testid="a2ui-surface-placeholder"
              data-loading={document.loading ? "true" : "false"}
              data-error={document.error ?? undefined}
              role="status"
              aria-live="polite"
              className="flex flex-col gap-2 text-[14px] text-muted-foreground"
            >
              {document.loading ? (
                <span>
                  <Trans>Loading this card…</Trans>
                </span>
              ) : (
                <>
                  <span>
                    <Trans>This card could not be shown.</Trans>
                  </span>
                  {document.error ? (
                    <span data-testid="a2ui-surface-placeholder-reason" className="text-[13px]">
                      {document.error}
                    </span>
                  ) : null}
                  <div>
                    <Button variant="secondary" onClick={() => document.reload()}>
                      <Trans>Try again</Trans>
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
