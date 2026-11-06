import { waitForConnection } from "@matebot/core";

/** Featured mailbox bind. Provider id stays in the RPC payload, not in UI copy. */
export const EMAIL_MAILBOX_BEGIN = {
  connectorId: "composio",
  provider: "gmail",
  displayName: "Email",
} as const;

export async function connectEmailMailbox(input: {
  begin: (body: typeof EMAIL_MAILBOX_BEGIN) => Promise<{
    connectionId: string;
    authorizationUrl?: string | null;
  }>;
  complete: (body: { connectionId: string }) => Promise<{ status: string }>;
  openUrl?: (url: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  const started = await input.begin(EMAIL_MAILBOX_BEGIN);
  if (started.authorizationUrl) input.openUrl?.(started.authorizationUrl);
  const result = await waitForConnection(started.connectionId, input.complete, {
    signal: input.signal,
    attempts: 60,
  });
  if (result.status === "aborted") {
    const error = new Error("Authorization was cancelled");
    error.name = "AbortError";
    throw error;
  }
  if (result.status !== "connected") {
    throw new Error("Authorization timed out. Please try again.");
  }
}
