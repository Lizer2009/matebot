import { destinationKey, normalizeHost } from "@matebot/contracts";

/** Shown when a shell command names a destination this run's guard already refused. */
export const EGRESS_REFUSED_SHELL_MESSAGE =
  "That address was refused by the network policy in this run, so it cannot be reached from shell either. Pick a different source or ask the user.";

/**
 * Tokens in a command that can carry a host: an http(s) URL, `host:port`, or a
 * dotted name. Deliberately loose — a candidate only matters if it names a
 * destination this run already refused, so a token that is really a file name or
 * a version string simply matches nothing.
 */
const HOST_LIKE_TOKEN =
  /(?:https?:\/\/)?(?:[A-Za-z0-9._~%!$&'()*+,;=:@-]*@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+)(?::\d+)?/g;

/**
 * The first destination in `command` that this run's egress guard already refused,
 * or undefined.
 *
 * This closes the case the audit saw — a fetcher refused a host and the next tool was
 * pointed at the same place — for the one route the server can read: the command
 * text. It matches a *literal* address, so it is a barrier, not a sandbox: a command
 * that builds the address at run time (`$(printf …)`, a variable, a redirect served
 * by a public host) never names it here. The boundary that actually holds is the
 * computer's own network policy, which this check does not replace.
 */
export function refusedDestinationInCommand(
  command: string,
  refused: ReadonlySet<string> | undefined,
): string | undefined {
  if (!command || !refused || refused.size === 0) return undefined;
  const seen = new Set<string>();
  for (const [, candidate] of command.matchAll(HOST_LIKE_TOKEN)) {
    if (!candidate) continue;
    const host = normalizeHost(candidate);
    // A bare dotted word only counts when the guard actually refused that name.
    const key = destinationKey(host);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (refused.has(key)) return host;
  }
  return undefined;
}

/** Refuse a shell command that names an address this run already had refused. */
export function refuseRefusedDestinationShell(
  refused: ReadonlySet<string> | undefined,
  args: Record<string, unknown>,
): { error: string } | undefined {
  const command = String(args.command ?? args.cmd ?? "");
  return refusedDestinationInCommand(command, refused)
    ? { error: EGRESS_REFUSED_SHELL_MESSAGE }
    : undefined;
}
