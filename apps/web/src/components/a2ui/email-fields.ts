export type EmailDraftFields = {
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
};

export type EmailFieldName = keyof EmailDraftFields;

export const EMAIL_DRAFT_FIELD_NAMES = ["from", "to", "cc", "subject", "body"] as const;

export const EMPTY_EMAIL_DRAFT: EmailDraftFields = {
  from: "",
  to: "",
  cc: "",
  subject: "",
  body: "",
};

export { isEmailComposeIntent } from "@matebot/core";

/** Read compose slots from a compiled surface data model. Missing fields stay empty. */
export function emailFieldsFromSurfaceMessages(messages: unknown[] | undefined): EmailDraftFields {
  if (!messages) return EMPTY_EMAIL_DRAFT;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const update = (message as { updateDataModel?: { value?: unknown } }).updateDataModel;
    const value = update?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const fields = (value as { fields?: unknown }).fields;
    if (!Array.isArray(fields)) continue;
    const read = (name: string) => {
      const field = fields.find(
        (entry) =>
          entry && typeof entry === "object" && (entry as { name?: unknown }).name === name,
      ) as { value?: unknown } | undefined;
      return typeof field?.value === "string" ? field.value : "";
    };
    return {
      from: read("from"),
      to: read("to"),
      cc: read("cc"),
      subject: read("subject"),
      body: read("body"),
    };
  }
  return EMPTY_EMAIL_DRAFT;
}
