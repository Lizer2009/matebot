import type { A2uiSurfaceBlock } from "@matebot/contracts";
import { A2uiSurfaceHost } from "./A2uiSurfaceHost";
import { useA2uiSurfaceDocument } from "./use-a2ui-surface-document";

/**
 * Timeline card for `MessageBlock.kind === "a2ui_surface"`.
 * Sibling to page-kit (`kind: page`) — never merged.
 *
 * Hydrates from fixture documentRef, explicit messages, or server fetch (PR-4).
 */
export function A2uiSurfaceCard({
  block,
  messages,
  fetchDocument,
}: {
  block: A2uiSurfaceBlock;
  /** Optional protocol messages; fixture documentRef fills this when omitted. */
  messages?: unknown[];
  /** Load a persisted documentRef from the API when not a fixture. */
  fetchDocument?: (documentRef: string) => Promise<unknown[] | undefined>;
}) {
  const document = useA2uiSurfaceDocument({
    documentRef: block.documentRef,
    messages,
    fetchDocument,
  });
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
        {document.messages ? (
          <A2uiSurfaceHost surfaceId={block.surfaceId} messages={document.messages} />
        ) : (
          <div
            data-testid="a2ui-surface-placeholder"
            data-loading={document.loading ? "true" : "false"}
            data-error={document.error ?? undefined}
            className="text-[14px] text-muted-foreground"
          />
        )}
      </div>
    </div>
  );
}
