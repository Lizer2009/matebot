import { describe, expect, it, vi } from "vitest";
import { connectEmailMailbox, EMAIL_MAILBOX_BEGIN } from "./mailbox-connect";

describe("connectEmailMailbox", () => {
  it("begins the featured mailbox connection and waits until connected", async () => {
    const begin = vi.fn(async () => ({
      connectionId: "conn-1",
      authorizationUrl: "https://auth.example/mailbox",
    }));
    const complete = vi.fn(async () => ({ status: "connected" }));
    const openUrl = vi.fn();
    await connectEmailMailbox({
      begin,
      complete,
      openUrl,
      signal: new AbortController().signal,
    });
    expect(begin).toHaveBeenCalledWith(EMAIL_MAILBOX_BEGIN);
    expect(openUrl).toHaveBeenCalledWith("https://auth.example/mailbox");
    expect(complete).toHaveBeenCalledWith({ connectionId: "conn-1" });
  });
});
