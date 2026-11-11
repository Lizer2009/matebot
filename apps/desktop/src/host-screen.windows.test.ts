import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { HostScreen } from "@matebot/adapters/host-screen";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDesktopHostScreen,
  SCREEN_DRIVER_RELEASES,
  screenDriverInstaller,
} from "./host-screen.js";

const scope = { botId: "bot-1", signal: new AbortController().signal };

// Downloads the pinned driver and drives a real app, so it runs only on CI's Windows runner.
describe.runIf(process.platform === "win32" && process.env.CI)("Windows screen control", () => {
  let dir: string;
  let screen: HostScreen;
  let notepad: ReturnType<typeof spawn>;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "matebot-screen-"));
    screen = createDesktopHostScreen({
      platform: "win32",
      driver: screenDriverInstaller({
        dir: path.join(dir, "bin"),
        fetch: (url) => fetch(url),
        release: SCREEN_DRIVER_RELEASES.win32,
      }),
      home: path.join(dir, "home"),
      permissions: {
        isTrustedAccessibilityClient: () => false,
        getMediaAccessStatus: () => "denied",
        requestScreenCapture: async () => [],
      },
      locked: () => false,
    })!;
    notepad = spawn("notepad.exe", { detached: true, stdio: "ignore" });
    await sleep(3_000);
    // The driver's download retries a refused host with backoff, so setup can take minutes on a
    // bad day. The per-test budget covers that plus the assertions that follow it.
  }, 300_000);

  afterAll(async () => {
    await screen?.close();
    notepad?.kill();
    await sleep(500);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("observes Notepad, writes into it in the background, and reads the text back", async () => {
    const before = await screen.observe(scope, "notepad");
    console.log(before.tree);
    expect(before.image?.mimeType).toBe("image/png");
    const editor = /\[(\d+)\] (?:textfield|document)/.exec(before.tree);
    expect(editor, before.tree).not.toBeNull();
    const written = await screen.act(scope, "notepad", [
      { kind: "set", element: Number(editor![1]), value: "Hello from Matebot" },
    ]);
    console.log(JSON.stringify({ ...written, observation: written.observation?.tree }));
    expect(written).toMatchObject({ completed: 1 });
    expect(written.observation?.tree).toContain("Hello from Matebot");
    const selected = await screen.act(scope, "notepad", [
      { kind: "menu", path: ["Edit", "Select All"] },
    ]);
    console.log(JSON.stringify({ completed: selected.completed, error: selected.error }));
    // Two outcomes are correct, and which one appears depends on whether Notepad's window owns
    // the foreground when the menu is clicked. It is not this app's to take: the driver can only
    // activate a window with `--headed`, which would steal it from whoever is using the machine.
    // Either the menu opened, or it was refused and the bot was told to ask the person to click
    // the window. A refusal that says anything else is a real failure.
    if (selected.completed === 1) {
      expect(selected.error).toBeUndefined();
    } else {
      expect(selected.completed).toBe(0);
      expect(selected.error).toContain("can only be chosen while its window is active");
    }
    await expect(screen.observe(scope, "matebot-missing-app")).rejects.toThrow(
      'No app named "matebot-missing-app" is open.',
    );
  }, 300_000);
});
