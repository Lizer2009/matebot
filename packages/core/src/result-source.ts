import type { ResultProvenance } from "./interaction-result.js";
import { readWindow } from "./interaction-result.js";

/**
 * Where a re-query may read from.
 *
 * The model may name a *registered* source; it may never name an endpoint, a SQL
 * statement, or a script. Each entry declares its own connection requirement and
 * performs the read itself, so authorization lives in the entry rather than in
 * whatever string the model produced.
 */

export type ResultSourceReadInput = {
  window: { from: string; to: string };
  connectionId: string | null;
  timezone: string;
};

export type ResultSourceReadResult =
  | {
      ok: true;
      rows: Array<Record<string, string | number | boolean | null>>;
      asOf: string;
      units?: string;
    }
  | { ok: false; error: string; outcome?: "failed" | "unavailable" };

export type ResultSource = {
  /** Stable id the tool may name; never a URL or a query. */
  id: string;
  label: string;
  /** The app that must be connected, or null for a local source. */
  requiresConnection: "email" | "calendar" | null;
  read: (input: ResultSourceReadInput) => Promise<ResultSourceReadResult>;
};

/**
 * A local source with no rows. It exists so the contract is exercised end to end
 * without inventing a provider: a deployment wires its real source here, and
 * until then this one honestly reports that it has nothing.
 */
const csvUpload: ResultSource = {
  id: "csv-upload",
  label: "Uploaded spreadsheet",
  requiresConnection: null,
  // An empty upload reads as an empty result, which the card reports honestly.
  read: async () => ({
    ok: true,
    rows: [],
    asOf: new Date().toISOString(),
    units: "CNY",
  }),
};

/**
 * The user's calendar as a read source. It needs the calendar connection, which
 * is why the connection requirement lives here rather than in the caller.
 */
const calendarEvents: ResultSource = {
  id: "calendar-events",
  label: "Calendar",
  requiresConnection: "calendar",
  read: async () => ({ ok: false, error: "calendar_read_not_wired" }),
};

export const RESULT_SOURCE_REGISTRY: readonly ResultSource[] = [csvUpload, calendarEvents];

/**
 * Extra sources a deployment or a test registers. Kept separate from the shipped
 * two so a test can add one without pretending it is a product capability, and so
 * a deployment can wire its real reader the same way.
 */
const extraSources = new Map<string, ResultSource>();

/** Register an additional source. Ids are validated the same way as shipped ones. */
export function registerResultSource(source: ResultSource): void {
  if (!/^[a-z][a-z0-9-]*$/.test(source.id)) {
    throw new Error(`Invalid result source id: ${source.id}`);
  }
  extraSources.set(source.id, source);
}

/** Test seam: drop registered extras. */
export function clearRegisteredResultSources(): void {
  extraSources.clear();
}

const BY_ID = new Map(RESULT_SOURCE_REGISTRY.map((source) => [source.id, source]));

/** The registered source, or undefined so the caller can refuse safely. */
export function findResultSource(id: string): ResultSource | undefined {
  return BY_ID.get(id) ?? extraSources.get(id);
}

export type QueryResultSourceInput = {
  sourceId: string;
  window: { from: string; to: string };
  timezone?: string;
};

export type QueryResultSourceOutput =
  | {
      ok: true;
      rows: Array<Record<string, string | number | boolean | null>>;
      provenance: ResultProvenance;
    }
  | { ok: false; error: string };

/**
 * Read a registered source for a window. Everything the model could tamper with
 * is validated first: the source must be registered, the window must be sane, and
 * a source that needs a connection must have one bound.
 */
export async function queryResultSource(
  input: QueryResultSourceInput,
  deps: { connectionId: string | null },
): Promise<QueryResultSourceOutput> {
  const source = findResultSource(input.sourceId);
  if (!source) return { ok: false, error: "unknown_source" };

  const window = readWindow(input.window);
  if (!window.ok) return { ok: false, error: "invalid_window" };

  if (source.requiresConnection && !deps.connectionId) {
    return { ok: false, error: "needs_connection" };
  }

  const read = await source.read({
    window: window.window,
    connectionId: deps.connectionId,
    timezone: input.timezone ?? "UTC",
  });
  if (!read.ok) return { ok: false, error: read.error };

  return {
    ok: true,
    rows: read.rows,
    provenance: {
      source: source.label,
      asOf: read.asOf,
      window: window.window,
      ...(read.units ? { units: read.units } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
  };
}

/** What to say when no source is configured, instead of inventing numbers. */
export function describeUnavailableSource(): string {
  return "No data source is configured for this request. Tell me where the numbers should come from and I will read from there.";
}
