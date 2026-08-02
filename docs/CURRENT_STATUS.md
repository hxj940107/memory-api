# XiaoC Current Status

## Current Phase

XiaoC is in an early mobile-first stabilization phase.

The main goal is not to add many features, but to make the core companion loop feel stable, continuous, and personal:

- Chat should be reliable.
- Conversation history should be easy to restore and browse.
- Memory should help XiaoC understand the user, not store everything.
- Mobile experience is the priority.
- Web remains a historical prototype.

## Product Direction

XiaoC is a private, single-user AI companion.

Do not design for multi-user switching, teams, organizations, SaaS, billing, or public product workflows unless the project direction is explicitly changed.

The highest principle is Experience First. Every change should be judged by whether it makes XiaoC feel more continuous, familiar, trustworthy, and emotionally present.

## Current Architecture Snapshot

- Root project: Vercel-style API and historical web prototype.
- `api/`: chat, history, conversation, summary, memory-related endpoints.
- `lib/`: centralized AI/model/context configuration and shared helpers.
- `prompt/system.md`: XiaoC identity, relationship continuity, and speaking style.
- `mobile/XiaoC/`: Expo React Native mobile app, currently the primary experience.

## Main Working Areas

1. Stabilize mobile chat.
2. Keep conversation restore/history reliable.
3. Improve memory quality and context selection.
4. Control token and external model call cost.
5. Keep configuration centralized.
6. Avoid large refactors unless they clearly reduce risk.

## Known Risks

- Memory judging logic exists in multiple places and may drift.
- `api/chat.js` currently owns many responsibilities and may need small, careful extraction over time.

## Latest Progress

### Mobile Chat

- Mobile chat is now the primary experience.
- The app restores the last valid conversation on launch.
- Conversation history can be browsed from the left drawer.
- Conversations support create, rename, pin/unpin, delete, and current-conversation highlight.
- Drawer open/close is animated and navigation waits for drawer close.
- Keyboard behavior has been improved so the latest messages stay visible when typing.
- Message bubbles now support long-press actions:
  - copy
  - select text
  - translation placeholder
  - favorite
  - delete single message
- Single-message deletion removes the message from cloud history and the local UI.
- The delete-message logic is intentionally implemented through existing `api/add-message.js` to avoid exceeding Vercel Hobby's 12 Serverless Functions limit.

### Attachments

- Image sending works.
- Up to 4 images can be selected in one message.
- Images are compressed before sending.
- Image metadata is saved in message history.
- Image thumbnails can open a full-screen preview.
- Image send failures show retry affordances instead of staying stuck.
- Text-like file attachments are supported, including `txt`, `md`, `csv`, `json`, `html`, `css`, `js`, `ts`, `tsx`, and `jsx`.
- Uploaded file text is sent only with the current request and is not stored as long-term message content.
- PDF / Word reading is not implemented yet.

### XiaoC Spaces

- The left drawer now contains XiaoC's private spaces:
  - 深夜树洞
  - Observation Diary
  - 收藏
  - 朋友圈 placeholder
- 深夜树洞:
  - has a dark “small account / treehole” feed UI
  - supports structured treehole draft cards in chat
  - treehole drafts can be saved locally and then appear in the treehole feed
  - refresh detects already-saved treehole drafts and shows “已存入树洞”
- Observation Diary:
  - has a warm paper-like list and detail UI
  - diary entries are saved to Supabase through `/api/memory`
  - diary messages now render as preview cards in chat instead of plain long bubbles
  - refresh detects already-saved diary cards and shows “已存入 Diary”
  - diary entries can be deleted from the diary list
- 收藏:
  - lets the user save ordinary chat text from the long-press menu
  - currently uses local AsyncStorage
  - favorites can be viewed from the left drawer and removed by long-pressing a favorite card

### Memory and Cost Control

- Ombre Brain pinned memories are confirmed to reach XiaoC through `PIN MEMORY`.
- XiaoC can remember the user's identity and dog-related pinned memory.
- Recent history, summary memory, pinned memory, stable memory, and dynamic memory are combined in `api/chat.js`.
- PIN memory cache has a 30-minute TTL and does not cache empty results.
- Dynamic memory search query includes recent user messages plus the current message.
- Supabase `memories` acts as a stable memory fallback in chat context.
- Attribution-correction handling was added so XiaoC is less likely to confuse who said/wrote something.
- Current cost-control approach:
  - keep recent history limited
  - rely on summaries and memory search
  - use Haiku for memory judge / summary tasks
  - avoid storing full uploaded file text in history

### Documentation

- Added `docs/MOBILE_UI_DIRECTION.md`.
- Product vision and development principles are documented in:
  - `docs/PRODUCT_VISION.md`
  - `docs/DEVELOPMENT_PRINCIPLES.md`
  - `AGENTS.md`

## Database Changes Applied Manually

The following Supabase SQL was applied successfully:

```sql
alter table messages
add column if not exists metadata jsonb default '{}'::jsonb;

alter table user_state
add column if not exists last_conversation text;

alter table user_state
add column if not exists updated_at timestamptz;
```

## Current Test Notes

- Text chat works.
- Single-image and multi-image sending work after compression.
- Image history display works through `imageUrl` / `imageUrls` metadata.
- Full-screen image preview works.
- Image send failure shows a retry affordance instead of staying stuck.
- Text / HTML file upload works for current-request reading.
- Treehole draft cards work and can be saved locally.
- Diary preview cards work and can be saved to cloud.
- Favorites work locally.
- Single-message deletion works and should survive refresh after Vercel deploy.
- Memory retrieval from Ombre Brain is confirmed working in Vercel logs.
- Vercel Hobby plan has a 12 Serverless Functions limit. Do not add new files under `api/` casually; prefer extending existing endpoints when reasonable.

Check Vercel logs after deployment for:

```text
PIN MEMORY:
DYNAMIC QUERY:
SEARCH RESULT:
```

If `PIN MEMORY` becomes empty again, investigate Ombre Brain `/breath-hook`, Railway deployment health, and `memory-search` before changing XiaoC prompt.

## Next Recommended Steps

### When switching to PC

1. Pull latest `main` before making changes.
2. Confirm Vercel latest deployment is green.
3. If Expo/mobile behavior seems stale, restart Expo and refresh the app.
4. Do not start from an old local copy without pulling, because mobile UI and API files have changed frequently.

### Product / Feature Priorities

1. Cloud sync for treehole posts.
   - Current state: local AsyncStorage only.
   - Reason: should survive reinstall / device switching.
2. Cloud sync for favorites.
   - Current state: local AsyncStorage only.
   - Reason: ordinary chat quotes should also be available across devices.
3. Improve Diary / Treehole generation quality.
   - Goal: closer to XiaoC's previous “self-written” official-Claude style.
   - Keep app-rendered cards, but let XiaoC own the content and structure.
4. Continue attachment support.
   - Add PDF / Word reading after text and HTML are stable.
5. Continue cost control.
   - Avoid increasing every chat request's token load.
   - Prefer task-specific context expansion only when writing Diary / Treehole or reading files.

## Attribution Boundary

- `user_id` means the single user's data space.
- Message authorship is represented by `role`: `user` is the user, `assistant` is XiaoC.
- `small_c`/XiaoC should be treated as companion identity, not as the default `user_id`.
- Summaries and memories must not turn XiaoC's own words into user facts.

## Development Notes For Future Codex Sessions

Before making code changes, read:

- `AGENTS.md`
- `docs/PRODUCT_VISION.md`
- `docs/DEVELOPMENT_PRINCIPLES.md`
- `docs/CURRENT_STATUS.md`
- `docs/MOBILE_UI_DIRECTION.md` when changing mobile UI or product modules

When switching computers or Codex tasks, use Git as the source of truth:

- Pull before starting work.
- Commit and push before switching machines.
- Use clear commit messages, especially for WIP work.

Prefer small, reversible changes that protect XiaoC's continuity, memory, and mobile chat experience.
