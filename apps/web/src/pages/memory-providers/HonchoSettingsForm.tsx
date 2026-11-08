import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldLabel, Input } from "@matebot/ui-web";
import { useId, useState } from "react";
import type { ConnectionMode } from "./ConnectionModeFields";
import { ConnectionModeFields } from "./ConnectionModeFields";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{0,512}$/;
/**
 * Peers Matebot writes to, so they cannot be chosen as the user's own.
 *
 * `rakazo-shared` is the identifier earlier releases of this product already created in the
 * memory provider. It keeps its spelling because the peer exists out there under that name:
 * renaming the check would let a user select a peer this app writes to. The name is an
 * interoperability detail, not this product's name, which is why the message below explains
 * it rather than presenting it as one.
 */
const LEGACY_SHARED_PEER_ID = "rakazo-shared";
function isReservedPeerId(value: string): boolean {
  return value === LEGACY_SHARED_PEER_ID || value.startsWith("bot-");
}

export function HonchoSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const apiKeyId = useId();
  const workspaceId = useId();
  const workspaceErrorId = useId();
  const [mode, setMode] = useState<ConnectionMode>("cloud");
  const [baseUrl, setBaseUrl] = useState("");
  const userPeerId = useId();
  const userPeerErrorId = useId();
  const userPeerDescriptionId = useId();
  const [userPeer, setUserPeer] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState("");
  const workspaceValid = RESOURCE_ID_PATTERN.test(workspace.trim());
  const showUserPeer = workspace.trim().length > 0;
  const userPeerFormatValid = RESOURCE_ID_PATTERN.test(userPeer.trim());
  const userPeerReserved = isReservedPeerId(userPeer.trim());
  const userPeerValid = !showUserPeer || (userPeerFormatValid && !userPeerReserved);
  const ready =
    apiKey.trim().length >= 8 &&
    workspaceValid &&
    userPeerValid &&
    (mode === "cloud" || Boolean(baseUrl.trim()));

  async function connect() {
    if (!ready) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        ...(mode === "local" ? { mode, baseUrl: baseUrl.trim() } : {}),
        ...(showUserPeer && userPeer.trim() ? { userPeerId: userPeer.trim() } : {}),
        ...(workspace.trim() ? { workspaceId: workspace.trim() } : {}),
      },
      credentials: { apiKey: apiKey.trim() },
    };
    if (await onConnect(draft)) setApiKey("");
  }

  return (
    <>
      <ConnectionModeFields
        busy={busy}
        mode={mode}
        onModeChange={setMode}
        baseUrl={baseUrl}
        onBaseUrlChange={setBaseUrl}
      />

      <Field className="mt-4">
        <FieldLabel htmlFor={apiKeyId}>
          <Trans>API key</Trans>
        </FieldLabel>
        <Input
          id={apiKeyId}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={mode === "cloud" ? "hch-…" : undefined}
          type="password"
          autoComplete="new-password"
          maxLength={4096}
        />
      </Field>

      <Field className="mt-4" data-invalid={workspaceValid ? undefined : true}>
        <FieldLabel htmlFor={workspaceId}>
          <Trans>Workspace</Trans>
        </FieldLabel>
        <Input
          id={workspaceId}
          value={workspace}
          disabled={busy}
          aria-invalid={workspaceValid ? undefined : true}
          aria-describedby={workspaceValid ? undefined : workspaceErrorId}
          onChange={(event) => setWorkspace(event.target.value)}
          placeholder="team-notes"
          maxLength={512}
          autoComplete="off"
        />
        {!workspaceValid ? (
          <FieldError id={workspaceErrorId}>
            <Trans>Use up to 512 letters, digits, _ or -.</Trans>
          </FieldError>
        ) : null}
      </Field>

      {showUserPeer ? (
        <Field className="mt-4" data-invalid={userPeerValid ? undefined : true}>
          <FieldLabel htmlFor={userPeerId}>
            <Trans>User peer</Trans>
          </FieldLabel>
          <Input
            id={userPeerId}
            value={userPeer}
            disabled={busy}
            aria-invalid={userPeerValid ? undefined : true}
            aria-describedby={
              userPeerValid ? userPeerDescriptionId : `${userPeerDescriptionId} ${userPeerErrorId}`
            }
            onChange={(event) => setUserPeer(event.target.value)}
            maxLength={512}
            autoComplete="off"
          />
          <p id={userPeerDescriptionId} className="mt-2 text-[13px] text-muted-foreground">
            <Trans>An existing Honcho peer to read from. Matebot never writes to it.</Trans>
          </p>
          {!userPeerValid ? (
            <FieldError id={userPeerErrorId}>
              {userPeerFormatValid ? (
                <Trans>Names starting with bot- are reserved for Matebot.</Trans>
              ) : (
                <Trans>Use up to 512 letters, digits, _ or -.</Trans>
              )}
            </FieldError>
          ) : null}
        </Field>
      ) : null}

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || !ready}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
