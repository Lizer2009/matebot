import { useLingui } from "@lingui/react/macro";
import { Button, Input, Textarea } from "@matebot/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import type { EmailDraftFields, EmailFieldName } from "./email-fields";
import { EMAIL_DRAFT_FIELD_NAMES } from "./email-fields";

/**
 * Review-card email draft: edit fields, then one Send gesture.
 * Server still requires confirm-before-send; Send runs confirm then execute.
 */
export function EmailComposeEditor({
  draftVersion,
  confirmedVersion,
  fields,
  onFieldChange,
  onConfirm,
  onSend,
  onDiscard,
}: {
  draftVersion: number;
  confirmedVersion?: number;
  fields: EmailDraftFields;
  onFieldChange?: (
    name: EmailFieldName,
    value: string,
    expectedDraftVersion: number,
  ) => Promise<{ draftVersion: number } | undefined>;
  onConfirm?: (draftVersion: number) => Promise<void>;
  onSend?: (draftVersion: number) => Promise<void>;
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
  const [sent, setSent] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const effectiveConfirmedVersion = localConfirmedVersion ?? confirmedVersion;
  const confirmed = effectiveConfirmedVersion != null && effectiveConfirmedVersion === version;

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
        setSent(false);
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
      data-confirmed={confirmed && !sent ? "true" : "false"}
      data-sent={sent ? "true" : "false"}
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
        <div
          data-testid="a2ui-email-status"
          className="text-[13px] text-muted-foreground"
          aria-live="polite"
        >
          {sent ? t`Sent` : t`Needs approval`}
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            data-testid="a2ui-email-discard"
            disabled={busy || sent}
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
          {onSend ? (
            <Button
              type="button"
              data-testid="a2ui-email-send"
              disabled={busy || sent}
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
                    setSent(true);
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
      {error ? (
        <p data-testid="a2ui-email-error" role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {sent ? (
        <p data-testid="a2ui-email-sent" className="sr-only">
          {t`Sent`}
        </p>
      ) : null}
    </form>
  );
}

function FieldRow({
  id,
  testId,
  label,
  value,
  placeholder,
  autoComplete,
  onChange,
  onBlur,
}: {
  id: string;
  testId: string;
  label: string;
  value: string;
  placeholder?: string;
  autoComplete?: string;
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
        className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onBlur(event.currentTarget.value)}
      />
    </div>
  );
}
