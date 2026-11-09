import type { InteractionPlan } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { describeDraftForModel } from "./interaction-readback.js";

/**
 * What the model is told about a card it just published or edited.
 *
 * The audit's worst moment was a model saying "the recipient, subject and body are all filled
 * in" about a card with no controls in it. It was not lying: nothing ever told it what the card
 * actually became, so it described the plan it had submitted.
 *
 * The readback has to answer three questions in the model's own terms — which fields exist and
 * what they hold, which required ones are still empty, and whether the card can be acted on —
 * without handing it data it should not repeat. Values it can see are the ones a person would
 * read off the card; connection references and provider identifiers stay out.
 */

const EMAIL_PLAN: InteractionPlan = {
  intent: "email.compose",
  title: "冬天的问候",
  fields: [
    { name: "to", value: "alex@example.test", required: true, status: "resolved" },
    { name: "cc", required: false, status: "missing" },
    { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
    { name: "body", required: true, status: "missing" },
  ],
  nextStep: "render",
  riskLevel: "medium",
};

describe("describeDraftForModel", () => {
  it("reports the fields the card shows, with their current values", () => {
    const readback = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: { to: "alex@example.test", subject: "冬天的问候" },
      draftVersion: 3,
      capability: "ready",
    });
    expect(readback.fields).toEqual([
      { name: "to", value: "alex@example.test", required: true, filled: true },
      { name: "cc", value: "", required: false, filled: false },
      { name: "subject", value: "冬天的问候", required: true, filled: true },
      { name: "body", value: "", required: true, filled: false },
    ]);
  });

  it("names the required fields that are still empty", () => {
    const readback = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: { to: "alex@example.test", subject: "冬天的问候" },
      draftVersion: 3,
      capability: "ready",
    });
    expect(readback.missingRequired).toEqual(["body"]);
  });

  it("says whether the card can be acted on, and why not", () => {
    const incomplete = describeDraftForModel({
      plan: EMAIL_PLAN,
      // `subject` falls back to the plan's own value, so only `body` is still a gap here.
      slots: { to: "alex@example.test" },
      draftVersion: 1,
      capability: "ready",
    });
    expect(incomplete.actionable).toBe(false);
    expect(incomplete.blockedBy).toEqual(["body"]);

    // The plan's own values stand in when a slot has not been written yet, so an untouched
    // draft still reports the two fields it carries.
    const untouched = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: {},
      draftVersion: 1,
      capability: "ready",
    });
    expect(untouched.blockedBy).toEqual(["body"]);

    const complete = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: { to: "alex@example.test", subject: "s", body: "b" },
      draftVersion: 1,
      capability: "ready",
    });
    expect(complete.actionable).toBe(true);
    expect(complete.blockedBy).toEqual([]);
  });

  it("does not claim the card is actionable when the mailbox is not connected", () => {
    // A complete draft on a disconnected mailbox cannot be sent, and saying otherwise sends the
    // model back to telling the person to press a button that will refuse.
    const readback = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: { to: "a@example.test", subject: "s", body: "b" },
      draftVersion: 1,
      capability: "not_connected",
    });
    expect(readback.actionable).toBe(false);
    expect(readback.blockedBy).toEqual(["connection"]);
  });

  it("carries the revision the next edit has to quote", () => {
    const readback = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: {},
      draftVersion: 7,
      capability: "ready",
    });
    expect(readback.revision).toBe(7);
  });

  it("never echoes a connection reference or provider identifier", () => {
    // The person can read the recipient off the card; they cannot read a providerRef, and a
    // model that repeats one puts it in the transcript.
    const readback = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: {
        to: "a@example.test",
        providerRef: "ca_live_abc123",
        connectionId: "conn-9",
      },
      draftVersion: 1,
      capability: "ready",
    });
    const serialised = JSON.stringify(readback);
    expect(serialised).not.toContain("ca_live_abc123");
    expect(serialised).not.toContain("conn-9");
    // And they are not presented as fields the card shows.
    expect(readback.fields.map((field) => field.name)).toEqual(["to", "cc", "subject", "body"]);
  });

  it("describes the sender as a read-only attribution, not an editable field", () => {
    const readback = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: { to: "a@example.test", subject: "s", body: "b" },
      draftVersion: 1,
      capability: "ready",
      sender: { address: "me@example.test", label: "me@example.test" },
    });
    expect(readback.sender).toEqual({ address: "me@example.test", label: "me@example.test" });
    // It is not a field, so nothing invites the model to set it.
    expect(readback.fields.map((field) => field.name)).not.toContain("sender");
    expect(readback.fields.map((field) => field.name)).not.toContain("from");
  });

  it("shows only the label when the address is not known", () => {
    // `Connection.displayName` is whatever the client passed when the connection was made — a
    // card title, an app name. Presenting it as the sending address would be a claim the server
    // cannot support, so only the label is reported.
    const readback = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: { to: "a@example.test", subject: "s", body: "b" },
      draftVersion: 1,
      capability: "ready",
      sender: { label: "Gmail" },
    });
    expect(readback.sender).toEqual({ label: "Gmail" });
    expect(readback.sender?.address).toBeUndefined();
  });

  it("does not treat a label that looks like an address as the sending address", () => {
    // A label may happen to contain an @, which is exactly why presence of one cannot be used
    // as evidence that it is the mailbox a message will come from.
    const readback = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: {},
      draftVersion: 1,
      capability: "ready",
      sender: { label: "looks-like@an-address.example" },
    });
    expect(readback.sender).toEqual({ label: "looks-like@an-address.example" });
    expect(readback.sender?.address).toBeUndefined();
  });

  it("omits the sender when no connection names one", () => {
    const readback = describeDraftForModel({
      plan: EMAIL_PLAN,
      slots: {},
      draftVersion: 1,
    });
    expect(readback.sender).toBeUndefined();
  });
});
