import { useLingui } from "@lingui/react/macro";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@matebot/ui-web";
import { ChevronDown } from "lucide-react";

/**
 * Grok-style card approval menu (spec §6.6). Account RPCs only — never a thread
 * message, so a click cannot settle the card.
 */
export function CardApprovalMenu({
  recipient,
  draftsDisabled = false,
  onAllowRecipient,
  onDisableDrafts,
  onManageRules,
}: {
  recipient?: string;
  draftsDisabled?: boolean;
  onAllowRecipient?: (recipient: string) => void | Promise<void>;
  onDisableDrafts?: (disabled: boolean) => void | Promise<void>;
  onManageRules?: () => void;
}) {
  const { t } = useLingui();
  const mailbox = recipient?.trim();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        data-testid="a2ui-email-status"
        className="inline-flex items-center gap-1 text-[13px] text-muted-foreground"
        aria-live="polite"
      >
        {t`Needs approval`}
        <ChevronDown className="size-3.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {mailbox ? (
          <DropdownMenuItem
            data-testid="a2ui-email-allow-recipient"
            onClick={() => void onAllowRecipient?.(mailbox)}
          >
            {t`Allow this recipient`}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled data-testid="a2ui-email-approval-require">
          {t`Needs approval`}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="a2ui-email-disable-drafts"
          onClick={() => void onDisableDrafts?.(!draftsDisabled)}
        >
          {draftsDisabled ? t`Restore drafts` : t`Turn off drafts for this bot`}
        </DropdownMenuItem>
        {onManageRules ? (
          <DropdownMenuItem data-testid="a2ui-email-manage-rules" onClick={onManageRules}>
            {t`Manage rules`}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
