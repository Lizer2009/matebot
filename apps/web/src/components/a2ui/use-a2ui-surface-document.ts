import { parseA2uiSurfaceDocumentRef } from "@matebot/contracts";
import { useEffect, useState } from "react";
import { resolveFixtureMessages } from "./fixtures";

export type A2uiSurfaceDocumentSource = {
  documentRef?: string;
  /** Injected for tests / gallery; skips network. */
  messages?: unknown[];
  /** Optional fetcher; when omitted and documentRef is a server ref, host shows placeholder. */
  fetchDocument?: (documentRef: string) => Promise<unknown[] | undefined>;
};

/**
 * Resolve A2UI protocol messages for a surface card:
 * 1. explicit messages prop
 * 2. local fixture documentRef
 * 3. server documentRef via fetchDocument (PR-4 persistence)
 */
export function useA2uiSurfaceDocument(source: A2uiSurfaceDocumentSource): {
  messages: unknown[] | undefined;
  loading: boolean;
  error: string | null;
} {
  const fixture = resolveFixtureMessages(source.documentRef);
  const [remote, setRemote] = useState<unknown[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const documentRef = source.documentRef;
  const fetchDocument = source.fetchDocument;
  const injected = source.messages;

  useEffect(() => {
    if (injected || resolveFixtureMessages(documentRef) || !documentRef || !fetchDocument) {
      setRemote(undefined);
      setLoading(false);
      setError(null);
      return;
    }
    if (!parseA2uiSurfaceDocumentRef(documentRef)) {
      setRemote(undefined);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchDocument(documentRef)
      .then((messages) => {
        if (cancelled) return;
        setRemote(messages);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRemote(undefined);
        setLoading(false);
        setError(err instanceof Error ? err.message : "Failed to load surface");
      });
    return () => {
      cancelled = true;
    };
  }, [injected, documentRef, fetchDocument]);

  if (injected) return { messages: injected, loading: false, error: null };
  if (fixture) return { messages: fixture, loading: false, error: null };
  return { messages: remote, loading, error };
}
