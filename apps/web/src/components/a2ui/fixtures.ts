import type { A2uiSurfaceBlock } from "@matebot/contracts";

/** documentRef keys the host may hydrate without PR-4 persistence (fixture-only). */
export const A2UI_FIXTURE_MINIMAL_REF = "fixture:v0_9-minimal" as const;

/** Same catalog id as `@matebot/a2ui-adapter` `basicCatalogId("v0_9")` — avoid a static adapter import in the web card path. */
const V0_9_BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

/**
 * Minimal v0.9 surface — aligned with `packages/a2ui-adapter/fixtures/v0_9-minimal-surface.json`.
 * Checked in so the web host stays offline and independent of adapter package file layout.
 */
export function minimalV09SurfaceMessages(surfaceId = "fixture-minimal"): unknown[] {
  return [
    {
      version: "v0.9",
      createSurface: {
        surfaceId,
        catalogId: V0_9_BASIC_CATALOG_ID,
      },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId,
        components: [
          {
            id: "root",
            component: "Column",
            children: ["title"],
          },
          {
            id: "title",
            component: "Text",
            text: "Hello from Matebot A2UI fixture",
            variant: "h3",
          },
        ],
      },
    },
  ];
}

/** Surface messages that include an unknown component — used to prove refuse-safe behavior. */
export function unknownComponentSurfaceMessages(surfaceId = "fixture-unknown"): unknown[] {
  return [
    {
      version: "v0.9",
      createSurface: {
        surfaceId,
        catalogId: V0_9_BASIC_CATALOG_ID,
      },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId,
        components: [
          {
            id: "root",
            component: "EvilWidget",
            html: "<script>alert(1)</script>",
          },
        ],
      },
    },
  ];
}

export function resolveFixtureMessages(documentRef: string | undefined): unknown[] | undefined {
  if (documentRef === A2UI_FIXTURE_MINIMAL_REF) {
    return minimalV09SurfaceMessages();
  }
  return undefined;
}

/** Timeline block used by the e2e / gallery fixture when the `a2ui` flag is on. */
export function fixtureA2uiSurfaceBlock(
  overrides: Partial<A2uiSurfaceBlock> = {},
): A2uiSurfaceBlock {
  return {
    kind: "a2ui_surface",
    interactionId: "00000000-0000-4000-8000-0000000000a2",
    surfaceId: "fixture-minimal",
    protocolFamily: "v0_9",
    draftVersion: 1,
    title: "A2UI fixture",
    summary: "Declarative surface (fixture-only)",
    documentRef: A2UI_FIXTURE_MINIMAL_REF,
    ...overrides,
  };
}
