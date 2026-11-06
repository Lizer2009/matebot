import { useLingui } from "@lingui/react/macro";
import { Button, Input, Textarea } from "@matebot/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import type { EmailDraftFields } from "./email-fields";

type EmailFieldName = keyof EmailDraftFields;

export function EmailComposeEditor({
  draftVersion,
  confirmedVersion,
  fields,
  onFieldChange,
  onConfirm,
  onSend,
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
}) {
  const { t } = useLingui();
  const toId = useId();
  const subjectId = useId();
  const bodyId = useId();
  const [values, setValues] = useState(fields);
  const [version, setVersion] = useState(draftVersion);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
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
  }, [draftVersion, fields.to, fields.subject, fields.body]);

  const confirmed = confirmedVersion != null && confirmedVersion === version;

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
    for (const name of ["to", "subject", "body"] as const) {
      next = await commit(name);
    }
    return next;
  }

  function messageOf(err: unknown): string {
    return err instanceof Error && err.message ? err.message : t`Could not update the draft`;
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
      <div className="grid gap-1">
        <label htmlFor={toId} className="text-[13px] text-muted-foreground">
          {t`To`}
        </label>
        <Input
          id={toId}
          data-testid="a2ui-email-to"
          value={values.to}
          autoComplete="email"
          onChange={(event) => setValues((current) => ({ ...current, to: event.target.value }))}
          onBlur={(event) => {
            void commit("to", event.currentTarget.value).catch((err: unknown) =>
              setError(messageOf(err)),
            );
          }}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={subjectId} className="text-[13px] text-muted-foreground">
          {t`Subject`}
        </label>
        <Input
          id={subjectId}
          data-testid="a2ui-email-subject"
          value={values.subject}
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
      <div className="grid gap-1">
        <label htmlFor={bodyId} className="text-[13px] text-muted-foreground">
          {t`Message`}
        </label>
        <Textarea
          id={bodyId}
          data-testid="a2ui-email-body"
          value={values.body}
          rows={4}
          onChange={(event) => setValues((current) => ({ ...current, body: event.target.value }))}
          onBlur={(event) => {
            void commit("body", event.currentTarget.value).catch((err: unknown) =>
              setError(messageOf(err)),
            );
          }}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          data-testid="a2ui-email-confirm"
          disabled={busy || !onConfirm}
          onClick={() => {
            setBusy(true);
            setError(null);
            void flush()
              .then((next) => onConfirm?.(next))
              .catch((err: unknown) => setError(messageOf(err)))
              .finally(() => setBusy(false));
          }}
        >
          {t`Confirm`}
        </Button>
        {onSend ? (
          <Button
            type="button"
            variant="outline"
            data-testid="a2ui-email-send"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void flush()
                .then(async (next) => {
                  if (confirmedVersion !== next) {
                    setError(t`Confirm this draft before sending.`);
                    return;
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
      {error ? (
        <p data-testid="a2ui-email-error" role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {sent ? (
        <p data-testid="a2ui-email-sent" className="text-[13px] text-muted-foreground">
          {t`Sent`}
        </p>
      ) : null}
    </form>
  );
}
