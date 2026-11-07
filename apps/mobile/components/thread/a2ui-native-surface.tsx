import type { A2uiSurfaceBlock } from "@matebot/contracts";
import { emailSurfacePhase } from "@matebot/core";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { NativeCatalogNode } from "../../lib/a2ui-catalog";
import {
  emailFieldsFromSurfaceMessages,
  isEmailComposeIntent,
  parseNativeCatalog,
} from "../../lib/a2ui-catalog";
import { useI18n } from "../../lib/i18n";
import { A2uiButton, A2uiSheet, A2uiTextField } from "./a2ui-native-controls";

type EmailFields = { from: string; to: string; cc: string; subject: string; body: string };
type EmailFieldName = keyof EmailFields;

const EMAIL_FIELD_NAMES = ["from", "to", "cc", "subject", "body"] as const;

function mailboxNeedsConnect(
  capability: A2uiSurfaceBlock["capability"],
): capability is "not_connected" | "requires_reauth" {
  return capability === "not_connected" || capability === "requires_reauth";
}

export function A2uiNativeSurface({
  block,
  messages,
  fetchDocument,
  onFieldChange,
  onConfirm,
  onSend,
  onConnect,
  onCheckStatus,
  onAction,
  onDiscard,
}: {
  block: A2uiSurfaceBlock;
  messages?: unknown[];
  fetchDocument?: (documentRef: string) => Promise<unknown[] | undefined>;
  onFieldChange?: (
    name: EmailFieldName,
    value: string,
    expectedDraftVersion: number,
  ) => Promise<{ draftVersion: number } | undefined>;
  onConfirm?: (draftVersion: number) => Promise<void>;
  onSend?: (draftVersion: number) => Promise<void>;
  onConnect?: () => Promise<void>;
  onCheckStatus?: () => Promise<void>;
  /** The same bridge the web card uses, so a native button can submit too. */
  onAction?: (action: {
    name: string;
    surfaceId: string;
    sourceComponentId: string;
    timestamp: string;
    context: Record<string, unknown>;
  }) => void | Promise<void>;
  onDiscard?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<unknown[] | undefined>(messages);
  const source = messages ?? loaded;
  const [values, setValues] = useState<EmailFields>(() => emailFieldsFromSurfaceMessages(messages));
  const [error, setError] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mailbox, setMailbox] = useState(block.capability);
  const [localConfirmedVersion, setLocalConfirmedVersion] = useState<number | undefined>(
    block.confirmedVersion,
  );
  const valuesRef = useRef(values);
  const versionRef = useRef(block.draftVersion);
  const committed = useRef(values);
  const dirty = useRef(false);
  const fetchRef = useRef(fetchDocument);
  valuesRef.current = values;
  fetchRef.current = fetchDocument;

  useEffect(() => {
    if (dirty.current) return;
    const next = emailFieldsFromSurfaceMessages(source);
    setValues(next);
    committed.current = next;
    versionRef.current = block.draftVersion;
  }, [source, block.draftVersion]);

  useEffect(() => {
    setLocalConfirmedVersion(block.confirmedVersion);
  }, [block.confirmedVersion]);

  useEffect(() => {
    setMailbox(block.capability);
  }, [block.capability]);

  useEffect(() => {
    if (messages || !block.documentRef) return;
    let active = true;
    void fetchRef.current?.(block.documentRef).then((next) => {
      if (!active || !next) return;
      setLoaded(next);
    });
    return () => {
      active = false;
    };
  }, [block.documentRef, messages]);

  if (isEmailComposeIntent(block.intent)) {
    const setField = (name: EmailFieldName) => (value: string) => {
      const nextValues = { ...valuesRef.current, [name]: value };
      valuesRef.current = nextValues;
      if (value !== committed.current[name]) dirty.current = true;
      setValues(nextValues);
    };
    async function commit(name: EmailFieldName): Promise<number> {
      const value = valuesRef.current[name];
      if (value === committed.current[name] || !onFieldChange) return versionRef.current;
      const previous = committed.current[name];
      committed.current = { ...committed.current, [name]: value };
      try {
        const result = await onFieldChange(name, value, versionRef.current);
        const next = result?.draftVersion ?? versionRef.current + 1;
        if (next !== versionRef.current) {
          setLocalConfirmedVersion(undefined);
        }
        versionRef.current = next;
        return next;
      } catch (err) {
        committed.current = { ...committed.current, [name]: previous };
        throw err;
      }
    }
    async function flush(): Promise<number> {
      let next = versionRef.current;
      for (const name of EMAIL_FIELD_NAMES) next = await commit(name);
      return next;
    }
    function messageOf(err: unknown): string {
      return err instanceof Error && err.message ? err.message : t("Could not update the draft");
    }
    const effectiveConfirmed = localConfirmedVersion ?? block.confirmedVersion;
    const title = block.title ?? t("Send email");
    // One rule shared with the web card; see emailSurfacePhase in @matebot/core.
    const { phase } = emailSurfacePhase({
      template:
        mailbox === "ready" &&
        (block.template === "email-connection-card" || block.template === "email-reauth-card")
          ? undefined
          : block.template,
      lifecycle: block.lifecycle,
      capability: mailbox,
      intent: block.intent,
      error: block.error,
      busy,
    });
    if (discarded) {
      return (
        <View testID="a2ui-native-surface">
          <Text testID="a2ui-email-compose">{t("Discarded")}</Text>
        </View>
      );
    }
    return (
      <View testID="a2ui-native-surface" style={{ gap: 8 }}>
        <Text>{title}</Text>
        <Text
          testID={
            phase === "action-progress-card" || phase === "action-submitting-card"
              ? "a2ui-email-progress"
              : phase === "action-result-failed"
                ? "a2ui-email-failed"
                : phase === "action-reconcile-card"
                  ? "a2ui-email-unknown"
                  : "a2ui-email-status"
          }
        >
          {phase === "action-progress-card" || phase === "action-submitting-card"
            ? t("Sending")
            : phase === "action-result-success"
              ? t("Sent")
              : phase === "action-result-failed"
                ? (block.error ?? t("Could not send"))
                : phase === "action-reconcile-card"
                  ? t("Don't send again")
                  : phase === "email-reauth-card"
                    ? t("Authorization expired")
                    : phase === "email-connection-card"
                      ? t("Not connected")
                      : t("Needs approval")}
        </Text>
        {phase === "action-result-success" && block.providerMessageId ? (
          <Text testID="a2ui-email-provider-id">{block.providerMessageId}</Text>
        ) : null}
        <A2uiSheet label={title}>
          <A2uiTextField
            label={t("From")}
            value={values.from}
            testID="a2ui-email-from"
            onChangeText={setField("from")}
          />
          <A2uiTextField
            label={t("To")}
            value={values.to}
            testID="a2ui-email-to"
            onChangeText={setField("to")}
          />
          <A2uiTextField
            label={t("CC")}
            value={values.cc}
            testID="a2ui-email-cc"
            onChangeText={setField("cc")}
          />
          <A2uiTextField
            label={t("Subject")}
            value={values.subject}
            testID="a2ui-email-subject"
            onChangeText={setField("subject")}
          />
          <A2uiTextField
            label={t("Message")}
            value={values.body}
            testID="a2ui-email-body"
            onChangeText={setField("body")}
          />
          {phase === "action-progress-card" ||
          phase === "action-submitting-card" ||
          phase === "action-result-success" ? null : (
            <A2uiButton
              label={t("Discard")}
              testID="a2ui-email-discard"
              onPress={() => {
                setError(null);
                void Promise.resolve(onDiscard?.())
                  .then(() => setDiscarded(true))
                  .catch((err: unknown) => setError(messageOf(err)));
              }}
            />
          )}
          {phase === "action-progress-card" ||
          phase === "action-submitting-card" ? null : mailboxNeedsConnect(mailbox) &&
            (phase === "email-connection-card" || phase === "email-reauth-card") ? (
            <A2uiButton
              label={mailbox === "requires_reauth" ? t("Reconnect") : t("Connect email")}
              testID={mailbox === "requires_reauth" ? "a2ui-email-reauth" : "a2ui-email-connect"}
              onPress={() => {
                if (!onConnect) return;
                setError(null);
                void onConnect()
                  .then(() => setMailbox("ready"))
                  .catch((err: unknown) => setError(messageOf(err)));
              }}
            />
          ) : phase === "action-result-failed" ? (
            <A2uiButton
              label={t("Retry")}
              testID="a2ui-email-retry"
              onPress={() => {
                if (busy) return;
                setBusy(true);
                setError(null);
                void Promise.resolve(onSend?.(versionRef.current))
                  .catch((err: unknown) => setError(messageOf(err)))
                  .finally(() => setBusy(false));
              }}
            />
          ) : phase === "action-reconcile-card" ? (
            <A2uiButton
              label={t("Check status")}
              testID="a2ui-email-check-status"
              onPress={() => {
                if (!onCheckStatus || busy) return;
                setBusy(true);
                setError(null);
                void onCheckStatus()
                  .catch((err: unknown) => setError(messageOf(err)))
                  .finally(() => setBusy(false));
              }}
            />
          ) : phase === "action-result-success" ? null : (
            <A2uiButton
              label={t("Send")}
              testID="a2ui-email-send"
              onPress={() => {
                if (busy) return;
                setBusy(true);
                setError(null);
                void flush()
                  .then(async (next) => {
                    if (effectiveConfirmed !== next) {
                      if (!onConfirm) {
                        setError(t("Confirm this draft before sending."));
                        return;
                      }
                      await onConfirm(next);
                      setLocalConfirmedVersion(next);
                    }
                    await onSend?.(next);
                  })
                  .catch((err: unknown) => setError(messageOf(err)))
                  .finally(() => setBusy(false));
              }}
            />
          )}
        </A2uiSheet>
        {error ? <Text testID="a2ui-email-error">{error}</Text> : null}
        {phase === "action-result-success" ? (
          <Text testID="a2ui-email-sent">{t("Sent")}</Text>
        ) : null}
      </View>
    );
  }

  const catalog = parseNativeCatalog(source);
  if (!catalog.ok) {
    return (
      <View testID="a2ui-native-refused">
        <Text>{catalog.component}</Text>
      </View>
    );
  }
  return (
    <View testID="a2ui-native-surface">
      {block.title ? <Text>{block.title}</Text> : null}
      <A2uiCatalogNodes nodes={catalog.nodes} block={block} onAction={onAction} />
    </View>
  );
}

type NativeActionHandler = NonNullable<Parameters<typeof A2uiNativeSurface>[0]["onAction"]>;

function A2uiCatalogNodes({
  nodes,
  block,
  onAction,
}: {
  nodes: NativeCatalogNode[];
  block: A2uiSurfaceBlock;
  onAction?: NativeActionHandler;
}) {
  return (
    <View>
      {nodes.map((node, index) => (
        <A2uiCatalogNode
          key={`${node.type}-${index}`}
          node={node}
          block={block}
          onAction={onAction}
        />
      ))}
    </View>
  );
}

function A2uiCatalogNode({
  node,
  block,
  onAction,
}: {
  node: NativeCatalogNode;
  block: A2uiSurfaceBlock;
  onAction?: NativeActionHandler;
}) {
  const { t } = useI18n();
  if (node.type === "Text") return <Text>{node.text}</Text>;
  if (node.type === "Column") {
    return <A2uiCatalogNodes nodes={node.children} block={block} onAction={onAction} />;
  }
  if (node.type === "Row") {
    // A table header or data row: stacked so a wide table stays readable on a phone.
    return (
      <View style={{ gap: 2 }}>
        <A2uiCatalogNodes nodes={node.children} block={block} onAction={onAction} />
      </View>
    );
  }
  if (node.type === "Sheet") {
    return (
      <A2uiSheet label={node.title ?? t("Open")}>
        {node.title ? <Text>{node.title}</Text> : null}
        <A2uiCatalogNodes nodes={node.children} block={block} onAction={onAction} />
      </A2uiSheet>
    );
  }
  if (node.type === "TextField") {
    return (
      <A2uiTextField
        label={node.label}
        value={node.value}
        testID={`a2ui-native-field-${node.id}`}
        onChangeText={() => undefined}
      />
    );
  }
  return (
    <A2uiButton
      label={node.label}
      testID={`a2ui-native-button-${node.id}`}
      onPress={() => {
        // Only a button whose action resolved can submit. An unresolved
        // binding leaves it inert rather than submitting the wrong draft.
        const action = node.action;
        if (!onAction || !action) return;
        void onAction({
          name: action.name,
          surfaceId: block.surfaceId,
          sourceComponentId: node.id,
          timestamp: new Date().toISOString(),
          context: {
            ...(action.interactionId ? { interactionId: action.interactionId } : {}),
            ...(action.revision !== undefined ? { revision: action.revision } : {}),
          },
        });
      }}
    />
  );
}
