import { afterEach, describe, expect, it, vi } from "vitest";
import {
  interactionMailPathAvailable,
  OUTBOUND_EMAIL_SHELL_REFUSAL,
  outboundEmailScriptRefusal,
  refuseOutboundEmailShell,
} from "./email-shell-escape.js";

const smtpPython = `python3 -c 'import smtplib; smtplib.SMTP("localhost", 587).sendmail("a@x.test", ["b@x.test"], "hi")'`;

function ctx(options?: { builtins?: { name: string }[]; disabled?: string[] }) {
  return {
    tools: {
      builtins: options?.builtins ?? [{ name: "present_interaction" }, { name: "shell" }],
      disabled: new Set(options?.disabled ?? []),
    },
  };
}

describe("outboundEmailScriptRefusal", () => {
  it.each([
    smtpPython,
    "python3 -c 'import aiosmtplib'",
    "node -e 'require(\"nodemailer\").createTransport({})'",
    "python3 -c 'smtplib.SMTP_SSL(\"smtp.example.test\")'",
    "curl smtp://mail.example.test:587",
    "curl smtps://mail.example.test",
    "sendmail -t < message.eml",
    "msmtp --read-envelope-from",
    "swaks --to b@x.test",
    "mailx -s hi b@x.test",
    'mail -s "hello" b@x.test',
    "python3 -c 'host=os.environ[\"SMTP_HOST\"]'",
    "python3 -c 'pwd=os.environ[\"MAIL_PASSWORD\"]'",
  ])("refuses outbound mail command %s", (command) => {
    expect(outboundEmailScriptRefusal(command)).toBe(OUTBOUND_EMAIL_SHELL_REFUSAL);
  });

  it.each([
    "python3 -c 'print(1)'",
    "python3 -c 'import csv; print(sum(1 for _ in open(\"a.csv\")))'",
    "python3 -c 'import socket; socket.gethostname()'",
    "python3 -c 'import requests; print(requests.__version__)'",
    "python3 -c 'x = data[1:25]'",
    "python3 -c 'import email; print(email.message_from_string(raw))'",
    "ls",
    "",
  ])("allows local compute %s", (command) => {
    expect(outboundEmailScriptRefusal(command)).toBeUndefined();
  });
});

describe("refuseOutboundEmailShell", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses smtplib when FEATURE_A2UI offers present_interaction", () => {
    vi.stubEnv("FEATURE_A2UI", "1");
    expect(refuseOutboundEmailShell(ctx(), { command: smtpPython })).toEqual({
      error: OUTBOUND_EMAIL_SHELL_REFUSAL,
    });
    expect(refuseOutboundEmailShell(ctx(), { cmd: smtpPython })).toEqual({
      error: OUTBOUND_EMAIL_SHELL_REFUSAL,
    });
  });

  it("does not refuse when FEATURE_A2UI is off", () => {
    vi.stubEnv("FEATURE_A2UI", "0");
    expect(refuseOutboundEmailShell(ctx(), { command: smtpPython })).toBeUndefined();
    expect(interactionMailPathAvailable(ctx())).toBe(false);
  });

  it("does not refuse when present_interaction is not offered", () => {
    vi.stubEnv("FEATURE_A2UI", "1");
    expect(
      refuseOutboundEmailShell(ctx({ builtins: [{ name: "shell" }] }), { command: smtpPython }),
    ).toBeUndefined();
    expect(
      refuseOutboundEmailShell(ctx({ disabled: ["present_interaction"] }), {
        command: smtpPython,
      }),
    ).toBeUndefined();
  });

  it("does not refuse ordinary python when the interaction path is offered", () => {
    vi.stubEnv("FEATURE_A2UI", "1");
    expect(refuseOutboundEmailShell(ctx(), { command: "python3 -c 'print(1)'" })).toBeUndefined();
  });
});
