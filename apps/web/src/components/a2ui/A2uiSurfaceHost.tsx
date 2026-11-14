import { useCallback, useEffect, useRef, useState } from "react";
import { guardA2uiCatalogMessages } from "./catalog-guard";
import type { A2uiActionListener, A2uiRendererModules } from "./load-a2ui";
import { createA2uiProcessor, loadA2uiRenderer, safePlainMarkdown } from "./load-a2ui";
import "./a2ui-theme.css";

/** Fixed degrade copy. Never `cause.message`, never the surface id (AC-22). */
export const A2UI_SURFACE_DEGRADE = "This card could not be shown.";

type HostState =
  | { kind: "loading" }
  | { kind: "refused"; reason: string }
  | { kind: "error"; reason: string; hint?: string }
  | {
      kind: "ready";
      mods: A2uiRendererModules;
      /** Keep the processor rooted so the surface model stays live. */
      processor: InstanceType<A2uiRendererModules["MessageProcessor"]>;
      surface: unknown;
    };

/**
 * Renders a single A2UI v0.9 surface from protocol messages via `@a2ui/react`.
 * Unknown catalog components are refused before the processor runs — no
 * arbitrary HTML/JSX from the model.
 *
 * When `onAction` is supplied the processor is built with it, so every
 * `action.event` in the tree reaches one server dispatch instead of drawing a
 * control that does nothing. A surface rendered without a listener says so in
 * the DOM rather than presenting dead buttons.
 */
export function A2uiSurfaceHost({
  surfaceId,
  messages,
  onAction,
  fallbackHint,
}: {
  surfaceId: string;
  messages: unknown[];
  onAction?: A2uiActionListener;
  /** Key slots/title shown under the fixed degrade sentence. Never a stack. */
  fallbackHint?: string;
}) {
  const [state, setState] = useState<HostState>({ kind: "loading" });
  /**
   * The listener arrives as an inline arrow from the message row, so its identity changes on
   * every parent render. Keeping it in a ref gives the processor one stable bridge instead:
   * when this was an effect dependency, each re-render tore the surface down to the loading
   * skeleton and rebuilt it, and the card visibly blinked for as long as the thread kept
   * re-rendering.
   */
  const listener = useRef(onAction);
  listener.current = onAction;
  const dispatch = useCallback<A2uiActionListener>((action) => listener.current?.(action), []);
  /** A surface already drawn stays on screen while its replacement compiles. */
  const drawnSurfaceId = useRef<string | null>(null);

  useEffect(() => {
    const guard = guardA2uiCatalogMessages(messages);
    if (!guard.ok) {
      // Catalog names and parser text stay off the card (AC-22). The guard still
      // refuses the tree; only the fixed sentence and key slots are shown.
      setState({
        kind: "error",
        reason: A2UI_SURFACE_DEGRADE,
        ...(fallbackHint ? { hint: fallbackHint } : {}),
      });
      return;
    }

    let cancelled = false;
    // Swapping a drawn card for a skeleton on every update is the flash the card showed
    // after an edit. Only a different surface starts from the loading state.
    if (drawnSurfaceId.current !== surfaceId) setState({ kind: "loading" });

    void (async () => {
      try {
        const mods = await loadA2uiRenderer();
        if (cancelled) return;
        // A surface with no listener would render buttons that go nowhere.
        const processor = createA2uiProcessor(mods, dispatch);
        processor.processMessages(messages as never[]);
        const surface = processor.model.surfacesMap.get(surfaceId);
        if (!surface) {
          setState({
            kind: "error",
            reason: A2UI_SURFACE_DEGRADE,
            ...(fallbackHint ? { hint: fallbackHint } : {}),
          });
          return;
        }
        drawnSurfaceId.current = surfaceId;
        setState({ kind: "ready", mods, processor, surface });
      } catch {
        if (cancelled) return;
        setState({
          kind: "error",
          reason: A2UI_SURFACE_DEGRADE,
          ...(fallbackHint ? { hint: fallbackHint } : {}),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages, surfaceId, dispatch, fallbackHint]);

  if (state.kind === "loading") {
    // The renderer loads in a separate chunk, so there is a moment after the
    // document arrives and before the card can be drawn. That region used to be an
    // empty div — the same blank frame the audit found, just a shorter one. It now
    // says it is busy and draws a placeholder bar, without adding a sentence the
    // card does not need.
    return (
      <div
        data-testid="a2ui-surface-loading"
        role="status"
        aria-busy="true"
        className="matebot-a2ui-theme px-1 py-2"
      >
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" aria-hidden="true" />
      </div>
    );
  }

  if (state.kind === "refused" || state.kind === "error") {
    return (
      <div
        data-testid="a2ui-surface-refused"
        role="status"
        className="matebot-a2ui-theme rounded-[12px] border border-border bg-muted px-4 py-3 text-[14px] text-muted-foreground"
      >
        <div>{state.reason}</div>
        {state.kind === "error" && state.hint ? (
          <div data-testid="a2ui-surface-degrade-hint" className="mt-1 truncate text-foreground">
            {state.hint}
          </div>
        ) : null}
      </div>
    );
  }

  // Retain processor on the ready state so the surface model is not GC'd.
  void state.processor;
  const { A2uiSurface, MarkdownContext } = state.mods;
  return (
    <div data-testid="a2ui-surface-host" className="matebot-a2ui-theme min-w-0">
      <MarkdownContext.Provider value={safePlainMarkdown}>
        <A2uiSurface surface={state.surface as never} />
      </MarkdownContext.Provider>
    </div>
  );
}
