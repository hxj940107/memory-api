# XiaoC Current Status

## Private iOS App Readiness — 2026-08-30

- Push Notification and Face ID integration are implemented in the current working tree and are not yet deployed or device-verified.
- Proactive private messages attempt Push only after the visible assistant message is persisted. Duplicate proactive tasks reuse the existing message and do not send a second notification.
- Notification previews can be hidden, notification taps preserve the target conversation through App unlock, and foreground notifications do not add a duplicate banner.
- The existing Face ID settings placeholder is connected. The six-digit fallback passcode migrates from AsyncStorage to iOS Keychain, cold launch supports biometric unlock, and background snapshots are covered; returning after 60 seconds requires unlock again.
- `supabase_push_notifications.sql` must be applied before enabling Push, followed by an EAS iOS build that provisions the Apple Push Notification key.
- Release blocker still requiring an explicit security design decision: most public app API endpoints currently trust the fixed `user_id` and do not authenticate the private device. Do not treat the first private build as security-complete until this is addressed or consciously accepted for the single-device threat model.
- Private-device API authentication is now implemented in the working tree behind `XIAOC_APP_AUTH_ENABLED`. All 12 API functions share one constant-time gate, internal chat calls forward the token, Cron retains independent `CRON_SECRET` access, and the mobile client loads the build token into Keychain. Follow `docs/PRIVATE_IOS_RELEASE.md`; do not enable the Production flag before installing and verifying the token-bearing build.

## Canonical Production Baseline — 2026-08-29

This section is the current planning authority. Dated milestone sections below are retained as history and must not override this baseline.

- P0, P1, and P1.5 Batch 1/2A/2B/2C are implemented. Proactive Attention has scheduler wake-up, execution-time Gate, inactivity arbitration, limited rollout, final recheck, duplicate-send protection, and a production kill switch.
- P2 Shared Context MVP is implemented. Only explicitly bound conversations inject its working context, and updates are batched rather than called every turn.
- Summary debounce and the combined Active Context/proactive Judge cost reductions are implemented. Judge prefilter remains Shadow and must not skip real requests until production evidence shows it is safe.
- Moments, delayed XiaoC interaction, private follow-up, autonomous Treehole, Observation Diary, shared album, and inactivity reach-out are active mobile capabilities rather than placeholders.
- Phase 1 health-check reliability changes are complete in the current working tree and awaiting deployment/production verification: bounded retries, stale `processing` recovery, task/message idempotency, protected post-chat continuations, Shared Context checkpoint recovery/backoff, and strict independent image provenance.
- Vercel Hobby remains at the hard limit of 12 Serverless Functions; do not add a new `api/*.js` file without freeing a slot.
- Current work is stabilization and production observation. Only confirmed production blockers should reopen frozen P1.5 semantics.
- Weather-aware companionship Phase 1 is implemented in strict Shadow. Existing `api/memory.js` background checks schedule bounded morning and afternoon weather windows for Nanjing, query cached-by-task forecast/calendar context, and record whether a short-lived weather candidate would have been useful. It sends no message, generates no copy, adds no API Function, and keeps weather location separate from the `Asia/Shanghai` system timezone. Production deployment and Shadow observation are still required before any real-send decision.

## Current Delivery Gate — Phase 1 Health Check

### Code complete

- `xiaoc_proactive_tasks`, `moment_candidates`, and `moment_xiaoc_activity` no longer retry ordinary failures forever. Retry state reuses existing payload/error fields; no database migration is required.
- A `processing` claim older than 15 minutes is recoverable, while task/message idempotency prevents a recovered proactive task from sending the same message twice.
- Image-description persistence, Summary dispatch, and current-conversation state updates now use Vercel `waitUntil` instead of unprotected fire-and-forget promises.
- Shared Context reloads an out-of-window checkpoint before selecting pending messages. A deleted checkpoint fails closed without an LLM call, and parse failures receive a 30-minute retry backoff.
- Historical image context, Moment material, and Treehole material accept only independent `imageDescription`; an assistant chat reply is no longer reused as visual evidence.
- Autonomous Treehole admission counts real user material for its character threshold. Inactivity generation records whether the safe fallback was used and why.
- Regression baseline: `134/134` Node tests pass; all API/lib JavaScript syntax checks and `git diff --check` pass; API Function count remains `12/12`.

### Not yet production-verified

- The current working-tree changes must be deployed before they can be treated as production behavior.
- After deployment, use XiaoC normally for approximately `12–24` hours, then perform one read-only production audit.
- The audit must check stale `processing`, retry progression, terminal `failed` tasks, duplicate proactive/Moment output, Summary and image-description persistence, Shared Context checkpoint/backoff diagnostics, inactivity fallback frequency, and paid background requests without a visible or persisted result.

### Next decision

- If the production audit is clean, proceed to Judge prefilter production-readiness analysis using Shadow samples.
- Do not enable real Judge skipping until there are at least `30–50` representative user turns and zero dangerous false skips, including protection for short updates such as “做完了”“没呢”“取消了”“三点再去”“改明天”.
- If Shadow evidence is insufficient, keep the Judge unchanged and next address repeated Summary semantic-validation failures with bounded backoff.
- Do not start a new P2 feature batch, prompt rewrite, or broad `api/chat.js` refactor before this delivery gate is closed.

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

### 2026-08-13 Moments Interaction Milestone

- Completed the user-posted Moments flow for text, single image, and text with a single image.
- XiaoC checks new user Moments asynchronously instead of reacting immediately, then independently decides whether to like, comment, both, do nothing, or reserve a private follow-up.
- Completed the Moments interaction notification loop:
  - Sidebar red dot for unread XiaoC interactions.
  - Lightweight “X条新消息” capsule at the top of Moments.
  - One continuous interaction page that initially shows all newly unread interactions.
  - “查看全部互动消息” expands historical interactions in the same page without a second list route.
  - Every interaction shows XiaoC's avatar, action, time, and the related Moment image or text preview.
  - Tapping an interaction opens the matching single-Moment detail page; back returns to the interaction list.
  - Entering the interaction page marks the current batch as read so the capsule and sidebar red dot disappear on return.
- User-authored Moment names now use the current account display name instead of stale names stored with older posts.
- XiaoC likes now return an explicit `xiaocLiked` state and reuse the existing red-heart / liker-name presentation rather than showing only a numeric count.
- This implementation has been pushed. Final end-to-end verification is pending the next newly published Moment and XiaoC's scheduled delayed interaction.

### 2026-08-11 Milestone

- Added server-generated time awareness to every main chat request.
  - Current timezone is centralized as `USER_TIMEZONE = "Asia/Shanghai"`.
  - The current date, time, weekday, timezone, and UTC offset are injected only into the current system context.
  - Environment context is not saved to conversation history, memory, summary, or diary.
- Stabilized multi-turn image understanding.
  - New images are still sent to the main vision-capable chat model for the current turn.
  - A separate Haiku 4.5 vision task creates `metadata.imageDescription` without chat history or personality prompts.
  - Historical context uses only the independently generated `imageDescription`; assistant reply text is not treated as visual provenance.
  - Historical base64 images are not re-injected into the model context.
- Moved non-critical post-chat work off the main response path so saved assistant replies can return to the mobile app without waiting for image metadata, memory, user-state, summary, or Moment follow-up work.
- Improved pinned-memory injection within the existing character budget.
  - PIN memory is handled as entries instead of slicing one long string blindly.
  - Fact-oriented entries receive priority without hard-coding a specific fact.
  - Debug logs report only the injected length and short beginning/end previews.
- Expanded the Moment context window from 10 to 18 messages and from 2,600 to 4,000 characters without changing the existing trigger frequency or generation logic.
- Refined the mobile experience.
  - The left drawer now presents XiaoC as a restrained private space instead of an AI feature directory.
  - Sidebar hierarchy, spacing, safe-area behavior, SF Symbols, and small-screen scrolling were polished.
  - Chat bubbles now use an iMessage-inspired visual language with softer system blue, iOS secondary gray, compact sender-aware spacing, and content-sized bubbles.
  - Assistant inline bold Markdown renders correctly, and single images preserve their display aspect ratio.

### Mobile Chat

- Mobile chat is now the primary experience.
- The app restores the last valid conversation on launch.
- Conversation history can be browsed from the left drawer.
- Conversations support create, rename, pin/unpin, delete, and current-conversation highlight.
- Drawer open/close is animated and navigation waits for drawer close.
- Keyboard behavior has been improved so the latest messages stay visible when typing.
- Chat messages use compact sender-aware spacing: consecutive messages stay close while sender changes retain a clearer break.
- Long assistant replies use a constrained reading width and render inline bold Markdown without exposing `**` markers.
- User and assistant bubbles use a unified rounded iMessage-inspired shape without tails, delivery states, borders, or shadows.
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
- Independent image descriptions are saved to the current user message metadata for later visual continuity.
- Historical image context uses text descriptions instead of re-sending image base64 data.
- Image thumbnails can open a full-screen preview.
- Single-image messages preserve the source display ratio; multi-image messages retain the compact grid.
- Image send failures show retry affordances instead of staying stuck.
- Text-like file attachments are supported, including `txt`, `md`, `csv`, `json`, `html`, `css`, `js`, `ts`, `tsx`, and `jsx`.
- Uploaded file text is sent only with the current request and is not stored as long-term message content.
- PDF / Word reading is not implemented yet.

### XiaoC Spaces

- The left drawer now contains XiaoC's private spaces:
  - 深夜树洞
  - Observation Diary
  - Moments / 朋友圈
  - 共享相册
  - 收藏
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
- Core Memory Snapshot preserves the complete pinned core for each conversation; dynamic memory remains separately budgeted and filtered.
- Dynamic memory search query includes recent user messages plus the current message.
- Supabase `memories` acts as a stable memory fallback in chat context.
- Attribution-correction handling was added so XiaoC is less likely to confuse who said/wrote something.
- Current cost-control approach:
  - keep recent history limited
  - rely on summaries and memory search
  - use Haiku for memory judge / summary tasks
  - avoid storing full uploaded file text in history
  - use a low-cost independent vision task once per new image request rather than repeatedly sending historical images

### Time Awareness

- XiaoC receives a server-generated Environment block in the current main-chat system message.
- The first-stage timezone is fixed to `Asia/Shanghai`, with the timezone value centralized for later replacement by a user or device timezone.
- Time context is request-only and deliberately excluded from all persistent memory and content pipelines.

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
- Multi-turn image continuity works through independently generated `imageDescription`; legacy `visionSummary` is no longer injected as visual evidence.
- Main chat responses are no longer intentionally blocked by non-critical post-chat tasks.
- The prioritized PIN injection has been verified with the user's dog-name fact reaching the final system context.
- Server-side Beijing time awareness has been verified in a live XiaoC reply.
- The expanded Moment context window logs message count, character count, and a preview for deployment verification.
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

1. Verify the expanded Moment context in deployed logs and live conversations.
   - Confirm the triggering user/assistant turn is present exactly once.
   - Confirm the 18-message / 4,000-character window is used consistently by the asynchronous post-chat task.
2. Add image awareness to Moment generation without re-injecting historical image data.
   - Reuse saved `imageDescription`; omit image background when independent description is unavailable.
   - Keep image Moment work independent from the main chat response path.
3. Continue monitoring post-chat task reliability.
   - Main replies must return immediately after the assistant message is saved.
   - Image description, summary, memory, user-state, and Moment failures must remain isolated.
4. Cloud sync for treehole posts.
   - Current state: local AsyncStorage only.
   - Reason: should survive reinstall / device switching.
5. Cloud sync for favorites.
   - Current state: local AsyncStorage only.
   - Reason: ordinary chat quotes should also be available across devices.
6. Improve Diary / Treehole generation quality.
   - Goal: closer to XiaoC's previous “self-written” official-Claude style.
   - Keep app-rendered cards, but let XiaoC own the content and structure.
7. Continue attachment support.
   - Add PDF / Word reading after text and HTML are stable.
8. Continue cost control.
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
