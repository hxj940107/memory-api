# XiaoC Current Status

> Canonical snapshot: 2026-09-12 (Asia/Shanghai). This is a current fact and release-gate snapshot, not a changelog.

## Status Legend

- **COMPLETE**: implemented and covered by the current local verification baseline.
- **PRODUCTION**: active on the real production path.
- **PENDING VERIFICATION**: implemented or configured, but still needs a new binary or production check.
- **PAUSED**: deliberately not being expanded now.
- **LATER / NON-BLOCKING**: future work, not a release blocker.

## Release Snapshot

- **PRODUCTION** — XiaoC Private is the existing private, single-user, mobile-first AI companion. The Expo iOS app is primary.
- **NOT STARTED** — Public App is the new independent Own Stack product direction, but no Public client/repository exists yet. Each user will bring their own Supabase, Vercel, OpenRouter, and other enabled-service accounts/keys. Root `public/` is the Legacy Web Prototype, not Public App.
- **FOUNDATION** — Shared Backend currently means reusable backend code and deployment contracts, not one hosted Production shared by all Own Stack users. Identity, tenant, persona, Memory, credentials, billing, and business state must remain isolated from XiaoC Private and from every other installation.
- **PRODUCTION** — Vercel remains at the Hobby hard limit of `12/12` Serverless Functions.
- **BUILD IN PROGRESS / PENDING VERIFICATION** — A new XiaoC Private EAS Production build containing Private Supabase Auth enrollment/JWT support has been started. Its build number and TestFlight availability must be confirmed from EAS; it is not Public App.
- **PENDING VERIFICATION** — After installation, verify startup, existing unlock, Private Auth enrollment, JWT refresh, chat, recording/playback, legacy compatibility, and API access on the real iPhone.
- **DO NOT CUT OVER YET** — Server trusted-identity rollout and App-token fallback removal must wait for the new binary and JWT Shadow checks. Core UUID dual-write remains OFF.

## Memory / Context

- **PRODUCTION SHADOW (1%)** — XiaoC Memory Engine has progressed from M0 source preservation through M1/M2 schema and historical import to M3D/M3D1 production Shadow. The 1% Shadow read is active, read-only, failure-isolated, and cannot inject into Chat or Context Gateway.
- **PRODUCTION AUTHORITATIVE** — Ombre remains the authoritative Memory runtime and retrieval source. No XiaoC Memory Engine cutover, fallback, merge path, or embedding-based production retrieval is enabled.
- **COMPLETE** — Historical preservation imported all `150/150` locked legacy memories into the XiaoC-owned schema with stable identity and lineage. Import completion did not enable production reads or create embeddings.

- **COMPLETE** — P0: factual Memory and conversational attention are separated; duplicate/novelty behavior, provenance boundaries, and “remembered but should not be raised now” regressions are covered.
- **COMPLETE** — P1: Memory / Context Gateway, Stable Memory consolidation, provenance and supersedes, Core Memory Snapshot, token-aware Recent, Summary Segments, old-summary compression, and Dynamic Context Budget are implemented.
- **PRODUCTION** — P1.5 proactive implementation is complete and production real-send is active. Scheduler wake-up, execution Gate, arbitration, final recheck, lifecycle protection, idempotency, and kill switch remain in force.
- **COMPLETE / PAUSED** — P2 Shared Context Batch 1 is implemented for explicitly bound conversations with checkpoint recovery, batched updates, parse-failure backoff, and diagnostics. Further expansion is paused.
- **PRODUCTION** — Active Context and proactive event proposals share one structured Haiku judge call. Parser failures are isolated; proposal failure does not discard a valid Active Context result.
- **PRODUCTION** — Summary records historical continuity only. It does not create future reminders, active attention, or proactive eligibility.
- **PRODUCTION** — Dynamic Memory excludes Core source buckets, preserves provenance, applies relevance/duplicate controls, and remains background knowledge rather than a topic recommendation system.
- **DO NOT RESTORE** — New chat turns must not recreate the old per-message `plan_follow_up` path. Historical execution compatibility may remain until separately retired.
- **LATER / NON-BLOCKING** — Deep on-demand retrieval and long-term heat / cold / archive lifecycle are not implemented.

## Proactive / Inactivity

- **PRODUCTION** — Inactivity proactive runs through the real scheduler, Judge, execution gates, persistence, and push path. A due time is only a Judge opportunity, never a guaranteed send.
- **PRODUCTION** — In `frequent` mode, an open conversation gets its first Judge opportunity after a randomized **60–120 minutes** of silence.
- **PRODUCTION** — In `frequent` mode, `conversation_end` gets a short protection period and then its first Judge opportunity after **120–180 minutes**. It is no longer a fixed 4–6 hour no-contact rule.
- **PRODUCTION** — Conversation-end meaning remains context for the Judge; it lowers near-term interruption risk but does not lock the entire silence phase.
- **PRODUCTION** — Quiet hours (`23:30–07:00`), cooldown, frequency sequencing, same-silence-phase limits, user-return cancellation, weather/event arbitration, execution-time recheck, and message/task idempotency still apply.
- **PRODUCTION** — Judge may return `should_send=false`; no schedule window requires XiaoC to contact the user.

## Moments / Weather

- **PRODUCTION** — Moments support text/images, delayed XiaoC viewing, like/comment/none/private-follow-up decisions, interaction notifications, unread state, detail navigation, and stable author identity.
- **PRODUCTION** — Moment private follow-up is an immediate decision action with message-ID idempotency. It does not create a second delayed proactive task.
- **PRODUCTION** — Historical Moment images use independently persisted image descriptions; assistant reply text is not visual provenance.
- **PENDING FOLLOW-UP** — Continue checking historical-material selection versus current publishing perspective. Event time and publish time are separated, but edge cases where old material is narrated as if it just happened are not declared permanently solved.
- **COMPLETE / PRODUCTION-CAPABLE** — Nanjing weather rhythm, holiday/workday handling, Shadow diagnostics, final weather recheck, dedupe, and inactivity arbitration are implemented. Real sends remain fail-closed behind `WEATHER_LIVE_SEND_ENABLED=true`; confirm activation from Production environment when auditing live behavior.
- **LATER / NON-BLOCKING** — Weather windows must not become fixed greetings or fixed-time notifications.

## Chat / Search / History

- **COMPLETE** — History pagination is cumulative: older pages append without replacing loaded messages, with stable timestamp/message-ID ordering and deduplication.
- **COMPLETE** — Prepending older history preserves the visible scroll anchor.
- **COMPLETE** — Search queries full server-side conversation history rather than only locally loaded messages.
- **COMPLETE** — Results jump to the real target with surrounding context and temporary query highlighting.
- **COMPLETE** — Returning from located history restores the latest conversation position without corrupting pagination state.
- **PRODUCTION** — Cloud message IDs remain stable identity for polling, HTTP replies, focus refresh, split bubbles, attachments, voice, favorites, and provenance.

## Diary / Favorites

- **PRODUCTION** — Wife Observation Diary supports cloud entries, manual recent-date selection, generated short titles, time-grouped observations, XiaoC-perspective observation conclusions, deletion, and current presentation rules.
- **KNOWN PRODUCT DECISION** — Bundled local diary sample entries in `mobile/XiaoC/src/data/observationDiary.ts` are permanently merged into the diary view. Do not delete them as stale data without an explicit product decision.
- **PRODUCTION** — Favorites use local cache plus cloud synchronization and preserve stable message identity.
- **COMPLETE / DATABASE APPLIED** — Concurrent `client_preferences` updates use Supabase `patch_client_preferences`. Favorites, ordinary preferences, and notification settings patch only their own fields; the SQL migration has been executed in Production.

## Voice / Audio

- **COMPLETE / PAUSED** — Voice Call Phase 0 Checkpoints A and B passed. The media foundation is deliberately paused before model-pipeline expansion; the next gate is Checkpoint C (STT).

- **PRODUCTION** — XiaoC TTS uses MiniMax China (`speech-2.8-hd` by default) through the provider-neutral persistence boundary.
- **PRODUCTION** — User STT uses Groq `whisper-large-v3`; transcript and voice modality enter the existing chat path without fabricated acoustic perception.
- **COMPLETE** — Recording and XiaoC/user playback are unified on `expo-av ~16.0.8`. `expo-audio` is removed from dependencies and native plugins.
- **COMPLETE** — Standalone Splash startup was repaired by removing the conflicting audio dependency/config and making native Splash release independent of audio initialization.
- **COMPLETE** — Chat unmount cleanup releases `Audio.Sound`, safely stops/unloads `Audio.Recording`, clears timers, avoids upload/transcription/send, and restores `allowsRecordingIOS: false`.
- **COMPLETE** — Hold-to-record, release-to-send, swipe-up cancel, swipe-down restore, 60-second cap, playback, and transcript expand/collapse remain intact.
- **LATER / NON-BLOCKING** — A future Expo audio migration is not a current blocker.

## Startup / Private API Auth

- **COMPLETE** — Root Splash release does not wait for network, storage, authentication, cloud preferences, or audio initialization.
- **COMPLETE** — Welcome reads local account/password first with recoverable error handling. Cloud preferences synchronize in the background and cannot keep `unlockReady` pending.
- **LOCAL COMPLETE / NOT DEPLOYED** — M3B.1 adds one shared server-side Supabase JWT resolver, fixed Private UUID verification, active companion lookup, privacy-safe identity Shadow, and fail-closed handling across all 12 API routes.
- **LOCAL COMPLETE / BUILD PENDING** — Mobile adds a Private-only one-time enrollment UI, Supabase session persistence/refresh in SecureStore, and Bearer access tokens on API requests. It does not add Public registration or account switching.
- **CONFIGURED / PENDING VERIFICATION** — EAS Production contains the Supabase project URL, public anon/publishable key, enrollment flag, and the existing Sensitive Private App token. No service-role key or Auth session credential is embedded.
- **CONFIGURED** — `CRON_SECRET` exists and remains separate from private App authentication.
- **NOT DEPLOYED / NOT ENABLED** — Verified JWT identity is not yet the confirmed Production API authority. If a temporary App-token fallback is needed for the old binary, it may only fixed-bind to the approved Private UUID and must record usage; anonymous compatibility must not become the target state.
- **SECURITY NOTE** — Client `user_id` is legacy compatibility only; client `user_uuid` must never be authoritative. A presented but invalid JWT must never silently fall back.

## Token / Cost

- **PRODUCTION** — Explicit prompt caching works. The stable prefix contains Persona, Relationship Contract, Core Memory Snapshot, and fixed rules; current time and dynamic context remain after the breakpoint.
- **COMPLETE** — Recent Message Ledger now exposes compact `m1`, `m2` ordering, speaker, compact Shanghai time, and only meaningful special sources. Full UUIDs remain unchanged in internal provenance and persistence.
- **COMPLETE** — Stable Summary/Memory/context-use rules moved into the cache prefix without duplication.
- **COMPLETE** — Empty User Profile, Summary, Dynamic Memory, Active Context, Shared Context, Diary, and other optional dynamic blocks omit headings and filler.
- **ESTIMATE, NOT GUARANTEE** — Offline formatting estimates indicate about **830–850 fewer uncached input tokens per typical turn**. With the audited workload and cache pattern, a typical main-chat turn may move from about **$0.0115 toward ~$0.009**. Production usage must confirm the saving.
- **PAUSED** — Do not compress Persona, Relationship Contract, Core Snapshot, Recent content, or reduce model quality merely to lower nominal input.

## Engineering Health

Refresh this baseline whenever code changes. As of this snapshot:

- Full Node tests: `485/485` passing on the current M3B.1 working tree.
- Mobile TypeScript: `0 errors` with `npx tsc --noEmit`.
- `git diff --check`: passing.
- Vercel API Functions: `12/12`.

## Observability

- **PRODUCTION / HEALTHY** — Treehole execution and `xiaoc_background_check` run audits are active with privacy-safe, append-only records and 60-day retention.
- **PRODUCTION / HEALTHY** — Audit writes are failure-isolated; `service_role` has direct `SELECT`/`INSERT` only, while expired-row deletion is restricted to the cleanup RPC.

## Product / Identity Phase

- **M2C.5 COMPLETE** — Database isolation has completed Production grant containment, additive UUID foundation, and the first Private companion binding. The verified Auth account owns the exact 3,966-row legacy `user` manifest; 3,329 excluded Core rows remain quarantined and unbound.
- **M3B.1 IN PROGRESS** — The current checkpoint is the XiaoC Private trusted identity bridge and JWT Shadow rollout. M2C.6 enforcement, Core UUID dual-write, final RLS, and Public App implementation have not started.

## Current Priorities

### Release blockers / required sequence

1. Let the current EAS Production build finish and record its actual build number; do not assume it succeeded or reached TestFlight.
2. Submit/install through TestFlight and verify startup, unlock, Private Supabase enrollment, session refresh, chat, voice, and existing Private data.
3. Deploy the server trusted-identity bridge only with the approved fixed-binding App-token fallback needed to protect the old binary.
4. Verify real-device JWT Shadow, companion status, legacy alias agreement, and Cron/worker health without enabling Core UUID dual-write.
5. Remove fallback and require trusted identity only after the JWT path is stable; M2C.6 remains a separate later checkpoint.

### Follow-up, not release blockers

- Keep XiaoC Memory Engine at 1% Shadow until its review gate is satisfied; Ombre remains authoritative and cutover requires separate approval.
- Resume Voice Call at Checkpoint C only when the paused Phase 0 work is explicitly restarted.
- Reassess M2C.6+ scope before any further implementation; continue only Engine identity/data-isolation work and keep Hosted-SaaS operations deferred.
- Observe production Token/Cost after cache warm-up and compare with the offline estimate.
- Continue Moments event-time/publish-time and historical-material perspective checks.
- Decide whether permanent bundled diary samples should remain a lasting product feature; until then, preserve them.
- Keep Shared Context expansion paused until a concrete companion-experience need justifies the next batch.
- Old API compatibility branches and Expo starter leftovers are isolated low-priority cleanup.
- Continue production observation of proactive reliability and Judge diagnostics; do not revive broad P1.5 redesign without a real blocker.

## Development Guardrails

- Read `docs/PRODUCT_VISION.md`, `docs/DEVELOPMENT_PRINCIPLES.md`, and `docs/memory-context-architecture.md` before Memory/Context work.
- Do not add `api/*.js` unless another Function is first consolidated or removed; Production is already `12/12`.
- Do not expose secret values in logs, documentation, tests, or reports.
- Memory retrieval or prompt inclusion never grants proactive attention.
- Prefer small, reversible changes and verify the real production path before expanding architecture.
