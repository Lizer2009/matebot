import type { A2uiSurfaceBlock } from "@matebot/contracts";
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

type EmailFields = { to: string; subject: string; body: string };
type EmailFieldName = keyof EmailFields;

export function A2uiNativeSurface({
  block,
  messages,
  fetchDocument,
  onFieldChange,
  onConfirm,
  onSend,
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
  onSend?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<unknown[] | undefined>(messages);
  const source = messages ?? loaded;
  const [values, setValues] = useState<EmailFields>(() => emailFieldsFromSurfaceMessages(messages));
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
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
        if (next !== versionRef.current) setSent(false);
        versionRef.current = next;
        return next;
      } catch (err) {
        committed.current = { ...committed.current, [name]: previous };
        throw err;
      }
    }
    async function flush(): Promise<number> {
      let next = versionRef.current;
      for (const name of ["to", "subject", "body"] as const) next = await commit(name);
      return next;
    }
    function messageOf(err: unknown): string {
      return err instanceof Error && err.message ? err.message : t("Could not update the draft");
    }
    const title = block.title ?? t("Send email");
    return (
      <View testID="a2ui-native-surface" style={{ gap: 8 }}>
        <Text>{title}</Text>
        <A2uiSheet label={title}>
          <A2uiTextField
            label={t("To")}
            value={values.to}
            testID="a2ui-email-to"
            onChangeText={setField("to")}
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
          <A2uiButton
            label={t("Confirm")}
            testID="a2ui-email-confirm"
            onPress={() => {
              setError(null);
              void flush()
                .then((next) => onConfirm?.(next))
                .catch((err: unknown) => setError(messageOf(err)));
            }}
          />
          <A2uiButton
            label={t("Send")}
            testID="a2ui-email-send"
            onPress={() => {
              setError(null);
              void flush()
                .then(async (next) => {
                  if (block.confirmedVersion !== next) {
                    setError(t("Confirm this draft before sending."));
                    return;
                  }
                  await onSend?.();
                  setSent(true);
                })
                .catch((err: unknown) => setError(messageOf(err)));
            }}
          />
        </A2uiSheet>
        {error ? <Text testID="a2ui-email-error">{error}</Text> : null}
        {sent ? <Text testID="a2ui-email-sent">{t("Sent")}</Text> : null}
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
      <A2uiCatalogNodes nodes={catalog.nodes} />
    </View>
  );
}

function A2uiCatalogNodes({ nodes }: { nodes: NativeCatalogNode[] }) {
  return (
    <View>
      {nodes.map((node, index) => (
        <A2uiCatalogNode key={`${node.type}-${index}`} node={node} />
      ))}
    </View>
  );
}

function A2uiCatalogNode({ node }: { node: NativeCatalogNode }) {
  const { t } = useI18n();
  if (node.type === "Text") return <Text>{node.text}</Text>;
  if (node.type === "Column") return <A2uiCatalogNodes nodes={node.children} />;
  if (node.type === "Sheet") {
    return (
      <A2uiSheet label={node.title ?? t("Open")}>
        {node.title ? <Text>{node.title}</Text> : null}
        <A2uiCatalogNodes nodes={node.children} />
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
      onPress={() => undefined}
    />
  );
}
