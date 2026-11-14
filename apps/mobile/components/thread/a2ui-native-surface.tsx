import type { A2uiSurfaceBlock } from "@matebot/contracts";
import {
  cardKindForIntent,
  emailSurfacePhase,
  interactionCapabilityForIntent,
  needsRecovery,
  surfaceActionLabel,
  surfaceCardTitle,
  surfacePhase,
  surfaceReasonCopy,
  surfaceStaleHint,
  surfaceStatusCopy,
} from "@matebot/core";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { NativeCatalogNode } from "../../lib/a2ui-catalog";
import {
  emailFieldsFromSurfaceMessages,
  isEmailComposeIntent,
  parseNativeCatalog,
} from "../../lib/a2ui-catalog";
import { useI18n } from "../../lib/i18n";
import { surfaceCopy } from "../../lib/surface-copy";
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
  onManageRules,
  onAllowRecipient,
  onDisableDrafts,
  draftsDisabled,
  onRetry,
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
  onManageRules?: () => void;
  onAllowRecipient?: (recipient: string) => void | Promise<void>;
  onDisableDrafts?: (disabled: boolean) => void | Promise<void>;
  draftsDisabled?: boolean;
  onRetry?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<unknown[] | undefined>(messages);
  /**
   * Whether the stored document is still on its way, and whether it could not be read.
   *
   * Without these, an unresolved document is indistinguishable from one that has no
   * controls, and the card would announce itself as an old one while it is merely
   * loading — or forever, if the fetch fails.
   */
  const [loading, setLoading] = useState(Boolean(!messages && block.documentRef && fetchDocument));
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped to fetch again after a document could not be read. */
  const [attempt, setAttempt] = useState(0);
  const source = messages ?? loaded;
  /**
   * Whether "Try again" can do anything. A stored ref with no fetcher will never load,
   * so offering the button there would be a control that cannot change the outcome.
   */
  const canReload = Boolean(block.documentRef && fetchDocument);
  const [values, setValues] = useState<EmailFields>(() => emailFieldsFromSurfaceMessages(messages));
  const [error, setError] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mailbox, setMailbox] = useState(block.capability);
  const [localConfirmedVersion, setLocalConfirmedVersion] = useState<number | undefined>(
    block.confirmedVersion,
  );
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
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
    const fetchDocument = fetchRef.current;
    if (!fetchDocument) {
      // Nothing to fetch from this surface: not loading, and not an old card either.
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(null);
    void fetchDocument(block.documentRef)
      .then((next) => {
        if (!active) return;
        if (!next || next.length === 0) {
          setLoadError(t("This card could not be shown."));
          return;
        }
        setLoaded(next);
      })
      .catch(() => {
        if (!active) return;
        setLoadError(t("This card could not be shown."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [block.documentRef, messages, t, attempt]);

  const { affordance } = surfacePhase({
    intent: block.intent,
    ...(block.status ? { status: block.status } : {}),
    ...(block.template ? { template: block.template } : {}),
    ...(block.lifecycle ? { lifecycle: block.lifecycle } : {}),
    ...(mailbox ? { capability: mailbox } : {}),
  });
  if (affordance.terminal && cardKindForIntent(block.intent ?? "") !== "result") {
    const copy = surfaceStatusCopy({
      status: block.status ?? block.lifecycle ?? "succeeded",
    });
    return (
      <View testID="a2ui-native-folded" style={{ gap: 8, width: "100%", minWidth: 0 }}>
        <Text>{surfaceCopy(t, copy.titleKey)}</Text>
        {block.title ? <Text>{block.title}</Text> : null}
        {affordance.action === "retry" ? (
          <A2uiButton
            label={surfaceCopy(t, copy.actionKey ?? "action.retry")}
            testID="a2ui-surface-retry"
            onPress={() => {
              if (!onRetry || busy) return;
              setBusy(true);
              setError(null);
              void Promise.resolve(onRetry())
                .catch((err: unknown) =>
                  setError(err instanceof Error && err.message ? err.message : null),
                )
                .finally(() => setBusy(false));
            }}
          />
        ) : null}
        {error ? <Text testID="a2ui-email-error">{error}</Text> : null}
      </View>
    );
  }

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
    const emailCapability = block.intent ? interactionCapabilityForIntent(block.intent) : undefined;
    const heading = emailCapability
      ? surfaceCardTitle({ capability: emailCapability, title: block.title })
      : { title: block.title ?? t("Send email"), category: undefined };
    const title = heading.title;
    const actionLabel = emailCapability
      ? surfaceActionLabel({ capability: emailCapability, title: block.title })
      : undefined;
    // One rule shared with the web card. A finished card already folded above;
    // `action` is the one control this open sheet may still show.
    const { phase, affordance: emailAffordance } = emailSurfacePhase({
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
      ...(block.status ? { status: block.status } : {}),
    });
    const action = mailbox !== block.capability ? emailAffordance.action : affordance.action;
    if (discarded) {
      return (
        <View testID="a2ui-native-surface">
          <Text testID="a2ui-email-compose">{t("Discarded")}</Text>
        </View>
      );
    }
    return (
      <View
        testID="a2ui-native-surface"
        style={{ gap: 8, width: "100%", minWidth: 0, alignSelf: "stretch" }}
      >
        {heading.category ? <Text testID="a2ui-surface-category">{heading.category}</Text> : null}
        <Text testID="a2ui-surface-title">{title}</Text>
        {block.reasonKey ? (
          <Text testID="a2ui-surface-reason">
            {surfaceCopy(t, surfaceReasonCopy(block.reasonKey))}
          </Text>
        ) : null}
        {block.stale ? (
          <Text testID="a2ui-surface-stale-hint">{surfaceCopy(t, surfaceStaleHint())}</Text>
        ) : null}
        {phase === "action-progress-card" || phase === "action-submitting-card" ? (
          <Text testID="a2ui-email-progress">{t("Sending email")}</Text>
        ) : phase === "action-result-success" ? (
          <Text testID="a2ui-email-status">{t("Sent")}</Text>
        ) : phase === "action-result-failed" ? (
          <Text testID="a2ui-email-failed">{block.error ?? t("Could not send")}</Text>
        ) : phase === "action-reconcile-card" ? (
          <Text testID="a2ui-email-unknown">{t("Don't send again")}</Text>
        ) : phase === "email-reauth-card" || phase === "email-connection-card" ? (
          <Text testID="a2ui-email-status">
            {phase === "email-reauth-card" ? t("Authorization expired") : t("Not connected")}
          </Text>
        ) : (
          <View>
            <Pressable
              testID="a2ui-email-status"
              onPress={() => setApprovalMenuOpen((open) => !open)}
            >
              <Text>{t("Needs approval")}</Text>
            </Pressable>
            {approvalMenuOpen ? (
              <View>
                {values.to.trim() ? (
                  <A2uiButton
                    label={t("Allow this recipient")}
                    testID="a2ui-email-allow-recipient"
                    onPress={() => void onAllowRecipient?.(values.to.trim())}
                  />
                ) : null}
                <Text testID="a2ui-email-approval-require">{t("Needs approval")}</Text>
                <A2uiButton
                  label={draftsDisabled ? t("Restore drafts") : t("Turn off drafts for this bot")}
                  testID="a2ui-email-disable-drafts"
                  onPress={() => void onDisableDrafts?.(!draftsDisabled)}
                />
                {onManageRules ? (
                  <A2uiButton
                    label={t("Manage rules")}
                    testID="a2ui-email-manage-rules"
                    onPress={onManageRules}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        )}
        <A2uiSheet label={title}>
          {/*
            The sending mailbox is decided by the connected account, not by this form, so it is
            read-only here. It only appears when a mailbox is available, matching the web card:
            on a connection card, naming an account would contradict the card asking for one.
          */}
          {mailbox === "ready" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ fontSize: 13, opacity: 0.6 }}>{t("From")}</Text>
              <Text testID="a2ui-email-sender" style={{ fontSize: 15 }}>
                {block.senderAddress ?? block.senderLabel ?? t("Connected account")}
              </Text>
            </View>
          ) : null}
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
            multiline
            onChangeText={setField("body")}
          />
          {action === "none" ||
          phase === "action-progress-card" ||
          phase === "action-submitting-card" ? null : (
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
          {action === "connect" && mailboxNeedsConnect(mailbox) ? (
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
          ) : action === "check_status" ? (
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
          ) : action === "submit" ? (
            <A2uiButton
              label={actionLabel ?? t("Send")}
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
          ) : null}
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
        <Text>{t("This card could not be shown.")}</Text>
        {block.title ? <Text>{block.title}</Text> : null}
      </View>
    );
  }
  const catalogCapability = block.intent ? interactionCapabilityForIntent(block.intent) : undefined;
  const catalogHeading = catalogCapability
    ? surfaceCardTitle({ capability: catalogCapability, title: block.title })
    : { title: block.title, category: undefined };
  return (
    <View testID="a2ui-native-surface">
      {catalogHeading.category ? (
        <Text testID="a2ui-surface-category">{catalogHeading.category}</Text>
      ) : null}
      {catalogHeading.title ? (
        <Text testID="a2ui-surface-title">{catalogHeading.title}</Text>
      ) : null}
      {block.stale ? (
        <Text testID="a2ui-surface-stale-hint">{surfaceCopy(t, surfaceStaleHint())}</Text>
      ) : null}
      <A2uiCatalogNodes nodes={catalog.nodes} block={block} onAction={onAction} />
      {/*
        An early card stored a title and two lines of text, and nothing to press. The turn
        around it may still say "confirm in the card above", which nothing here can
        satisfy. It cannot grow the button that was never stored, so it says what is
        missing and offers a way forward — the same words web uses.
      */}
      {loading ? (
        <View testID="a2ui-native-loading">
          <Text>{t("Loading this card…")}</Text>
        </View>
      ) : loadError ? (
        <View testID="a2ui-native-load-error">
          <Text>{t("This card could not be shown.")}</Text>
          {canReload ? (
            <A2uiButton
              label={t("Try again")}
              testID="a2ui-native-reload"
              onPress={() => setAttempt((value) => value + 1)}
            />
          ) : null}
        </View>
      ) : needsRecovery(source, { intent: block.intent }) ? (
        <View testID="a2ui-native-recovery">
          <Text>
            {t(
              "This is an older card: it was saved before cards could be edited, so it has nothing to fill in or confirm.",
            )}
          </Text>
          <Text>{t("Ask for the draft again to get an editable card.")}</Text>
        </View>
      ) : source && source.length > 0 ? null : (
        /*
          Nothing arrived and nothing is coming: no stored document, no way to fetch it,
          or an empty one. A title over an empty body is the blank card the audit found,
          so the card says what happened and, when a ref exists, offers to load it again.
        */
        <View testID="a2ui-native-unavailable">
          <Text>{t("This card could not be shown.")}</Text>
          {canReload ? (
            <A2uiButton
              label={t("Try again")}
              testID="a2ui-native-reload"
              onPress={() => setAttempt((value) => value + 1)}
            />
          ) : null}
        </View>
      )}
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
