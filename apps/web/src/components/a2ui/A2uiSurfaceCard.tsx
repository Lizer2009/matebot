import type { A2uiSurfaceBlock } from "@matebot/contracts";
import { useMemo } from "react";
import { A2uiSurfaceHost } from "./A2uiSurfaceHost";
import { resolveFixtureMessages } from "./fixtures";

/**
 * Timeline card for `MessageBlock.kind === "a2ui_surface"`.
 * Sibling to page-kit (`kind: page`) — never merged.
 *
 * Without a document (PR-4 persistence) the card shows title/summary only.
 * Fixture `documentRef` values hydrate a local message list for demos.
 */
export function A2uiSurfaceCard({
  block,
  messages,
}: {
  block: A2uiSurfaceBlock;
  /** Optional protocol messages; fixture documentRef fills this when omitted. */
  messages?: unknown[];
}) {
  const document = useMemo(
    () => messages ?? resolveFixtureMessages(block.documentRef),
    [messages, block.documentRef],
  );
  const title = block.title?.trim() || "Surface";
  const summary = block.summary?.trim();

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
      <div className="px-5 py-4">
        {document ? (
          <A2uiSurfaceHost surfaceId={block.surfaceId} messages={document} />
        ) : (
          <div
            data-testid="a2ui-surface-placeholder"
            className="text-[14px] text-muted-foreground"
          />
        )}
      </div>
    </div>
  );
}
