import type { ResultSourceRead } from "@matebot/core";
import { parseCsv } from "@matebot/core";

/**
 * The user's uploaded spreadsheet, read from the file they actually attached.
 *
 * Resolution order is deliberate and narrow:
 *
 * 1. The artifact the model named, but only if that row belongs to this space and
 *    this user — the same ownership check every other artifact read uses.
 * 2. Otherwise the files attached to the message that started this run, newest
 *    first. That is the file the person just handed over; nothing else is
 *    reachable, and no path or URL is ever accepted from the model.
 *
 * The bytes go through one deterministic parser, so the card shows what the file
 * contains. Nothing is fetched over the network and nothing outside the user's own
 * artifacts is readable.
 */

export type CsvArtifactLookup = {
  /** Load the artifact row if it belongs to this space and user. */
  find: (
    artifactId: string,
  ) => Promise<{ id: string; name: string; mimeType: string; storageKey: string } | null>;
  /** Read its bytes. */
  read: (storageKey: string) => Promise<Uint8Array>;
};

export type CsvReaderDeps = {
  artifacts: CsvArtifactLookup;
  /** Artifact ids attached to the message that started this run, in message order. */
  attachedArtifactIds: readonly string[];
};

const CSV_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
]);

function isCsv(artifact: { name: string; mimeType: string }): boolean {
  const type = artifact.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return CSV_MIME_TYPES.has(type) || artifact.name.toLowerCase().endsWith(".csv");
}

/**
 * Build the reader for one turn.
 *
 * `read` is only offered when there is at least one candidate file, so a query
 * with no upload in scope refuses with "no file" instead of reading an empty
 * table and calling it data.
 */
export function csvResultReader(
  deps: CsvReaderDeps,
  options: { artifactId?: string } = {},
): ResultSourceRead | undefined {
  const candidates = options.artifactId
    ? [options.artifactId]
    : [...deps.attachedArtifactIds].reverse();
  if (candidates.length === 0) return undefined;

  return async ({ window }) => {
    let chosen: { id: string; name: string; bytes: Uint8Array } | undefined;
    for (const artifactId of candidates) {
      const row = await deps.artifacts.find(artifactId);
      // A named id that is not this user's, or is not a CSV, is not a fallback:
      // silently reading a different file would misattribute the numbers.
      if (!row || !isCsv(row)) {
        if (options.artifactId) return { ok: false, error: "not_a_csv", outcome: "failed" };
        continue;
      }
      chosen = { id: row.id, name: row.name, bytes: await deps.artifacts.read(row.storageKey) };
      break;
    }
    if (!chosen) return { ok: false, error: "no_uploaded_file", outcome: "unavailable" };

    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(chosen.bytes);
    const parsed = parseCsv(decoded);
    if (!parsed.ok) return { ok: false, error: parsed.error, outcome: "failed" };

    // The window is a filter over the rows, not something the file declares, so
    // it is applied only when the file has a column that reads as a date.
    const filtered = filterByWindow(parsed.csv.rows, window);

    return {
      ok: true,
      rows: filtered,
      // The measurement time is now: this is when the file was read. The file's
      // own freshness is unknown, so it is not claimed.
      asOf: new Date().toISOString(),
      sourceLabel: `Upload: ${chosen.name}`,
      // Only a genuine bound is reported; a window filter is a view, not truncation.
      ...(filtered.length === parsed.csv.rows.length && parsed.csv.truncated
        ? { truncated: true, totalRows: parsed.csv.totalRows }
        : {}),
    };
  };
}

/** Apply the requested window when the rows carry something date-like. */
function filterByWindow(
  rows: Array<Record<string, string | number | boolean | null>>,
  window: { from: string; to: string },
): Array<Record<string, string | number | boolean | null>> {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return rows;

  const sample = rows[0];
  if (!sample) return rows;
  const dateKey = Object.keys(sample).find((key) => {
    const value = sample[key];
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  });
  if (!dateKey) return rows;

  return rows.filter((row) => {
    const value = row[dateKey];
    if (typeof value !== "string") return true;
    const at = Date.parse(value);
    // A row whose date cannot be read is kept rather than silently dropped.
    if (!Number.isFinite(at)) return true;
    return at >= from && at <= to;
  });
}

export type { ResultSourceRead };
