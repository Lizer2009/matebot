import { destinationKey, isLoopbackHost, normalizeHost } from "@matebot/contracts";

/** Shown when a shell command names a destination this run's guard already refused. */
export const EGRESS_REFUSED_SHELL_MESSAGE =
  "That address was refused by the network policy in this run, so it cannot be reached from shell either. Pick a different source or ask the user.";

/**
 * The words in a command that could be a host: everything left after splitting on
 * shell punctuation and quoting. Deliberately loose — a candidate only matters when
 * it names a destination this run already refused, so a word that is really a file
 * name or a subcommand matches nothing.
 */
function commandTokens(command: string): string[] {
  return command.split(/[\s'"`;|&()<>{},]+/).filter(Boolean);
}

/** Strip a scheme, userinfo, path, query and a trailing port from one token. */
function hostOfToken(token: string): string | undefined {
  let value = token;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme) value = value.slice(scheme[0].length);
  value = value.split(/[/?#]/)[0] ?? "";
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);
  if (!value) return undefined;
  if (value.startsWith("[")) {
    // A bracketed IPv6 address: keep what is inside the brackets, drop the port.
    const close = value.indexOf("]");
    value = close > 0 ? value.slice(1, close) : value.slice(1);
  } else {
    const first = value.indexOf(":");
    const last = value.lastIndexOf(":");
    // One colon means a port; several mean an unbracketed IPv6 address, which has
    // no port to strip.
    if (first >= 0 && first === last) value = value.slice(0, first);
  }
  const host = normalizeHost(value);
  return host || undefined;
}

/**
 * The keys one spelling of a host stands for.
 *
 * A shell command can write the same place several ways, and only one of them is
 * the canonical form the ledger stores: `127.1` and `2130706433` both reach
 * `127.0.0.1`, and `localhost` and `[::1]` are the same machine. Whatever a real
 * client normalises, this normalises too, or the check is bypassable by spelling.
 * Name resolution is deliberately not consulted — a name is compared as written.
 */
function keysForHost(host: string): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const key = destinationKey(normalizeHost(value));
    if (key) keys.add(key);
  };
  add(host);
  // The URL parser is the normaliser every HTTP client uses, so a form it rewrites
  // (a short IPv4, a single integer, a compressed IPv6) is compared as the address
  // the request would actually reach.
  for (const candidate of [`http://${host}`, `http://[${host}]`]) {
    try {
      add(new URL(candidate).hostname);
    } catch {
      // Not a URL-shaped host; the written form above stands.
    }
  }
  return keys;
}

/** Every key in the ledger that stands for this machine, computed once per call. */
function loopbackKeys(refused: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const entry of refused) if (isLoopbackHost(entry)) keys.add(entry);
  return keys;
}

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
  const loopback = loopbackKeys(refused);
  const seen = new Set<string>();
  for (const token of commandTokens(command)) {
    const host = hostOfToken(token);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    for (const key of keysForHost(host)) {
      if (refused.has(key)) return host;
    }
    // `localhost`, `127.1` and `[::1]` are the same machine as a refused `127.0.0.1`.
    if (isLoopbackHost(host) && loopback.size > 0) return host;
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
