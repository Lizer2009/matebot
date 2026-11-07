import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { destinationKey, normalizeHost } from "@matebot/contracts";
import { recordSecurityEvent } from "@matebot/db";

export type ResolvedAddress = { address: string; family: number };
export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

type PinnedDns = { hostname: string; addresses: ResolvedAddress[] };

const pinnedDns = new AsyncLocalStorage<PinnedDns>();

/**
 * Destinations the egress guard refused during the current run, keyed by
 * `destinationKey` so every spelling of one place lands on one entry.
 *
 * A refusal is a statement about a destination, not about one tool. Recording it
 * here lets another network tool — the browser in particular — refuse the same
 * destination instead of completing what the guard just declined. It is scoped to
 * the async context of one run, so concurrent runs cannot see each other's
 * refusals, and nothing leaks between tenants.
 */
const refusedHosts = new AsyncLocalStorage<Set<string>>();

/**
 * Run `work` with caller-owned refusal state.
 *
 * The caller passes the same Set it reads later (for example the run's own state),
 * so a refusal recorded deep inside a fetch is visible to the next tool without
 * threading a parameter through every provider. Concurrent runs each pass their
 * own set, so one run never sees another's refusals.
 */
export async function withEgressRefusalLedger<T>(
  ledger: Set<string>,
  work: () => Promise<T>,
): Promise<T> {
  return refusedHosts.run(ledger, work);
}

/** The refusal ledger for the current run, when one is installed. */
export function currentEgressRefusals(): ReadonlySet<string> | undefined {
  return refusedHosts.getStore();
}

/**
 * Whether this run's guard already refused `hostname`, however it is spelled.
 *
 * Every tool that can reach a destination asks this rather than testing its own
 * spelling against the ledger, because a host can be written with a trailing root
 * dot, as an expanded IPv6 address, or as an IPv4-mapped form of the same place.
 */
export function egressRefusedHost(hostname: string, ledger?: ReadonlySet<string>): boolean {
  const key = destinationKey(normalizeHost(hostname));
  if (!key) return false;
  const scope = ledger ?? refusedHosts.getStore();
  return scope?.has(key) === true;
}
let dnsPinInstalled = false;

function normalizeLookupHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function familyNumber(family: unknown): number | undefined {
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;
  return typeof family === "number" ? family : undefined;
}

function lookupOptions(options: unknown): { all?: boolean; family?: number } {
  if (options == null || typeof options === "function") return {};
  if (typeof options === "number") return { family: options };
  if (typeof options === "object") {
    const record = options as { all?: boolean; family?: unknown };
    return { all: record.all, family: familyNumber(record.family) };
  }
  return {};
}

function selectLookupAddress(
  addresses: ResolvedAddress[],
  options: { all?: boolean; family?: number },
): { all: true; addresses: ResolvedAddress[] } | { all: false; address: string; family: number } {
  const requestedFamily = typeof options.family === "number" ? options.family : 0;
  const candidates = addresses.filter(
    (entry) => requestedFamily === 0 || entry.family === requestedFamily,
  );
  if (options.all) {
    if (candidates.length === 0) throw new Error("Endpoint did not resolve to an address");
    return { all: true, addresses: candidates };
  }
  const selected = candidates[0];
  if (!selected) throw new Error("Endpoint did not resolve to an address");
  return { all: false, address: selected.address, family: selected.family };
}

function deliverLookup(
  addresses: ResolvedAddress[],
  options: { all?: boolean; family?: number },
  callback: (error: Error | null, address: string | ResolvedAddress[], family?: number) => void,
): void {
  const result = selectLookupAddress(addresses, options);
  if (result.all) callback(null, result.addresses);
  else callback(null, result.address, result.family);
}

export function createAddressCheckedLookup(
  resolve: ResolveHostname,
  validate: (addresses: ResolvedAddress[], hostname: string) => void,
): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname)
      .then((addresses) => {
        try {
          validate(addresses, hostname);
        } catch (error) {
          throw egressRefused(hostname, error);
        }
        deliverLookup(addresses, lookupOptions(options), callback);
      })
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error)), "", 0),
      );
  };
}

/** A destination the egress policy refused, carrying the reason as data rather than prose. */
export class EgressRefusedError extends Error {
  readonly code = "EGRESS_REFUSED";
  /** The guard's own reason, kept structured so a classifier never has to parse prose. */
  readonly egressReason: string;
  /** The destination that was refused, for the ledger and for logs. */
  readonly host: string;

  constructor(host: string, reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "EgressRefusedError";
    this.host = host;
    this.egressReason = reason;
  }
}

/**
 * Record that an outbound-request guard refused a destination, so a probe of private addresses
 * leaves a security event. Returns the error for `throw egressRefused(...)`.
 *
 * The refusal is marked *on* the original error rather than replacing it. Callers
 * (and their tests) distinguish a refusal from another failure by class — a memory
 * provider's "private endpoint not allowed" is its own type — and wrapping would
 * erase that. The mark carries the reason as data, so a classifier reads it instead
 * of parsing a message.
 */
export function egressRefused(hostname: string, error: unknown): Error {
  const reason = (error instanceof Error ? error.message : String(error)) || "refused";
  const refusal =
    error instanceof Error ? error : new EgressRefusedError(normalizeLookupHostname(hostname), reason);
  void recordSecurityEvent({
    type: "egress.refused",
    metadata: { host: hostname.slice(0, 253), reason },
  });
  try {
    Object.defineProperties(refusal, {
      egressReason: { value: reason, configurable: true, enumerable: false },
      egressHost: {
        value: normalizeLookupHostname(hostname),
        configurable: true,
        enumerable: false,
      },
    });
  } catch {
    // A frozen error cannot carry the mark; the message still says why, and the
    // security event above is already recorded.
  }
  // Remember the destination for this run so another network tool cannot be used
  // to reach what the guard just refused, whichever way it spells the address.
  refusedHosts.getStore()?.add(destinationKey(normalizeLookupHostname(hostname)));
  return refusal;
}

function pinnedAddressesFor(hostname: string): ResolvedAddress[] | undefined {
  const pin = pinnedDns.getStore();
  if (!pin) return undefined;
  if (normalizeLookupHostname(hostname) !== normalizeLookupHostname(pin.hostname)) return undefined;
  return pin.addresses;
}

function installDnsPin(): void {
  if (dnsPinInstalled) return;
  dnsPinInstalled = true;
  const originalLookup = dns.lookup.bind(dns);
  const originalPromisesLookup = dns.promises.lookup.bind(dns.promises);

  dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    const pinned = pinnedAddressesFor(hostname);
    if (pinned && typeof cb === "function") {
      try {
        deliverLookup(
          pinned,
          lookupOptions(options),
          cb as (error: Error | null, address: string | ResolvedAddress[], family?: number) => void,
        );
      } catch (error) {
        cb(error instanceof Error ? error : new Error(String(error)), "", 0);
      }
      return;
    }
    return originalLookup(hostname, options as never, callback as never);
  }) as typeof dns.lookup;

  dns.promises.lookup = (async (hostname: string, options?: unknown) => {
    const pinned = pinnedAddressesFor(hostname);
    if (pinned) {
      const result = selectLookupAddress(pinned, lookupOptions(options));
      return result.all ? result.addresses : { address: result.address, family: result.family };
    }
    return originalPromisesLookup(hostname, options as never);
  }) as typeof dns.promises.lookup;
}

/** Pin `dns.lookup` for one hostname while `run` executes so Node's fetch can
 * keep the original URL hostname for TLS/SNI and still dial the already
 * validated address. No-ops for other hostnames and for callers outside this
 * async context. */
export async function withPinnedDnsLookup<T>(
  hostname: string,
  addresses: ResolvedAddress[],
  run: () => Promise<T>,
): Promise<T> {
  installDnsPin();
  return pinnedDns.run({ hostname, addresses }, run);
}
