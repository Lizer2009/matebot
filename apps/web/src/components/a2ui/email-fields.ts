export type EmailDraftFields = {
  to: string;
  subject: string;
  body: string;
};

export const EMPTY_EMAIL_DRAFT: EmailDraftFields = { to: "", subject: "", body: "" };

export function isEmailComposeIntent(intent: string | undefined): boolean {
  return intent === "email.compose" || intent === "email.send";
}

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
    return { to: read("to"), subject: read("subject"), body: read("body") };
  }
  return EMPTY_EMAIL_DRAFT;
}
