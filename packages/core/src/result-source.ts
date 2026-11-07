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
  /**
   * A specific artifact the caller named, when the source reads files. It is only
   * honored by sources that read the user's own uploads, and the reader still
   * checks ownership before returning anything.
   */
  artifactId?: string;
};

/** The shape a caller-supplied reader has; see `queryResultSource`. */
export type ResultSourceRead = ResultSource["read"];

export type ResultSourceReadResult =
  | {
      ok: true;
      rows: Array<Record<string, string | number | boolean | null>>;
      asOf: string;
      units?: string;
      /**
       * A more specific name for where these rows came from, such as the file the
       * user uploaded. The card uses it when present, so a reader can say
       * "Upload: sales.csv" instead of a generic source label.
       */
      sourceLabel?: string;
      /** True when the reader had to drop rows to fit a bound. */
      truncated?: boolean;
      /** The number of rows the source held, when it is more than were returned. */
      totalRows?: number;
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
 * The user's own uploaded spreadsheet.
 *
 * Like the calendar, the reader belongs to one turn: it needs this user's
 * artifact store and the message that carried the file, so the registry only
 * names the source. With no reader supplied the read says it has nothing wired
 * rather than returning zero rows, which a reader would take to mean "the file
 * is empty".
 */
const csvUpload: ResultSource = {
  id: "csv-upload",
  label: "Uploaded spreadsheet",
  requiresConnection: null,
  read: async () => ({ ok: false, error: "csv_read_not_wired" }),
};

/**
 * The user's calendar as a read source.
 *
 * A source is registered as a description of *where* data may come from; the
 * reader that can actually reach a provider belongs to one turn, because it
 * needs that user's connector and that user's connection. The caller supplies it
 * per query (`queryResultSource`'s `read` dep) instead of the source holding it,
 * so one turn's credentials can never serve another turn's read. With no reader
 * supplied the read says so rather than returning an empty calendar, which a
 * reader would take to mean "you have no events".
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
  /** A specific uploaded file to read, when the source reads files. */
  artifactId?: string;
};

export type QueryResultSourceOutput =
  | {
      ok: true;
      rows: Array<Record<string, string | number | boolean | null>>;
      provenance: ResultProvenance;
      /** True when the source held more rows than the read returned. */
      truncated?: boolean;
      /** How many rows the source held, when it reports that. */
      totalRows?: number;
    }
  | { ok: false; error: string };

/**
 * Read a registered source for a window. Everything the model could tamper with
 * is validated first: the source must be registered, the window must be sane, and
 * a source that needs a connection must have one bound.
 */
export async function queryResultSource(
  input: QueryResultSourceInput,
  deps: {
    connectionId: string | null;
    /**
     * A reader for one source id, used instead of the registered `read`. This is
     * how a source that needs the user's own provider connection is read without
     * the registry ever holding credentials shared between users. Returning
     * undefined for an id means "use the registered reader", so a turn's calendar
     * reader can never stand in for a source it does not represent.
     */
    readFor?: (sourceId: string) => ResultSource["read"] | undefined;
  },
): Promise<QueryResultSourceOutput> {
  const source = findResultSource(input.sourceId);
  if (!source) return { ok: false, error: "unknown_source" };

  const window = readWindow(input.window);
  if (!window.ok) return { ok: false, error: "invalid_window" };

  if (source.requiresConnection && !deps.connectionId) {
    return { ok: false, error: "needs_connection" };
  }

  const reader = deps.readFor?.(input.sourceId) ?? source.read;
  const read = await reader({
    window: window.window,
    connectionId: deps.connectionId,
    timezone: input.timezone ?? "UTC",
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
  });
  if (!read.ok) return { ok: false, error: read.error };

  return {
    ok: true,
    rows: read.rows,
    provenance: {
      // A reader that names its own origin (a file the user attached) wins over
      // the generic registry label, so the card says where the numbers really came from.
      source: read.sourceLabel ?? source.label,
      asOf: read.asOf,
      window: window.window,
      ...(read.units ? { units: read.units } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
    ...(read.truncated ? { truncated: true } : {}),
    ...(read.totalRows !== undefined ? { totalRows: read.totalRows } : {}),
  };
}
