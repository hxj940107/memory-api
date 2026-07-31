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

- Added mobile image attachments in chat.
- Image sending now supports up to 4 selected images per message.
- Images are picked from the photo library, compressed before sending, and sent through `imageUrls` while keeping `imageUrl` compatibility for older single-image messages.
- Image metadata is saved with messages so refreshed history can show sent images.
- Image thumbnails can be opened in a full-screen preview.
- Image-only history messages hide default placeholder text such as "请看这张图片。".
- Image messages now show sending, sent, failed, and retry states in the chat UI.
- Mobile API requests have timeout handling so offline/failed sends do not remain stuck indefinitely.
- Improved keyboard behavior so the latest chat content stays visible when the input is focused.
- Improved drawer behavior:
  - drawer open/close now animates even when iOS reduced motion is enabled
  - navigation waits for the close animation before switching conversations
  - the current conversation is highlighted with a light iOS-style background
  - pinned and normal conversations are separated only when pinned conversations exist
  - context menu actions have pressed-state feedback
- Added `metadata jsonb` requirement for the `messages` table.
- Added `last_conversation` and `updated_at` requirements for the `user_state` table.
- Added `docs/MOBILE_UI_DIRECTION.md` for the broader iMessage-like mobile design direction.
- Improved last-conversation restore so stale conversation IDs are less likely to trap the app on an empty chat.
- Added a left-drawer new-chat entry and drawer auto-close on navigation.
- Improved memory retrieval:
  - recent history increased from 4 to 16 messages
  - Ombre Brain `breath-hook` and `memory-search` now receive `user_id`
  - PIN memory cache has a 30-minute TTL and does not cache empty results
  - dynamic memory search query includes recent user messages plus the current message
  - Supabase `memories` now acts as a stable memory fallback in chat context
- Confirmed Ombre Brain pinned memories now reach XiaoC through `PIN MEMORY`; XiaoC can remember the user's identity and dog-related pinned memory.
- Strengthened `prompt/system.md` so XiaoC uses known memories naturally and keeps a stable warm/rational/mature voice.

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
- Single-image sending works after compression.
- Multi-image selection and chat UI display work locally; full multi-image model handling requires the updated backend deployment.
- Image history display works for single-image messages and is prepared for `imageUrls` multi-image metadata.
- Full-screen image preview works.
- Image send failure shows a retry affordance instead of staying stuck.
- Memory retrieval from Ombre Brain is confirmed working in Vercel logs.

Check Vercel logs after deployment for:

```text
PIN MEMORY:
DYNAMIC QUERY:
SEARCH RESULT:
```

If `PIN MEMORY` becomes empty again, investigate Ombre Brain `/breath-hook`, Railway deployment health, and `memory-search` before changing XiaoC prompt.

## Next Recommended Step

Before ending the current work session:

1. Test the latest mobile UI changes in Expo.
2. Commit and push the local mobile/backend changes together.
3. Confirm Vercel deployment completed.
4. Test multi-image model handling against the deployed backend.
5. Check Vercel logs for request size, image payload handling, and memory payloads.

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
