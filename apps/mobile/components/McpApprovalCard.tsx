import type { MessageBlock } from "@matebot/contracts";
import { l0aHostInteractive, mcpConnectionVerdict } from "@matebot/core";
import { typeScale } from "@matebot/ui-tokens";
import { useEffect, useState } from "react";
import type { ViewProps } from "react-native";
import { Alert, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  badge: { alignItems: "center", borderRadius: 8, height: 28, justifyContent: "center", width: 28 },
  badgeText: { fontSize: 12, fontWeight: "600" },
  card: {
    maxWidth: 576,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
  },
  description: { ...typeScale.secondary, opacity: 0.75 },
  header: { alignItems: "center", flexDirection: "row", gap: 12 },
  headline: { flex: 1, gap: 2 },
  summary: typeScale.caption,
  title: typeScale.cardTitle,
});

export function McpApprovalCard({
  botId,
  threadId,
  block,
  accessibilityActions,
  onAccessibilityAction,
}: {
  botId: string;
  threadId?: string;
  block: Extract<MessageBlock, { kind: "mcp_approval" }>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const readOnly = useThreadReadOnly();
  const tokens = useMobileTokens();
  const [localStatus, setLocalStatus] = useState<"pending" | "connected" | "dismissed">("pending");
  const [pendingAction, setPendingAction] = useState<"approve" | "dismiss" | null>(null);
  /** The server's own last discovery outcome; approval alone is not health. */
  const [health, setHealth] = useState<{
    status: "unknown" | "installing" | "ok" | "error";
    message: string | null;
  } | null>(null);
  useEffect(() => {
    if (block.status === "connected" || block.status === "dismissed") return;
    setLocalStatus((current) =>
      current === "connected" || current === "dismissed" ? "pending" : current,
    );
  }, [block.status]);
  const status = block.status && block.status !== "pending" ? block.status : localStatus;
  const interactive = l0aHostInteractive(block);
  const summary = block.endpoint ?? `stdio (${block.transport})`;

  async function submit(action: "approve" | "dismiss") {
    if (readOnly || !interactive || status !== "pending" || pendingAction !== null) return;
    setPendingAction(action);
    try {
      if (action === "approve") {
        await rpc("mcp/assignments/approve", { botId, serverId: block.serverId, threadId });
      } else {
        await rpc("mcp/assignments/dismiss", { botId, serverId: block.serverId, threadId });
      }
      setLocalStatus(action === "approve" ? "connected" : "dismissed");
      if (action === "approve") {
        // Approval is recorded; the card still reports what the server actually did.
        void Promise.resolve()
          .then(() => rpc("mcp/servers/list", {}))
          .then((servers) => {
            const row = (
              servers as Array<{
                id: string;
                health?: {
                  status: "unknown" | "installing" | "ok" | "error";
                  message: string | null;
                };
              }>
            ).find((server) => server.id === block.serverId);
            if (row?.health) setHealth(row.health);
          })
          .catch(() => undefined);
      }
    } catch (reason) {
      Alert.alert(
        action === "approve" ? t("Could not approve this server") : t("Could not complete action"),
        errorText(reason, t("Please try again.")),
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <View
      accessibilityLabel={t("Connect MCP server {name}", { name: block.name })}
      style={[styles.card, { backgroundColor: native.fill }]}
    >
      <View style={styles.header}>
        <View style={[styles.badge, { backgroundColor: native.fillPressed }]}>
          <Text style={[styles.badgeText, { color: tokens.foreground }]}>M</Text>
        </View>
        <View style={styles.headline}>
          <Text
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            style={[styles.title, { color: tokens.foreground }]}
          >
            {t("Connect MCP server {name}", { name: block.name })}
          </Text>
          <Text style={[styles.summary, { color: tokens.mutedForeground }]} numberOfLines={2}>
            {summary}
          </Text>
        </View>
      </View>
      {status !== "pending" ? (
        <Text
          style={{
            color:
              status === "connected" &&
              mcpConnectionVerdict({ approved: true, health: health ?? undefined }).working
                ? tokens.success
                : tokens.mutedForeground,
            ...typeScale.secondary,
          }}
        >
          {status === "connected"
            ? (() => {
                const verdict = mcpConnectionVerdict({
                  approved: true,
                  health: health ?? undefined,
                });
                if (verdict.state === "connected") return t("Connected.");
                if (verdict.detail)
                  return t("Approved, not connected yet: {reason}", { reason: verdict.detail });
                return t("Approved, not connected yet.");
              })()
            : t("Dismissed. Reconnect anytime from MCP settings.")}
        </Text>
      ) : !readOnly && interactive ? (
        <>
          <Text style={[styles.description, { color: tokens.foreground }]}>
            {block.needsOAuth
              ? t("Finish MCP authorization in the web app.")
              : t("Approve this server to let your agent use its tools.")}
          </Text>
          <View style={styles.actions}>
            {!block.needsOAuth ? (
              <NativeActionButton
                label={t("Approve")}
                fill={false}
                disabled={pendingAction !== null}
                onPress={() => void submit("approve")}
              />
            ) : null}
            <NativeActionButton
              label={t("Not now")}
              prominence="secondary"
              disabled={pendingAction !== null}
              onPress={() => void submit("dismiss")}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}
