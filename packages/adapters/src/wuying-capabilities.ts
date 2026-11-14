import type { SandboxCapabilities } from "@matebot/adapter-kit";

/**
 * Wuying's static descriptor, kept clear of the Alibaba ECS/AppStream SDK imports.
 *
 * The synchronous capability helpers in `computer-lifecycle.ts` must answer for every kind,
 * including ones whose provider is an optional SDK. Importing `wuying-sandbox.js` there pulled
 * the Alibaba SDKs into the barrel on the default path, which is what
 * `sandbox-factory-lazy.test.ts` guards against. `wuying-sandbox.ts` stays the runtime owner;
 * this module only holds the values that never change.
 */
export const WUYING_SANDBOX_DESCRIPTOR: {
  id: string;
  contractVersion: string;
  adapterVersion: string;
  capabilities: SandboxCapabilities;
} = {
  id: "wuying",
  contractVersion: "1",
  adapterVersion: "0.1.0",
  capabilities: {
    graphical: true,
    pty: false,
    snapshots: false,
    takeover: true,
    persistentHome: true,
    multiScreen: false,
    inPlaceUpdate: false,
  },
};
