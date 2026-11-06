import { useLingui } from "@lingui/react/macro";
import type { A2uiSurfaceBlock } from "@matebot/contracts";
import { emailSurfaceTemplateFromBlock } from "@matebot/core";
import { Button, Input, Spinner, Textarea } from "@matebot/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { SuccessPop } from "../ai/primitives";
import type { EmailDraftFields, EmailFieldName } from "./email-fields";
import { EMAIL_DRAFT_FIELD_NAMES } from "./email-fields";

function mailboxNeedsConnect(
  capability: A2uiSurfaceBlock["capability"],
): capability is "not_connected" | "requires_reauth" {
  return capability === "not_connected" || capability === "requires_reauth";
}

/**
 * Review-card email draft: edit fields, then one Send gesture.
 * Server still requires confirm-before-send; Send runs confirm then execute.
 * Surface template follows capability + lifecycle (progress / success / failed / UNKNOWN).
 */
export function EmailComposeEditor({
  draftVersion,
  confirmedVersion,
  capability,
  template,
  lifecycle,
  providerMessageId,
  error: surfaceError,
  fields,
  onFieldChange,
  onConfirm,
  onSend,
  onConnect,
  onCheckStatus,
  onDiscard,
}: {
  draftVersion: number;
  confirmedVersion?: number;
  capability?: A2uiSurfaceBlock["capability"];
  template?: A2uiSurfaceBlock["template"];
  lifecycle?: A2uiSurfaceBlock["lifecycle"];
  providerMessageId?: string;
  error?: string;
  fields: EmailDraftFields;
  onFieldChange?: (
    name: EmailFieldName,
    value: string,
    expectedDraftVersion: number,
  ) => Promise<{ draftVersion: number } | undefined>;
  onConfirm?: (draftVersion: number) => Promise<void>;
  onSend?: (draftVersion: number) => Promise<void>;
  onConnect?: () => Promise<void>;
  onCheckStatus?: () => Promise<void>;
  onDiscard?: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const fromId = useId();
  const toId = useId();
  const ccId = useId();
  const subjectId = useId();
  const bodyId = useId();
  const [values, setValues] = useState(fields);
  const [version, setVersion] = useState(draftVersion);
  /** Optimistic confirm: props lag SSE/snapshot after confirmInteraction. */
  const [localConfirmedVersion, setLocalConfirmedVersion] = useState<number | undefined>(
    confirmedVersion,
  );
  const [error, setError] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mailbox, setMailbox] = useState(capability);
  const committed = useRef(fields);
  const versionRef = useRef(draftVersion);
  const valuesRef = useRef(fields);
  const pending = useRef<Partial<Record<EmailFieldName, Promise<number>>>>({});
  valuesRef.current = values;

  useEffect(() => {
    setValues(fields);
    committed.current = fields;
    versionRef.current = draftVersion;
    setVersion(draftVersion);
  }, [draftVersion, fields.from, fields.to, fields.cc, fields.subject, fields.body]);

  useEffect(() => {
    setLocalConfirmedVersion(confirmedVersion);
  }, [confirmedVersion]);

  useEffect(() => {
    setMailbox(capability);
  }, [capability]);

  const effectiveConfirmedVersion = localConfirmedVersion ?? confirmedVersion;
  const confirmed = effectiveConfirmedVersion != null && effectiveConfirmedVersion === version;
  const resolvedTemplate = emailSurfaceTemplateFromBlock({
    template:
      mailbox === "ready" &&
      (template === "email-connection-card" || template === "email-reauth-card")
        ? undefined
        : template,
    lifecycle,
    capability: mailbox,
    intent: "email.compose",
    error: surfaceError,
  });
  const phase =
    busy &&
    (resolvedTemplate === "email-draft-card" ||
      resolvedTemplate === "action-submitting-card" ||
      resolvedTemplate === "action-result-failed")
      ? "action-progress-card"
      : resolvedTemplate;
  const locked =
    phase === "action-submitting-card" ||
    phase === "action-progress-card" ||
    phase === "action-result-success" ||
    phase === "action-result-failed" ||
    phase === "action-reconcile-card";

  async function commit(name: EmailFieldName, override?: string): Promise<number> {
    const inflight = pending.current[name];
    if (inflight) return inflight;
    const value = override ?? valuesRef.current[name];
    if (override !== undefined && override !== values[name]) {
      const nextValues = { ...valuesRef.current, [name]: override };
      valuesRef.current = nextValues;
      setValues(nextValues);
    }
    if (value === committed.current[name] || !onFieldChange) return versionRef.current;
    const previous = committed.current[name];
    committed.current = { ...committed.current, [name]: value };
    const task = (async () => {
      try {
        const result = await onFieldChange(name, value, versionRef.current);
        const next = result?.draftVersion ?? versionRef.current + 1;
        versionRef.current = next;
        setVersion(next);
        setLocalConfirmedVersion(undefined);
        return next;
      } catch (err) {
        committed.current = { ...committed.current, [name]: previous };
        throw err;
      }
    })();
    pending.current[name] = task;
    try {
      return await task;
    } finally {
      if (pending.current[name] === task) delete pending.current[name];
    }
  }

  async function flush(): Promise<number> {
    let next = versionRef.current;
    for (const name of EMAIL_DRAFT_FIELD_NAMES) {
      next = await commit(name);
    }
    return next;
  }

  function messageOf(err: unknown): string {
    return err instanceof Error && err.message ? err.message : t`Could not update the draft`;
  }

  if (discarded) {
    return (
      <div
        data-testid="a2ui-email-compose"
        data-discarded="true"
        className="text-[14px] text-muted-foreground"
      >
        {t`Discarded`}
      </div>
    );
  }

  return (
    <form
      data-testid="a2ui-email-compose"
      data-draft-version={version}
      data-confirmed={confirmed && phase !== "action-result-success" ? "true" : "false"}
      data-sent={phase === "action-result-success" ? "true" : "false"}
      data-template={phase}
      data-lifecycle={lifecycle ?? "draft"}
      className="grid gap-3"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="text-[12px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        {t`Email`}
      </div>
      <div className="grid gap-1">
        <label htmlFor={subjectId} className="sr-only">
          {t`Subject`}
        </label>
        <Input
          id={subjectId}
          data-testid="a2ui-email-subject"
          value={values.subject}
          placeholder={t`Subject`}
          disabled={locked}
          className="border-0 bg-transparent px-0 text-[18px] font-semibold shadow-none focus-visible:ring-0"
          onChange={(event) =>
            setValues((current) => ({ ...current, subject: event.target.value }))
          }
          onBlur={(event) => {
            void commit("subject", event.currentTarget.value).catch((err: unknown) =>
              setError(messageOf(err)),
            );
          }}
        />
      </div>
      <div className="grid gap-2 border-b border-border/60 pb-3">
        <FieldRow
          id={fromId}
          testId="a2ui-email-from"
          label={t`From`}
          value={values.from}
          autoComplete="email"
          disabled={locked}
          onChange={(value) => setValues((current) => ({ ...current, from: value }))}
          onBlur={(value) => {
            void commit("from", value).catch((err: unknown) => setError(messageOf(err)));
          }}
        />
        <FieldRow
          id={toId}
          testId="a2ui-email-to"
          label={t`To`}
          value={values.to}
          autoComplete="email"
          disabled={locked}
          onChange={(value) => setValues((current) => ({ ...current, to: value }))}
          onBlur={(value) => {
            void commit("to", value).catch((err: unknown) => setError(messageOf(err)));
          }}
        />
        <FieldRow
          id={ccId}
          testId="a2ui-email-cc"
          label={t`CC`}
          value={values.cc}
          autoComplete="email"
          placeholder="name@example.com"
          disabled={locked}
          onChange={(value) => setValues((current) => ({ ...current, cc: value }))}
          onBlur={(value) => {
            void commit("cc", value).catch((err: unknown) => setError(messageOf(err)));
          }}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={bodyId} className="sr-only">
          {t`Message`}
        </label>
        <Textarea
          id={bodyId}
          data-testid="a2ui-email-body"
          value={values.body}
          rows={6}
          disabled={locked}
          className="min-h-[8rem] border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          onChange={(event) => setValues((current) => ({ ...current, body: event.target.value }))}
          onBlur={(event) => {
            void commit("body", event.currentTarget.value).catch((err: unknown) =>
              setError(messageOf(err)),
            );
          }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <StatusLine
          phase={phase}
          providerMessageId={providerMessageId}
          surfaceError={surfaceError}
        />
        <div className="flex items-center gap-3">
          {phase === "action-submitting-card" ||
          phase === "action-progress-card" ||
          phase === "action-result-success" ? null : (
            <Button
              type="button"
              variant="ghost"
              data-testid="a2ui-email-discard"
              disabled={busy}
              className="text-muted-foreground"
              onClick={() => {
                setBusy(true);
                setError(null);
                void Promise.resolve(onDiscard?.())
                  .then(() => setDiscarded(true))
                  .catch((err: unknown) => setError(messageOf(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {t`Discard`}
            </Button>
          )}
          {phase === "action-submitting-card" ||
          phase === "action-progress-card" ? null : mailboxNeedsConnect(mailbox) &&
            phase === "email-connection-card" ? (
            <Button
              type="button"
              data-testid="a2ui-email-connect"
              disabled={busy}
              onClick={() => {
                if (!onConnect) return;
                setBusy(true);
                setError(null);
                void onConnect()
                  .then(() => setMailbox("ready"))
                  .catch((err: unknown) => setError(messageOf(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {t`Connect email`}
            </Button>
          ) : mailboxNeedsConnect(mailbox) && phase === "email-reauth-card" ? (
            <Button
              type="button"
              data-testid="a2ui-email-reauth"
              disabled={busy}
              onClick={() => {
                if (!onConnect) return;
                setBusy(true);
                setError(null);
                void onConnect()
                  .then(() => setMailbox("ready"))
                  .catch((err: unknown) => setError(messageOf(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {t({ message: "Reconnect", context: "mailbox" })}
            </Button>
          ) : phase === "action-result-failed" ? (
            <Button
              type="button"
              data-testid="a2ui-email-retry"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void Promise.resolve(onSend?.(version))
                  .catch((err: unknown) => setError(messageOf(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {t`Retry`}
            </Button>
          ) : phase === "action-reconcile-card" ? (
            <Button
              type="button"
              data-testid="a2ui-email-check-status"
              disabled={busy || !onCheckStatus}
              onClick={() => {
                if (!onCheckStatus) return;
                setBusy(true);
                setError(null);
                void onCheckStatus()
                  .catch((err: unknown) => setError(messageOf(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {t`Check status`}
            </Button>
          ) : phase === "action-result-success" ? null : onSend ? (
            <Button
              type="button"
              data-testid="a2ui-email-send"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void flush()
                  .then(async (next) => {
                    // One user gesture: confirm then execute when the draft is current.
                    if (effectiveConfirmedVersion !== next) {
                      if (!onConfirm) {
                        setError(t`Confirm this draft before sending.`);
                        return;
                      }
                      await onConfirm(next);
                      setLocalConfirmedVersion(next);
                    }
                    await onSend(next);
                  })
                  .catch((err: unknown) => setError(messageOf(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {t`Send`}
            </Button>
          ) : null}
        </div>
      </div>
      {error && phase !== "action-result-failed" && phase !== "action-reconcile-card" ? (
        <p data-testid="a2ui-email-error" role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {phase === "action-result-success" ? (
        <p data-testid="a2ui-email-sent" className="sr-only">
          {t`Sent`}
        </p>
      ) : null}
    </form>
  );
}

function StatusLine({
  phase,
  providerMessageId,
  surfaceError,
}: {
  phase: ReturnType<typeof emailSurfaceTemplateFromBlock>;
  providerMessageId?: string;
  surfaceError?: string;
}) {
  const { t } = useLingui();
  if (phase === "action-submitting-card" || phase === "action-progress-card") {
    return (
      <div
        data-testid="a2ui-email-progress"
        className="flex items-center gap-2 text-[13px] text-muted-foreground"
        aria-live="polite"
      >
        <Spinner className="size-3.5" aria-hidden />
        {t`Sending`}
      </div>
    );
  }
  if (phase === "action-result-success") {
    return (
      <div data-testid="a2ui-email-status" className="grid gap-1" aria-live="polite">
        <SuccessPop label={t`Sent`} />
        {providerMessageId ? (
          <div data-testid="a2ui-email-provider-id" className="text-[12px] text-muted-foreground">
            {providerMessageId}
          </div>
        ) : null}
      </div>
    );
  }
  if (phase === "action-result-failed") {
    return (
      <div
        data-testid="a2ui-email-failed"
        className="text-[13px] text-destructive"
        role="alert"
        aria-live="polite"
      >
        {surfaceError?.trim() || t`Could not send`}
      </div>
    );
  }
  if (phase === "action-reconcile-card") {
    return (
      <div
        data-testid="a2ui-email-unknown"
        className="text-[13px] text-muted-foreground"
        aria-live="polite"
      >
        {t`Don't send again`}
      </div>
    );
  }
  if (phase === "email-connection-card" || phase === "email-reauth-card") {
    return (
      <div
        data-testid="a2ui-email-status"
        className="text-[13px] text-muted-foreground"
        aria-live="polite"
      >
        {phase === "email-reauth-card" ? t`Authorization expired` : t`Not connected`}
      </div>
    );
  }
  return (
    <div
      data-testid="a2ui-email-status"
      className="text-[13px] text-muted-foreground"
      aria-live="polite"
    >
      {t`Needs approval`}
    </div>
  );
}

function FieldRow({
  id,
  testId,
  label,
  value,
  placeholder,
  autoComplete,
  disabled,
  onChange,
  onBlur,
}: {
  id: string;
  testId: string;
  label: string;
  value: string;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onBlur: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
      <label htmlFor={id} className="text-[13px] text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        data-testid={testId}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onBlur(event.currentTarget.value)}
      />
    </div>
  );
}
