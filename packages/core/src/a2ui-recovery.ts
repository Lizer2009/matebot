import type { A2uiSurfaceBlock, MessageBlock } from "@matebot/contracts";

/** Server row used to correct a timeline block after a snapshot or replay. */
export type A2uiSurfaceAuthority = {
  interactionId: string;
  surfaceId: string;
  draftVersion: number;
  /** Null means this draft is not confirmed. */
  confirmedVersion: number | null;
  intent?: string;
  title?: string | null;
  summary?: string | null;
  documentRef?: string;
  protocolFamily?: A2uiSurfaceBlock["protocolFamily"];
};

function isSurfaceBlock(block: MessageBlock): block is A2uiSurfaceBlock {
  return block.kind === "a2ui_surface";
}

function withoutConfirmation(block: A2uiSurfaceBlock): A2uiSurfaceBlock {
  if (block.confirmedVersion === undefined) return block;
  const next = { ...block };
  delete next.confirmedVersion;
  return next;
}

/**
 * Keep the newer draft. At the same version, an update that omits
 * confirmedVersion keeps the confirmation already on the timeline.
 * Pass null to clear that confirmation on purpose.
 */
export function preferA2uiSurfaceBlock(
  current: A2uiSurfaceBlock,
  incoming: A2uiSurfaceBlock,
  confirmedVersion?: number | null,
): A2uiSurfaceBlock {
  if (incoming.draftVersion < current.draftVersion) return current;
  if (incoming.draftVersion > current.draftVersion) return incoming;
  const nextConfirmed =
    confirmedVersion === undefined
      ? (incoming.confirmedVersion ?? current.confirmedVersion)
      : confirmedVersion === null
        ? undefined
        : confirmedVersion;
  const merged: A2uiSurfaceBlock = { ...current, ...incoming };
  if (nextConfirmed === undefined) return withoutConfirmation(merged);
  return { ...merged, confirmedVersion: nextConfirmed };
}

/** Keep a newer surface already on screen when a snapshot replaces the message list. */
export function mergeA2uiMessages<T extends { id: string; blocks: MessageBlock[] }>(
  previous: readonly T[],
  next: readonly T[],
): T[] {
  const previousById = new Map(previous.map((message) => [message.id, message]));
  return next.map((message) => {
    const prior = previousById.get(message.id);
    if (!prior?.blocks.some(isSurfaceBlock)) return message;
    return { ...message, blocks: mergeA2uiMessageBlocks(prior.blocks, message.blocks) };
  });
}

/** Merge a message.updated block list without letting an older surface win. */
export function mergeA2uiMessageBlocks(
  current: readonly MessageBlock[],
  incoming: readonly MessageBlock[],
): MessageBlock[] {
  const currentSurfaces = new Map<string, A2uiSurfaceBlock>();
  for (const block of current) {
    if (isSurfaceBlock(block))
      currentSurfaces.set(`${block.interactionId}:${block.surfaceId}`, block);
  }
  const seen = new Set<string>();
  const merged = incoming.map((block) => {
    if (!isSurfaceBlock(block)) return block;
    const key = `${block.interactionId}:${block.surfaceId}`;
    seen.add(key);
    const previous = currentSurfaces.get(key);
    return previous ? preferA2uiSurfaceBlock(previous, block) : block;
  });
  for (const [key, block] of currentSurfaces) {
    if (!seen.has(key)) merged.push(block);
  }
  return merged;
}

export function a2uiSurfaceBlockFromPayload(
  payload: Record<string, unknown>,
): A2uiSurfaceBlock | null {
  const interactionId = typeof payload.interactionId === "string" ? payload.interactionId : null;
  const surfaceId = typeof payload.surfaceId === "string" ? payload.surfaceId : null;
  const protocolFamily =
    payload.protocolFamily === "v0_9" || payload.protocolFamily === "v1_0"
      ? payload.protocolFamily
      : null;
  const draftVersion =
    typeof payload.draftVersion === "number" && Number.isInteger(payload.draftVersion)
      ? payload.draftVersion
      : null;
  if (!interactionId || !surfaceId || !protocolFamily || !draftVersion || draftVersion < 1) {
    return null;
  }
  return {
    kind: "a2ui_surface",
    interactionId,
    surfaceId,
    protocolFamily,
    draftVersion,
    ...(typeof payload.intent === "string" && payload.intent.trim()
      ? { intent: payload.intent.trim() }
      : {}),
    ...(typeof payload.title === "string" ? { title: payload.title } : {}),
    ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
    ...(typeof payload.documentRef === "string" ? { documentRef: payload.documentRef } : {}),
    ...(typeof payload.confirmedVersion === "number" &&
    Number.isInteger(payload.confirmedVersion) &&
    payload.confirmedVersion >= 1
      ? { confirmedVersion: payload.confirmedVersion }
      : {}),
  };
}

/**
 * Place a surface block onto the timeline. Returns placed: false when the
 * caller should append a new message.
 */
export function placeA2uiSurfaceBlock<T extends { id: string; blocks: MessageBlock[] }>(
  messages: readonly T[],
  block: A2uiSurfaceBlock,
  messageId: string | null,
): { messages: T[]; placed: boolean } {
  const next = messages.map((message) => ({ ...message, blocks: [...message.blocks] }));
  if (messageId) {
    for (const message of next) {
      if (message.id !== messageId) continue;
      let replaced = false;
      message.blocks = message.blocks.map((existing) => {
        if (existing.kind !== "a2ui_surface" || existing.surfaceId !== block.surfaceId) {
          return existing;
        }
        replaced = true;
        return preferA2uiSurfaceBlock(existing, block);
      });
      if (!replaced) message.blocks = [...message.blocks, block];
      return { messages: next, placed: true };
    }
  }
  for (const message of next) {
    const index = message.blocks.findIndex(
      (existing) =>
        existing.kind === "a2ui_surface" &&
        existing.interactionId === block.interactionId &&
        existing.surfaceId === block.surfaceId,
    );
    if (index < 0) continue;
    const existing = message.blocks[index];
    if (existing?.kind !== "a2ui_surface") continue;
    const blocks = [...message.blocks];
    blocks[index] = preferA2uiSurfaceBlock(existing, block);
    message.blocks = blocks;
    return { messages: next, placed: true };
  }
  return { messages: next, placed: false };
}

/** Correct timeline blocks from Interaction rows. No-ops when there is nothing to apply. */
export function overlayAuthoritativeA2uiBlocks<T extends { blocks: MessageBlock[] }>(
  messages: readonly T[],
  authorities: readonly A2uiSurfaceAuthority[],
): T[] {
  if (authorities.length === 0) return [...messages];
  if (!messages.some((message) => message.blocks.some(isSurfaceBlock))) return [...messages];
  const byKey = new Map(
    authorities.map((authority) => [
      `${authority.interactionId}:${authority.surfaceId}`,
      authority,
    ]),
  );
  return messages.map((message) => {
    let changed = false;
    const blocks = message.blocks.map((block) => {
      if (!isSurfaceBlock(block)) return block;
      const authority = byKey.get(`${block.interactionId}:${block.surfaceId}`);
      if (!authority || authority.draftVersion < block.draftVersion) return block;
      const draftVersion = Math.max(block.draftVersion, authority.draftVersion);
      const confirmed =
        authority.confirmedVersion != null && authority.confirmedVersion === draftVersion
          ? authority.confirmedVersion
          : null;
      const incoming: A2uiSurfaceBlock = {
        ...block,
        draftVersion,
        ...(authority.protocolFamily ? { protocolFamily: authority.protocolFamily } : {}),
        ...(authority.intent ? { intent: authority.intent } : {}),
        ...(authority.title ? { title: authority.title } : {}),
        ...(authority.summary ? { summary: authority.summary } : {}),
        ...(authority.documentRef ? { documentRef: authority.documentRef } : {}),
      };
      const next = preferA2uiSurfaceBlock(block, withoutConfirmation(incoming), confirmed);
      if (next !== block) changed = true;
      return next;
    });
    return changed ? { ...message, blocks } : message;
  });
}
