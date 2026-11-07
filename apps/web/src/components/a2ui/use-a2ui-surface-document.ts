import { parseA2uiSurfaceDocumentRef } from "@matebot/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveFixtureMessages } from "./fixtures";

export type A2uiSurfaceDocumentSource = {
  documentRef?: string;
  /**
   * The draft revision the block was rendered from.
   *
   * A republish rewrites the stored document behind the *same* ref, so the ref alone
   * cannot tell a card that its content changed. Without this, an edit landed on the
   * server and the card kept drawing the document it fetched first.
   */
  revision?: number;
  /** Injected for tests / gallery; skips network. */
  messages?: unknown[];
  /** Optional fetcher; when omitted and documentRef is a server ref, host shows placeholder. */
  fetchDocument?: (documentRef: string) => Promise<unknown[] | undefined>;
};

export type A2uiSurfaceDocumentState = {
  messages: unknown[] | undefined;
  loading: boolean;
  error: string | null;
  /**
   * True when the card has nothing to draw and no fetch is in flight: either the
   * host was given no way to load the document, or the fetch returned nothing.
   * The card must show something readable in this state rather than leaving the
   * region empty.
   */
  unavailable: boolean;
  /** Load again after a failure. A no-op when there is nothing to fetch. */
  reload: () => void;
};

/**
 * Resolve A2UI protocol messages for a surface card:
 * 1. explicit messages prop
 * 2. local fixture documentRef
 * 3. server documentRef via fetchDocument (PR-4 persistence)
 *
 * A card whose document cannot be resolved reports `unavailable` rather than
 * returning an empty list, so the caller can say why instead of drawing a blank
 * box. Loading and failure are separate states because they need different words.
 */
export function useA2uiSurfaceDocument(
  source: A2uiSurfaceDocumentSource,
): A2uiSurfaceDocumentState {
  const fixture = resolveFixtureMessages(source.documentRef);
  const [remote, setRemote] = useState<unknown[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A fetch that resolves after the card unmounts must not set state.
  const mounted = useRef(true);

  const documentRef = source.documentRef;
  // Part of the effect key so a republished document is fetched again.
  const revision = source.revision;
  const fetchDocument = source.fetchDocument;
  const injected = source.messages;
  /**
   * The fetcher is read through a ref, not held in the effect's key.
   *
   * Callers pass an inline closure, so its identity changes on every parent
   * render. Keying on it refetched the document — and blinked the card back to its
   * loading frame — whenever unrelated activity re-rendered the thread. What the
   * document *is* changed is the ref and the revision, and those stay in the key.
   */
  const fetcher = useRef(fetchDocument);
  fetcher.current = fetchDocument;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const serverRef = Boolean(documentRef && parseA2uiSurfaceDocumentRef(documentRef));

  useEffect(() => {
    if (injected || fixture || !serverRef) {
      setRemote(undefined);
      setLoading(false);
      setError(null);
      return;
    }
    // A server ref with no fetcher is not "loading": it will never load, so the
    // card reports it as unavailable instead of waiting forever.
    const load = fetcher.current;
    if (!load) {
      setRemote(undefined);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void load(documentRef!)
      .then((messages) => {
        if (cancelled || !mounted.current) return;
        // An empty document is a failure to load, not an empty surface: a card
        // with no components would otherwise render as a blank region.
        if (!messages || messages.length === 0) {
          setRemote(undefined);
          setError("This card had no content to load.");
        } else {
          setRemote(messages);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled || !mounted.current) return;
        setRemote(undefined);
        setLoading(false);
        setError(err instanceof Error ? err.message : "Could not load this card.");
      });
    return () => {
      cancelled = true;
    };
  }, [injected, fixture, serverRef, documentRef, revision, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  if (injected && injected.length > 0) {
    return { messages: injected, loading: false, error: null, unavailable: false, reload };
  }
  if (fixture)
    return { messages: fixture, loading: false, error: null, unavailable: false, reload };

  const unavailable = !loading && remote === undefined;
  return { messages: remote, loading, error, unavailable, reload };
}
