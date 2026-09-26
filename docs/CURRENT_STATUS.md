# XiaoC Current Status

> Canonical snapshot: 2026-09-26 (Asia/Shanghai). This is the repository and project handoff baseline, not a changelog. When Production state cannot be proven from repository evidence, it is marked **NEEDS CONFIRMATION**.

## Status Legend

- **DONE**: implemented in the current repository and supported by focused tests or retained migration evidence.
- **PRODUCTION**: confirmed on the real XiaoC Private production path by retained project evidence.
- **READY / NOT DEPLOYED**: implementation exists, but deployment or real-device verification is not established here.
- **PAUSED / INCOMPLETE**: intentionally stopped or not yet implemented.
- **NEEDS CONFIRMATION**: repository evidence is insufficient to assert the live external state.

## Current State

- **PRODUCTION** — XiaoC Private remains a private, single-user, mobile-first AI companion. The Expo iOS client is the primary product surface.
- **DONE** — The repository root `public/` is only the Legacy Web Prototype. It is not the Public App and must not become its implementation path.
- **SEPARATE REPOSITORY** — XiaoC Public is an independent product/client in `/Users/hxj/Documents/xiaoc-public`. `memory-api` and `xiaoc-public` are separate Git repositories; Public development must not turn XiaoC Private into a multi-user client.
- **DONE** — Public App v1 is bounded as Own Stack: each user supplies and pays for their own Supabase, Vercel, OpenRouter and other enabled-service accounts. It is not a Hosted SaaS backed by XiaoC Private resources.
- **DONE** — Shared Backend means reusable code, schema contracts, migrations, configuration conventions and maintenance patterns. It does not permit sharing XiaoC Private persona, memories, relationship state, business state, secrets, quotas or Production data with Public users.
- **PRODUCTION CONSTRAINT** — Vercel Hobby remains at the hard limit of `12/12` Serverless Functions. New capabilities must reuse an existing endpoint unless another Function is first consolidated.
- **PRODUCTION / REAL-DEVICE PASS** — iOS Production Build 17 is the current native baseline. It is in TestFlight, installed, and has passed real-device validation. The exact Production OTA update currently selected by installed devices and some live environment values remain external state.

## Done

### Memory / Context

- XiaoC-owned `memory_items` is implemented as the authoritative Memory Engine path, including owner/lifecycle/provenance/authority eligibility, native capture, protected lifecycle operations, lexical/semantic hybrid discovery, deterministic ranking, dedupe/suppression, Top-K and Context Gateway budgeting.
- The final manually reviewed historical corpus contains `97` eligible memories. The previous eligible historical set of `72` was made ineligible rather than physically deleted; rollback artifacts were prepared. The completed migration recorded:
  - categories: `personal_fact=22`, `relationship_memory=17`, `meaningful_experience=16`, `relationship_preference=42`;
  - importance: `10=14`, `8=53`, `5=23`, `3=7`;
  - compatible embeddings: `97/97` at verification.
- Production Memory authority is `owned_authoritative`; Memory Engine is the Production Memory mainline. Normal runtime performs no Ombre Memory I/O and has no Ombre fallback. The Railway Ombre service, Volume and historical data have not completed final retirement/cleanup and are retained only for rollback/archive; retirement remains paused backlog work.
- Semantic-only candidates that pass deterministic eligibility participate in normal relevance ranking instead of being rejected solely for missing lexical grounding. Historical selection is no longer restricted to a one-item legacy slot; Gateway suppression can continue through ranked candidates to find prompt-ready replacements.
- Owned Core Snapshot is restored: eligible PIN memories are frozen per conversation, persisted with identity/hash/source metadata, and reused within that conversation. PIN changes affect later conversations, not an already-frozen snapshot.
- Memory Library is connected to owned Memory Engine and supports the four product categories, real eligible/pinned/recent counts and lists, pinned-first ordering, detail view, protected edit, protected soft-delete and protected PIN/UNPIN. Edits invalidate stale embedding compatibility and use the existing maintenance path for regeneration.
- Memory / Context P0, P1 and P1.5 remain complete: Context Gateway, token-aware Recent, Summary Segments, Active Context, Shared Context Batch 1, stable provenance/supersedes boundaries and proactive-attention separation are retained.
- Deep on-demand memory tool retrieval and long-term heat/cold/archive lifecycle are not implemented.

### Chat / Prompt / Cost

- Main chat retains Persona, Relationship Contract, frozen Core Snapshot and fixed rules as the stable BP1 prefix with explicit `1h` caching and conversation-level session affinity.
- Connectome-lite history folding is implemented: persisted history is represented as a cache-stable folded/append-only conversation layer with BP2, while volatile runtime context is serialized after that boundary as an explicitly marked contextual user block. This avoids OpenRouter lifting volatile mid-conversation system content ahead of history.
- Production observation recorded BP2 cache reads around `11.6k–11.8k` cached tokens and ordinary warm-turn costs around `$0.0068–$0.0075`; these are observed samples, not a permanent pricing guarantee.
- **COMPLETED / FROZEN** — Connectome-lite and activity-aware BP1 keepalive passed Production validation and are not active optimization work. Keepalive read `9,097` BP1 cached tokens at about `$0.00279`; a real chat after the original one-hour TTL still read the same `9,097` BP1 tokens, and subsequent turns resumed combined BP1+BP2 reads. One real main-chat activity can produce at most one near-expiry keepalive; it reuses the same stable-prefix builder, persists no message, and cannot keep itself alive indefinitely.
- Rolling Summary, Recent Message Ledger, Recent History, retrieval, Active/Shared Context, environment and conditional contexts remain distinct. Cost work must not silently reduce Persona, relationship continuity, Core, Memory or history information.
- Claude Sonnet 4.6 remains XiaoC's brain and image-tool decision-maker; a dedicated image model performs the image generation/edit operation. Production generation, inline rendering, historical generated-image rendering, fullscreen preview, direct Photos save and shared-album save have passed. Generated-image media actions did not add a new Vercel Function.

### Moments / Album

- Moments supports text/images, delayed viewing, likes/comments/private follow-up, interaction notifications and idempotent persistence.
- Shared-album material discovery and structured image choice remain model-driven; relevant album material is offered as an option rather than forced into every Moment.
- Album image compatibility accepts a sufficiently specific, normalized asset relation/entity label explicitly mentioned by source text as animal-subject grounding. Time-period, weather and unsupported-subject protections remain in force.
- Event time and publish time are separated. Historical-material perspective remains an area for continued observation rather than a closed guarantee.

### Identity / Tenant Foundation

- M2C.3 Production grant containment, M2C.4 additive UUID foundation and M2C.5 first private companion binding are complete according to retained checkpoint documents.
- The verified private Auth account is bound to the first active `companion_instances` root. The approved legacy `user` cohort was backfilled to that owner; excluded rows remain quarantined rather than guessed or reassigned.
- The Private Trusted Identity Bridge is implemented across the current private API routes: Supabase JWTs are cryptographically verified, issuer/audience/expiry/subject are checked, the subject must match the configured private owner, and an active companion binding is required. Client-supplied UUID ownership is rejected.
- The mobile client includes private Supabase enrollment/session persistence. A fixed app-token fallback exists only as an explicit compatibility switch; it is not a multi-user identity model.
- Private runtime still preserves the legacy logical owner lane where required for compatibility. UUID foundation does not itself authorize UUID-authoritative writers, broad RLS changes, account switching or a Public client.

### Mobile / Release

- EAS production builds use the `production` channel; Expo Updates uses the existing EAS project and `runtimeVersion.policy = fingerprint`, preventing native-incompatible OTA updates from targeting a different runtime.
- Development and preview builds use separate channels. Production bundle identifier and EAS project identity remain unchanged.
- Production iOS Build 17 is in TestFlight, installed and real-device verified. It includes `expo-media-library`; generated images can be saved directly to iPhone Photos.
- Generated-image long press is available from both thumbnail and fullscreen preview, with “保存至本地” and “保存至共享相册”. Local success reports “保存成功”; shared-album save reuses the existing import/editor/upload path.
- Memory Library management, chat/history, attachments, voice-message STT/TTS, Moments, shared album, diary, favorites and generated-image interactions are present in the private mobile client.
- Voice Call Phase 0 media Checkpoints A/B remain complete but paused before Checkpoint C STT/model-pipeline expansion.

## Paused / Incomplete

- **Public App** — the separate repository exists at `/Users/hxj/Documents/xiaoc-public`; registration, public sign-in/recovery/logout, account lifecycle, onboarding, deployment UX and Own Stack setup progress must be tracked there, not inferred from `memory-api`.
- **M2C.6+** — Core tenant constraint validation, remaining-domain UUID work and any later authority cutover are not started. No further UUID migration is authorized by this document.
- **RLS** — M2C.3 grant containment is not equivalent to completed tenant RLS. The five Core tables documented by M2C.4 retained RLS-off/service-mediated behavior at that checkpoint. Current live catalog state beyond retained evidence needs fresh read-only verification before future work.
- **Multi-user** — XiaoC Private is not being converted into a multi-user client. It has no account switcher, public registration, organization/team model, billing or shared quotas.
- **Hosted SaaS** — subscriptions, pooled provider credits, subsidies, abuse controls and managed customer infrastructure are deferred and are not Public App v1 requirements.
- **Memory future work** — deep tool-loop retrieval and heat/cold/archive lifecycle remain later work. Shared Context expansion is paused after Batch 1.
- **Voice Call** — Checkpoint C and later realtime voice-model integration remain paused.
- **Judge prefilter** — deterministic prefilter remains observational/Shadow unless separately authorized by sufficient production evidence.

## Next

1. Resume Public App only in `/Users/hxj/Documents/xiaoc-public`; do not build it under `memory-api/public/` or add multi-user UX to XiaoC Private.
2. Before Public implementation, write the Own Stack bootstrap contract: required user-owned services, secret placement, migration/version compatibility, health checks, rollback and upgrade path.
3. Define the Shared Backend extraction boundary from current private code. Share generic mechanisms only; require explicit configuration and separate data stores/credentials for each Public installation.
4. Reassess M2C.6+ as an Engine identity/data-isolation project. Start with fresh read-only schema/RLS/runtime evidence and separate approval; do not infer authorization from M2C.5 completion.
5. Continue production observation of owned Memory retrieval, Core/PIN behavior and Moments material selection; keep the Production-passed Connectome-lite, cache keepalive and generated-image baseline frozen unless a demonstrated blocker appears.
6. Keep the private iOS release path healthy: Production EAS build for native/config changes, Production OTA only for JS/TS changes compatible with the installed fingerprint runtime.

## Current Architecture Boundaries

### Product boundary

```text
XiaoC Private client
  -> Private API/runtime
  -> Private Supabase, provider accounts, persona/memory/relationship state

XiaoC Public (`/Users/hxj/Documents/xiaoc-public`, separate repo/client)
  -> user-owned Own Stack deployment
  -> user-owned Supabase/Vercel/providers/data

Shared Backend
  = reusable mechanisms and contracts
  != shared tenant, credentials, quota, persona, Memory or relationship state
```

### Runtime boundary

- Mobile clients call the service-mediated API; service code resolves trusted identity and owner scope. The client cannot select an arbitrary UUID owner.
- Memory authority, Core Snapshot, retrieval eligibility and lifecycle protection remain server-owned. Production is `owned_authoritative`; Ombre must not re-enter normal runtime I/O.
- Memory existence/retrieval is not proactive eligibility. Summary, Active Context and proactive events retain distinct responsibilities.
- Current XiaoC Private data and provider accounts must never become defaults or fallbacks for Public installations.
- No new `api/*.js` Function may be added while the repository remains at `12/12` without first consolidating an existing Function.

## Known Technical Debt / Follow-up

- Dedicated Memory and multi-user design documents intentionally retain historical checkpoint status. They are evidence records, not the canonical present-tense snapshot; this file takes precedence for current status.
- `docs/memory-context-architecture.md` still contains Ombre-era present-tense wording and an older cache/accounting snapshot. It needs a separate architecture-focused update before being treated as fully current.
- Railway Ombre service/Volume/historical data remain only for rollback/archive. Final retirement and cleanup are paused backlog work and require separately approved, recoverable handling; normal Production runtime must not use them.
- Service-role mediation is still broad. Per-domain RLS/credential narrowing must follow M2C checkpoint discipline and cannot be inferred from JWT verification alone.
- Production deployment state is partly external to git. EAS build/update IDs, Vercel environment switches, Supabase catalog state and provider routing must be rechecked at the start of release or migration work.
- Generated-image and Moments media paths need continued privacy, signed-URL and lifecycle observation; no evidence here authorizes changing storage policy.
- The old `265/265` full-suite baseline is obsolete. Do not quote a new full-suite number until it is intentionally rerun.

## Needs Confirmation

- Exact Production OTA update currently selected by installed devices.
- Current live values of identity compatibility switches and whether fixed app-token fallback is still enabled.
- Current live RLS/policy/catalog state outside the completed M2C.3–M2C.5 evidence.

## Development Guardrails

- Read `docs/PRODUCT_VISION.md`, `docs/DEVELOPMENT_PRINCIPLES.md`, this file and `docs/memory-context-architecture.md` before Memory/Context or identity work.
- Do not expose secrets, private Memory bodies or personal identifiers in docs, tests, logs or reports.
- Do not modify XiaoC Private runtime, enable UUID writers, apply schema/RLS changes or deploy merely to make documentation match a desired future state.
- Prefer small, reversible changes with focused verification. Preserve owner/lifecycle/provenance/authority, prompt budgets and user-visible continuity.
- Public App work must preserve Own Stack isolation and must never default to XiaoC Private infrastructure.
