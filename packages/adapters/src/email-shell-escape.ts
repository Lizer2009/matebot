import { isA2uiFeatureEnabled } from "./a2ui-feature.js";

/** Shown to the model when a shell command is an outbound-mail script. */
export const OUTBOUND_EMAIL_SHELL_REFUSAL =
  "Mail cannot be sent from shell. Call present_interaction with intent email.compose so the user can send from the draft.";

/**
 * High-signal outbound-mail markers only. Ordinary local compute (`python3 -c`
 * over files, `import socket`, HTTP `requests`) must keep working.
 */
const OUTBOUND_EMAIL_MARKERS = [
  /\bsmtplib\b/i,
  /\baiosmtplib\b/i,
  /\bnodemailer\b/i,
  /\bSMTP_SSL\b/,
  /\bsmtps?:\/\//i,
  /\b(?:sendmail|msmtp|swaks|mailx)\b/i,
  /\bmail\s+-s\b/i,
  /\b(?:SMTP|MAIL)_(?:HOST|PORT|USER(?:NAME)?|PASSWORD|PASS|FROM)\b/,
];

export function outboundEmailScriptRefusal(command: string): string | undefined {
  if (!command) return undefined;
  return OUTBOUND_EMAIL_MARKERS.some((pattern) => pattern.test(command))
    ? OUTBOUND_EMAIL_SHELL_REFUSAL
    : undefined;
}

type ToolOffer = {
  tools: {
    builtins?: readonly { name: string }[];
    disabled: ReadonlySet<string>;
  };
};

export function interactionDraftPathAvailable(ctx: ToolOffer, env?: NodeJS.ProcessEnv): boolean {
  if (!isA2uiFeatureEnabled(env)) return false;
  if (ctx.tools.disabled.has("present_interaction")) return false;
  return Boolean(ctx.tools.builtins?.some((tool) => tool.name === "present_interaction"));
}

/** Refuse shell/python SMTP when the interaction draft path is offered. */
export function refuseOutboundEmailShell(
  ctx: ToolOffer,
  args: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): { error: string } | undefined {
  if (!interactionDraftPathAvailable(ctx, env)) return undefined;
  const command = String(args.command ?? args.cmd ?? "");
  const error = outboundEmailScriptRefusal(command);
  return error ? { error } : undefined;
}
