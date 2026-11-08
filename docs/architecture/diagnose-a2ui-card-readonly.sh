#!/usr/bin/env bash
# Read-only evidence for one bot's chat, for the card that did not render.
#
# Every table, column and join below was confirmed against the deployment's own schema
# (pg_catalog, `public` schema, lowercase table names). Nothing here is guessed.
#
#   bash diagnose-a2ui-card-readonly.sh <botId> [database-url]
#
# WHERE THE ID COMES FROM — read this before running.
#
#   The web route is `/app/:botId` (`apps/web/src/App.tsx`). The last segment of
#   `https://app.matebot.dev/app/cmw3ccoycmat5g4eo037s2ta0` is therefore a **bot id**, not
#   a thread id. Passing it as a thread id returns nothing, which is exactly what one
#   earlier run did; that empty result is not evidence that a card was never stored.
#
#   A bot's chat thread is `threads.botId = bots.id` (`resolveThreadTarget` in
#   `apps/api/src/thread-target.ts` reads `bot.thread`, i.e. the thread whose `botId` is
#   that bot). So this script starts from the bot and follows that relation itself.
#
# Read-only: every statement is a SELECT, the session is REPEATABLE READ READ ONLY, and
# no value that could carry a person's text is printed — only ids, enums, timestamps,
# counts, and lengths.
set -euo pipefail

BOT_ID="${1:?usage: diagnose-a2ui-card-readonly.sh <botId> [database-url]}"
DATABASE_URL="${2:-${DATABASE_URL:-}}"
[[ -n "$DATABASE_URL" ]] || {
  echo "Set DATABASE_URL or pass the connection string as the second argument." >&2
  exit 2
}

# One session, read-only, with the id bound as a psql variable. `-v` avoids quoting the
# value into SQL text; every statement below uses :'bot' so an id with a quote in it is
# still just data.
psql "$DATABASE_URL" -X -q -A -F $'\t' \
  -v ON_ERROR_STOP=1 \
  -v bot="$BOT_ID" \
  -c "begin transaction isolation level repeatable read read only;" \
  -c "set local statement_timeout = '8s';" \
  -c "set local lock_timeout = '1s';" \
  -c "
select 'resolved_bot' as what,
       b.id as bot_id,
       b.\"spaceId\" as space_id,
       b.\"archivedAt\" is not null as archived,
       t.id as thread_id,
       t.\"createdAt\" as thread_created_at,
       t.\"nextMessageSeq\" as next_message_seq,
       t.\"nextEventSeq\" as next_event_seq
  from bots b
  left join threads t on t.\"botId\" = b.id
 where b.id = :'bot'
" \
  -c "
-- The bot is resolved first; these all key off it rather than off the raw argument, so a
-- wrong id produces no rows anywhere instead of scattered partial matches.
select 'message_surface_blocks' as what,
       m.id as message_id,
       m.seq,
       m.\"runId\" as run_id,
       m.\"createdAt\" as created_at,
       (select count(*) from jsonb_array_elements(m.blocks) b
          where b->>'kind' = 'a2ui_surface') as surface_blocks,
       (select count(*) from jsonb_array_elements(m.blocks) b
          where b->>'kind' = 'a2ui_surface' and (b ? 'documentRef')) as with_document_ref,
       (select string_agg(distinct b->>'interactionId', ',') from jsonb_array_elements(m.blocks) b
          where b->>'kind' = 'a2ui_surface') as interaction_ids,
       (select string_agg(distinct b->>'surfaceId', ',') from jsonb_array_elements(m.blocks) b
          where b->>'kind' = 'a2ui_surface') as surface_ids,
       (select string_agg(distinct b->>'protocolFamily', ',') from jsonb_array_elements(m.blocks) b
          where b->>'kind' = 'a2ui_surface') as protocol_families,
       (select string_agg(distinct b->>'draftVersion', ',') from jsonb_array_elements(m.blocks) b
          where b->>'kind' = 'a2ui_surface') as draft_versions
  from messages m
  join threads t on t.id = m.\"threadId\"
 where t.\"botId\" = :'bot'
   and exists (select 1 from jsonb_array_elements(m.blocks) b where b->>'kind' = 'a2ui_surface')
 order by m.seq
" \
  -c "
select 'interactions' as what,
       i.id as interaction_id, i.intent, i.status,
       i.\"draftVersion\" as draft_version,
       i.\"confirmedVersion\" as confirmed_version,
       i.\"messageId\" as message_id, i.\"runId\" as run_id,
       i.\"createdAt\" as created_at
  from interactions i
  join threads t on t.id = i.\"threadId\"
 where t.\"botId\" = :'bot'
 order by i.\"createdAt\"
" \
  -c "
-- Length and counts only. The document can hold the person's own field values, so it is
-- never printed.
select 'surfaces' as what,
       s.\"interactionId\" as interaction_id, s.\"surfaceId\" as surface_id,
       s.\"protocolFamily\" as protocol_family, s.\"draftVersion\" as draft_version,
       jsonb_typeof(s.document) as document_type,
       jsonb_array_length(s.document) as message_count,
       length(s.document::text) as document_bytes,
       s.\"updatedAt\" as updated_at
  from interaction_surfaces s
  join interactions i on i.id = s.\"interactionId\"
  join threads t on t.id = i.\"threadId\"
 where t.\"botId\" = :'bot'
 order by s.\"createdAt\"
" \
  -c "
-- Keys, ids and enums only: no payload field is printed.
select 'events' as what,
       e.seq, e.type, e.\"runId\" as run_id, e.\"createdAt\" as created_at,
       coalesce(e.payload->>'interactionId', e.payload->>'executionId', '') as ref,
       (e.payload ? 'blocks') as has_blocks
  from events e
  join threads t on t.id = e.\"threadId\"
 where t.\"botId\" = :'bot'
   and e.type in (
     'thread.surface.created','thread.surface.updated',
     'thread.interaction.updated','thread.interaction.field_changed',
     'agent.tool.called','agent.tool.completed',
     'thread.message.created','thread.message.updated'
   )
 order by e.seq
 limit 400
" \
  -c "
select 'runs' as what,
       r.id as run_id, r.status, r.trigger,
       r.\"startedAt\" as started_at, r.\"completedAt\" as completed_at
  from runs r
  join threads t on t.id = r.\"threadId\"
 where t.\"botId\" = :'bot'
 order by r.\"startedAt\"
" \
  -c "rollback;"

cat <<'NOTE'

== how to read this
  - If `resolved_bot` has no row, the id is not a bot this database knows. That is a
    wrong-environment or wrong-id answer, not "no card was stored".
  - `message_surface_blocks` empty means no stored message in this bot's chat carries a
    card. The card was never persisted there — or this database is not the one that
    served the page. The first line distinguishes the second case.
  - `surfaces` with message_count >= 1 and document_bytes > 2 means the stored document
    is not empty. `document_type` shows whether it is an array at all.
  - `events` rows are what the server wrote down. An event row alone does not prove the
    SSE frame reached a browser; it proves the server recorded the intent to send it.
NOTE
