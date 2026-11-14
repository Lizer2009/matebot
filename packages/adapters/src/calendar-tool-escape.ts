import { interactionDraftPathAvailable } from "./email-shell-escape.js";

/** Shown when the model tries to write the calendar itself instead of the card. */
export const DIRECT_CALENDAR_CREATE_REFUSAL =
  "Calendar events are created from the draft card. Call present_interaction with intent calendar.create and wait for the user. Do not create the events yourself.";

const CALENDAR_CREATE_TOOL = "GOOGLECALENDAR_CREATE_EVENT";

function createsCalendarEvent(name: string, args: Record<string, unknown>): boolean {
  if (name === CALENDAR_CREATE_TOOL) return true;
  if (name !== "COMPOSIO_MULTI_EXECUTE_TOOL" || !Array.isArray(args.tools)) return false;
  return args.tools.some((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as { tool_slug?: unknown }).tool_slug === CALENDAR_CREATE_TOOL;
  });
}

/** Refuse a connector create while the draft card is the path the user confirms. */
export function refuseDirectCalendarCreate(
  ctx: {
    tools: {
      builtins?: readonly { name: string }[];
      disabled: ReadonlySet<string>;
    };
  },
  name: string,
  args: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): { error: string } | undefined {
  if (!interactionDraftPathAvailable(ctx, env)) return undefined;
  return createsCalendarEvent(name, args) ? { error: DIRECT_CALENDAR_CREATE_REFUSAL } : undefined;
}
