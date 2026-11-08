# Locating the conversation behind `/app/cmw3ccoycmat5g4eo037s2ta0`

## The id is a bot id, not a thread id

`apps/web/src/App.tsx:287` declares:

```tsx
<Route path="/app/:botId" element={<ShellPage />} />
```

That is the only `/app/<segment>` route besides `/app/g/:groupId` (a group) and the fixed
`/app/artifacts`, `/app/board`, `/app/x/:linkId`. So the last segment of the reported URL
is a **bot**, and a query that looked it up in `threads.id` matched nothing.

`threads.botId` is `@unique` (`packages/db/prisma/schema.prisma`), so a bot has exactly
one chat thread. `resolveThreadTarget` reads `bot.thread`, i.e. the thread whose `botId`
is that bot — the same relation, expressed once.

```text
bots.id  ←──unique──  threads."botId"
threads.id  ←──  messages."threadId"
threads.id  ←──  interactions."threadId"
interactions.id  ←──  interaction_surfaces."interactionId"
threads.id  ←──  events."threadId"
threads.id  ←──  runs."threadId"
```

## The one query to resolve it

Run as a superuser or the app role; it reads only ids, times and counts.

```sql
SELECT b.id AS bot_id,
       b.name,
       b."archivedAt" IS NOT NULL AS archived,
       t.id AS thread_id,
       t."createdAt" AS thread_created_at
FROM bots b
LEFT JOIN threads t ON t."botId" = b.id
WHERE b.id = 'cmw3ccoycmat5g4eo037s2ta0';
```

- **One row with a `thread_id`** → that is the conversation. Feed `thread_id` to the next
  section, or to `docs/architecture/diagnose-a2ui-card-readonly.sh`.
- **One row with `NULL thread_id`** → the bot exists but its chat was never created or was
  removed; the card cannot be in this database.
- **No rows** → this database did not serve that page. Check which database
  `app.matebot.dev` is bound to before concluding anything about the card.

`b.name` is included because it is the only way to confirm you found the right bot without
reading message bodies. It is a label the person wrote, not conversation content — drop
that column if even that is too much for the evidence record.

## Then, the card itself

`docs/architecture/diagnose-a2ui-card-readonly.sh <botId> [database-url]` does that
lookup and everything after it in one read-only pass: the thread, the stored
`a2ui_surface` blocks (count and ids only), the interactions, the surface documents
(length and array length only — never the document), the publish and tool events around
it, and the runs.

Every statement in it was executed against a database with these tables before being
written down; the column names match the `schemaEvidence` in the t275 report
(`completedAt` on `runs`, lowercase tables, `document` as a jsonb array).

## What each layer can and cannot prove

| Question | Answered by | Limit |
|---|---|---|
| Was a card block stored on a message? | `messages.blocks` where `kind = 'a2ui_surface'` | Absence means this database never stored it — not that the turn never ran |
| Was the document non-empty? | `jsonb_array_length(document)`, `length(document::text)` | Non-empty does not mean it had controls; that is what `surfaceAffordances` decides |
| Was the client told to draw it? | `events` of type `thread.surface.created` / `.updated` | **An event row proves the server recorded the send, not that an SSE frame reached a browser** |
| Did the browser receive it? | Only a browser can say | Not answerable from this database |
| Did it render? | Only a browser can say, and only with the client flag resolved | Not answerable from this database |

So a row-perfect database result still leaves delivery and rendering as unknown. The
opposite also holds: the client gate bug proved earlier is a client defect and says
nothing about whether this database has the card.
