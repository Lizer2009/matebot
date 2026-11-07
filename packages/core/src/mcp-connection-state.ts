/**
 * What a surface may claim about an MCP connection.
 *
 * The audit found a card reading `Connected` while the very next turn reported
 * `Invalid or revoked API key`. Both were true about different things: approving a
 * server records that the user allowed it, while health records whether touching it
 * last time worked. Collapsing those into one word told the user a broken
 * connection was fine.
 *
 * This is the single place that decides, so a chat card and the settings screen
 * cannot disagree about the same server.
 */

export type McpConnectionHealth =
  | "unknown"
  | "installing"
  | "ok"
  | "error"
  /** The user has not approved the server yet. */
  | "pending"
  /** The user dismissed the request. */
  | "dismissed";

export type McpConnectionState =
  /** Approved and the last discovery succeeded. */
  | "connected"
  /** Approved, but the last attempt failed; `detail` says why. */
  | "needs_attention"
  /** Approved, but nothing has tried to reach it yet. */
  | "not_checked"
  /** A stdio package is still being prepared. */
  | "preparing"
  | "pending"
  | "dismissed";

export type McpConnectionVerdict = {
  state: McpConnectionState;
  /** The server's own failure reason, when there is one. Never invented. */
  detail?: string;
  /**
   * True only for `connected`. Anything a surface uses to say "you are set up"
   * must check this, not the approval status.
   */
  working: boolean;
};

/**
 * Decide what to show for one server.
 *
 * `approved` is the approval record; `health` is the last discovery outcome.
 * Approval alone never yields `connected` — that needed a successful reach.
 */
export function mcpConnectionVerdict(input: {
  approved: boolean;
  dismissed?: boolean;
  health?: { status: McpConnectionHealth; message?: string | null } | null;
}): McpConnectionVerdict {
  if (input.dismissed) return { state: "dismissed", working: false };
  if (!input.approved) return { state: "pending", working: false };

  const status = input.health?.status ?? "unknown";
  const detail = input.health?.message?.trim() || undefined;

  switch (status) {
    case "ok":
      return { state: "connected", working: true };
    case "error":
      return {
        state: "needs_attention",
        working: false,
        ...(detail ? { detail } : {}),
      };
    case "installing":
      return { state: "preparing", working: false };
    case "pending":
      return { state: "pending", working: false };
    case "dismissed":
      return { state: "dismissed", working: false };
    case "unknown":
    default:
      // Approved but never reached. Saying "connected" here is the exact bug the
      // audit found, so it stays unclaimed until a discovery says otherwise.
      return { state: "not_checked", working: false };
  }
}
