# XiaoC Multi-user M1 — Identity & Tenancy Design

> Status: DESIGN ONLY
>
> Backend tenancy model: every account owns one independent private companion instance.
>
> This document does not authorize code, schema, configuration, migration, deployment, or production changes.

## 1. Decision summary

Use Supabase Auth as the account and session authority. The immutable internal tenant identity is `auth.users.id` (UUID), exposed in a verified access token as `sub`. Do not build a separate password/session service.

The server must derive the effective user from the verified access token. A `user_id` supplied in a query, request body, path, metadata object, task payload, or client preference is never authorization evidence.

Every account receives an isolated companion instance. A platform-level Persona template may be shared and versioned, but Relationship state, Core, Memory, Summary, Active Context, Recent, user content, preferences, storage, notifications, usage attribution, and background work are tenant-owned.

This is a backend tenancy rule, not a requirement to turn the existing `mobile/XiaoC` client into a public multi-account product. The client boundary is:

- `mobile/XiaoC` remains the existing private XiaoC App. It will bind only to the first real Supabase Auth UUID and does not need public registration or account-switching UI.
- The backend in this repository is progressively upgraded into the shared multi-tenant backend used by private XiaoC and the future Public App.
- The future Public App is a separate client in a separate repository. It owns public registration, sign-in, recovery, logout, account lifecycle, branding, release credentials, and public-product UX.
- Public XiaoC v1 uses an **Own Stack** model. Users provide and pay for their own infrastructure and model/API keys; v1 is not a Hosted/managed SaaS.
- Hosted-only payments, subscriptions, shared model allowances, cost subsidies, and abuse-control systems are deferred. Their absence does not weaken the tenant identity or data-isolation contract.
- Shared backend capability does not make private prompts, Relationship state, seed content, client configuration, or release credentials shared product assets.

The current private mobile XiaoC is the first real companion/account. M2C.5 continues to bind legacy `user_id='user'` to the explicitly approved Auth UUID `17aa1bd0-931d-40a0-b0d6-ef75c641c7b3`. After that checkpoint, M2C.6+ must be re-reviewed: retain work required for XiaoC Engine identity and tenant-safe data; defer work justified only by operating a Hosted SaaS. This review does not authorize creating the Public App repository.

Multi-user foundation may be built while Ombre remains authoritative for the legacy private user. New multi-user accounts must not enter Ombre until Ombre is proven tenant-safe or replaced. There must be no multi-user production launch while the current global Ombre PIN/admin paths remain reachable for multiple accounts.

## 2. Recommended auth architecture

### 2.1 Account authority

- Adopt Supabase Auth in the existing Supabase project unless Production discovery finds a material constraint.
- Use `auth.users.id` as `user_uuid uuid`, the canonical, immutable internal owner ID.
- Treat email, phone, display name, provider subject, and legacy string `"user"` as mutable attributes or aliases, never as primary/foreign keys.
- Add an application profile/companion root keyed one-to-one by `user_uuid`. It holds lifecycle and non-secret configuration, not authentication credentials.
- Initial sign-in should use one deliberately selected Supabase Auth method. Email magic link or email/password are both compatible; the final UX choice is not a tenancy decision. Avoid SMS unless a concrete requirement justifies its operational and recovery cost.
- Require verified email before creating or migrating a companion instance.

### 2.2 Client session lifecycle

The session security rules below apply to both clients, but their product surfaces differ: private XiaoC has a single-account binding/recovery flow, while the future Public App owns the complete public account lifecycle.

- The Expo app uses the Supabase client with the public/publishable project key. No service secret is shipped.
- Persist the Supabase session using a secure mobile storage adapter: refresh token in OS-protected secure storage; access token may be retained with the session adapter but must not be copied into ordinary AsyncStorage or logs.
- On launch, restore the session, refresh when needed, then hydrate tenant-owned cloud/local state for the verified `session.user.id`.
- Refresh is serialized so concurrent API calls do not race token rotation. A refreshed session replaces the previous stored session atomically.
- Logout order: stop polling/background listeners and audio work; cancel in-flight requests; sign out/revoke the session as supported; clear in-memory state; remove tenant-local cached data and pending notification navigation; return to signed-out UI.
- Password/Face ID may remain an optional local privacy lock, but it is not cloud authentication and must not select a `user_uuid`.
- In the Public App, account switching is a full logout/login boundary. No previous account state may render while the next account hydrates. The private XiaoC App does not expose account switching.
- Auth and authenticated API responses use `Cache-Control: private, no-store`.

### 2.3 Actor separation

Use an explicit request actor union:

```text
user actor    { kind: "user", userUuid, sessionId?, authMethod, claims }
service actor { kind: "service", serviceName, runId }
cron actor    { kind: "cron", jobName, runId }
admin actor   { kind: "admin", adminUserUuid, capability, reason, auditId }
```

- `user`: verified Supabase access token; can operate only on its own tenant.
- `cron`: verified scheduler secret; cannot impersonate a user from arbitrary request input. It claims stored tasks and adopts the task's persisted owner only inside the worker repository.
- `service`: backend-only workload identity for queue/migration/maintenance. Each service gets the narrowest callable surface possible.
- `admin`: separate authenticated admin identity plus explicit capability check, reason, immutable audit record, and preferably step-up authentication. An App token is not admin identity.
- Never silently fall back from a failed user token to service or compatibility mode.

The existing private App token can remain temporarily as a release/channel guard during migration, but it must be layered outside user authentication and must never produce a user actor.

## 3. Trusted identity model and request boundary

### 3.1 Unified authenticated request context

Every ordinary API route runs a shared authentication step before parsing business identifiers:

```text
Authorization: Bearer <Supabase access token>
        ↓ verify signature, issuer, audience, expiry and required claims
TrustedRequestContext {
  actor.kind = "user"
  actor.userUuid = verified JWT.sub
  requestId
  authSessionId (when available)
}
        ↓ repository/service methods receive userUuid explicitly
```

Rules:

1. `ctx.actor.userUuid` is the only effective owner for user routes.
2. A legacy `user_id` field is ignored for authorization during compatibility, then rejected. If temporarily accepted for shape compatibility, it must equal the server-derived legacy alias and must never override `ctx`.
3. Every repository method that touches tenant data requires `tenant.userUuid`; helpers must not default it.
4. Child IDs (`conversation_id`, `message_id`, `moment_id`, bucket ID) never prove ownership. Resolve them under the tenant.
5. Internal API-to-API calls propagate either the original user access token or a signed, audience-bound internal service credential plus an immutable persisted owner. They do not copy an unverified request `user_id`.
6. Error responses should not reveal whether another tenant owns an identifier; return tenant-local not-found.

### 3.2 Retirement of `APP_USER_ID="user"`

Use four compatibility stages:

1. **Inventory/freeze:** prohibit new defaults and record every use of `APP_USER.defaultUserId`, mobile `APP_USER_ID`, literal `"user"`, and user-bearing internal call.
2. **Dual identity plumbing:** introduce authenticated context and a server-only legacy alias map. The existing private account resolves to its real UUID; current stored rows remain unchanged.
3. **Data migration:** rewrite legacy ownership to the UUID using the migration plan below. Reads may temporarily support UUID plus legacy alias; writes go only to UUID.
4. **Removal:** reject client `user_id`, delete all runtime fallbacks/defaults, remove the alias after verification and rollback expiry. Historical migration manifests may retain `"user"` as provenance, not as an active owner.

No new account may ever be assigned the literal owner `"user"`.

## 4. Tenant isolation contract

### 4.1 User-owned data

The following are always tenant-owned:

- companion instance/profile, Relationship state and user-specific Persona overrides;
- conversations, messages, attachments, generated files and voice assets;
- Summary, Summary Segments, Core Snapshot and Core source identity;
- Stable/Dynamic Memory, pins, embeddings, provenance, relations, operations and import state;
- Active Context, Shared Context and all attention/proactive state;
- Diary, Favorites, Treehole, Moments, comments, interactions and album assets;
- user preferences, model selection, timezone/location, notification settings and push tokens;
- tasks, schedules, cooldowns, limits, idempotency records, audits and user-attributed cost/usage;
- local caches, drafts, last-open state, downloaded media and notification navigation state.

Shareable platform data is limited to versioned, immutable templates/configuration such as the base Persona text, safety policy, model catalog, prompt template version and public static assets. A user-specific rendering or accepted version reference is tenant-owned.

### 4.2 Identifier rules

- New `conversation_id` values must be globally unique UUIDs. Global uniqueness reduces collision and observability risk but never replaces owner checks.
- Existing textual conversation IDs may remain during migration behind `(user_uuid, conversation_id)` uniqueness.
- New domain entity IDs should be UUIDs/ULIDs with high-entropy global uniqueness.
- Every tenant-owned table has `user_uuid uuid not null references auth.users(id)` or references an application tenant root with equivalent integrity.
- Child tables use composite tenant-aware foreign keys where practical: `(user_uuid, conversation_id)`, `(user_uuid, message_id)`, `(user_uuid, memory_id)`. The database must reject cross-tenant parent/child links.
- All tenant natural/unique keys include `user_uuid`, unless the ID is intentionally globally unique and a separate composite ownership constraint still protects relationships.

### 4.3 Qualification rules

- **DB queries:** include `user_uuid = ctx.actor.userUuid`; RLS repeats the same boundary as defense in depth.
- **RLS:** ordinary authenticated policies use `(select auth.uid()) = user_uuid` for both `USING` and `WITH CHECK`. Grants and policies are reviewed together. Views and RPCs receive the same audit.
- **RPC:** ordinary user RPCs derive the owner from `auth.uid()` internally; they do not accept an authoritative `p_user_id`. Service-only RPCs may accept an owner but must be revoked from `anon/authenticated` and narrowly granted.
- **Unique/idempotency:** `(user_uuid, operation_type, idempotency_key)` or equivalent. Client idempotency values are bounded and cannot collide across tenants.
- **Cache:** every private cache key begins with a versioned tenant prefix, e.g. `v1:{user_uuid}:{resource...}`. Cache eviction requires the same owner. Private values never use query-only/global keys.
- **Provider session:** use an opaque tenant-qualified session identity derived from `user_uuid + conversation_uuid`, preferably HMAC/hash rather than exposing raw IDs.
- **Storage:** canonical object prefix `{user_uuid}/{resource_type}/{resource_uuid}/...`; use the raw canonical UUID, not a lossy sanitized external identity. DB ownership is checked before signing. Storage policies use authenticated ownership when clients access Storage directly.
- **Logs/analytics:** attach opaque tenant hash and request/run IDs; never log message, Memory, Summary, prompt, push token, signed URL, auth token, or provider secret.

### 4.4 Service-role boundary

Service/secret credentials are permitted only for:

- scheduled task claiming and execution;
- controlled data migration/backfill/repair;
- provider callbacks that cannot carry a user JWT, after verifying callback identity and resolving a persisted owner;
- observability retention cleanup and explicitly approved administration;
- server-mediated Storage work that genuinely cannot use user-scoped authorization.

Ordinary chat, history, content CRUD, preferences, search, attachment signing and user-triggered Memory operations should execute with user JWT/RLS or through server repositories that preserve the user JWT. A service-role client must be separate from any user-scoped client and never reused as a global default.

## 5. Legacy `"user"` migration strategy

### 5.1 Migration invariants

- Create and verify the first real Supabase Auth account before touching data.
- Create a signed migration manifest: target UUID, table counts, per-table primary keys, storage object list/checksums, local migration version, and rollback deadline. Never include private content in logs.
- Quiesce writes for the legacy tenant during the final apply, or use a formally designed dual-write/capture mechanism. A long best-effort migration while chat/background tasks keep writing is not acceptable.
- Migrate parent tables before children, preserving stable entity IDs and timestamps.
- Validate zero remaining active owner references to `"user"`, zero orphan relationships, equal counts/checksums, and two-user negative isolation tests before cutover.
- Keep the legacy alias mapping server-only and time-limited.

### 5.2 Domain coverage

| Domain | Migration design | Rollback evidence |
| --- | --- | --- |
| Chat/History | Rewrite conversation and message ownership; establish composite ownership constraints; preserve message/conversation IDs and client idempotency IDs. | Row IDs, counts and per-conversation hashes; reverse owner map. |
| Summary/Core | Add/backfill owner before enabling multi-user reads; bind every summary to an owned conversation; preserve snapshots, hashes, source IDs and checkpoints. | Snapshot/hash/checkpoint manifest; no summary without one owned conversation. |
| Memory | Rewrite legacy Supabase memories and all native Memory Engine tables in dependency order; preserve origin alias/provenance. | Memory, pin, embedding, relation, provenance and operation integrity checks. |
| Diary | Rewrite entry owner; preserve dates, titles, sections and replacement semantics. | ID/count/content-hash manifest. |
| Treehole | Rewrite entries, draft/cloud markers, tasks and audit attribution. | Entry/task/audit count and source link checks. |
| Moments | Rewrite moments, comments, candidates, activity, interaction state and audit rows together. | Referential and unique-key validation. |
| Favorites | Move the legacy preferences collection intact, then optionally normalize later; do not combine migration with redesign. | Ordered normalized favorite digest. |
| Album | Rewrite asset owner and all Moment/message references; move/copy object paths to UUID prefix before updating DB references. | Old/new object key, size and checksum map. |
| Preferences | Rewrite `user_state`, client preferences, inactivity/weather/model settings. | Canonical JSON digest excluding ephemeral signed URLs. |
| Push | Bind token/settings to UUID; invalidate legacy delivery state and re-register from the authenticated device after cutover. | Registration timestamp and redacted token fingerprint. |
| Proactive tasks | Pause worker; rewrite owner on pending/processing/history rows plus event/idempotency references; recover or terminate stale processing deterministically. | Status/count/event-ID reconciliation. |
| Storage | Copy to UUID-prefixed destination, verify size/checksum, update DB transactionally where possible, retain old objects read-only until rollback expiry. | Complete object mapping and reference scan. |
| Local state | In private XiaoC, after authenticated legacy-owner claim, migrate unnamespaced keys once into the bound first account's `{user_uuid}` namespace. Mark completion only after cloud claim succeeds. This does not add public registration or account switching. | Local migration version; keep a recoverable backup until verification. |

### 5.3 Apply and rollback shape

Recommended apply sequence:

1. Production metadata snapshot and backup/PITR confirmation.
2. Create verified auth account and companion root.
3. Pause legacy writes, Cron and push delivery.
4. Apply database owner backfill in dependency order.
5. Copy/verify Storage and rewrite references.
6. Run referential, count/hash and cross-user denial checks.
7. Enable UUID reads/writes; migrate the authenticated device's local state.
8. Resume workers and push; observe before deleting any old path or alias.

Rollback before the expiry gate:

- pause writes/workers again;
- use the manifest to restore legacy ownership and object references, or restore the pre-apply backup;
- return the client to the legacy-compatible build/path;
- retain new UUID data for forensic comparison rather than merging blindly;
- do not delete legacy objects until rollback is formally closed.

## 6. Ombre coexistence strategy

Use a legacy containment boundary:

- Ombre remains authoritative only for the migrated first/private account during M2–M3.
- The Ombre adapter accepts a trusted tenant context, never request `user_id`.
- It must enforce an allowlist containing only the legacy account UUID and map that UUID internally to Ombre's legacy identity.
- Global PIN listing, admin bucket reads, and pin/update/delete operations remain inaccessible to all other accounts.
- Ombre responses and caches are tagged with the trusted UUID; no global or conversation-only cache key is allowed.
- New accounts are not enabled in production until M4 supplies either verified Ombre tenancy or XiaoC Memory Engine authority for those accounts.
- XiaoC Memory Engine Shadow continues unchanged for the legacy account until its own approval gate. Multi-user foundation work does not imply cutover, merge, fallback, or Shadow expansion.
- Before multi-user launch, run an explicit two-account Memory isolation gate covering retrieval, Core construction, mutations, cache collision, provenance and prompt assembly.

## 7. Production database discovery required before M2

M2 must begin with a read-only, timestamped Production inventory. Obtain:

1. **Schemas/tables/columns:** all exposed and private schemas; data types, defaults, nullability, identity/generated columns and comments.
2. **Keys/integrity:** primary, unique, foreign and check constraints; FK column order, referenced keys, deferrability and delete/update actions.
3. **Indexes:** definitions, partial predicates, uniqueness and expression indexes.
4. **RLS:** `relrowsecurity`, `relforcerowsecurity`, every policy's roles/command/`USING`/`WITH CHECK`, and tables in exposed schemas without RLS.
5. **Privileges:** schema/table/sequence/function grants; default privileges; role membership; roles with `BYPASSRLS`; anon/authenticated/service access.
6. **Functions/RPC:** signatures, owner, language, volatility, `security definer/invoker`, `search_path`, grants and source definitions.
7. **Views/materialized views:** definitions, owners, security mode and grants; verify that no view bypasses tenant RLS.
8. **Triggers:** trigger definitions and invoked function security.
9. **Data API exposure:** exposed schemas, API settings and any pre-request hook.
10. **Auth:** enabled providers, email confirmation, JWT issuer/audience/signing keys, session/refresh settings, hooks and existing auth users/identities metadata counts.
11. **Storage:** buckets, public/private flags, limits/MIME rules, `storage.objects` policies/grants, `owner_id` population, object keys/sizes/checksums/metadata, and DB columns containing object paths.
12. **Data ownership profile:** per-table counts by current `user_id`, null/blank/unknown owners, duplicate IDs across tenants, orphan references, conversation-ID reuse and rows containing legacy `"user"`.
13. **Operational state:** pending/processing tasks, push registrations, webhook/provider callbacks, scheduled jobs, extensions, backups/PITR availability and migration history.

Store the sanitized schema baseline in the repository before designing the M2 migration. Do not store auth tokens, private content, push tokens, signed URLs or secrets.

## 8. Implementation roadmap

### M2 — Database Isolation

- Complete Production discovery and ownership matrix (**P0 dependency**).
- Decide canonical tenant root and Auth deletion/lifecycle behavior (**P0 dependency**).
- Add UUID owner columns and composite ownership constraints.
- Fix Summary/Core and Shared Context tenancy first.
- Build least-privilege grants, RLS and two-user allow/deny database tests.
- Design migration/rollback SQL and dry-run artifacts; do not apply until separately approved.

Exit gate: every tenant table/RPC/view/storage reference has an owner rule; cross-tenant DB tests fail closed; legacy migration is reversible.

### M3 — API Runtime Isolation

- Add the unified request context and actor-specific clients.
- Convert all user routes and internal calls to trusted `userUuid`.
- Remove authorization use of request `user_id` and all runtime defaults.
- Tenant-qualify caches, provider sessions, idempotency and logs.
- Restrict service/cron/admin routes and add IDOR tests.

Exit gate: changing any client-supplied owner or child ID cannot cross tenant; ordinary API paths do not use an unrestricted service client.

### M4 — Memory/Companion Isolation

- Separate shared Persona template from per-user companion/Relationship state.
- Make Core, Summary, Active/Shared Context, Recent and native Memory fully tenant-bound.
- Contain Ombre to the legacy account, then separately decide tenant-safe Ombre versus Memory Engine cutover.
- Add two-account prompt/caching/retrieval/mutation isolation tests.

Exit gate: no Memory/Context component or prompt block can originate from another tenant; new-account production strategy no longer depends on global Ombre.

### M5 — Mobile Account Lifecycle

- Private XiaoC: bind to the first real Supabase Auth UUID; implement secure session restore/refresh and owner recovery without public registration or account-switching UI.
- Private XiaoC: namespace every local key/cache/file by the bound UUID and perform the one-time legacy local migration.
- Future Public App, in its separate repository: implement registration, sign-in, refresh, recovery, logout, account switching, and full account lifecycle.
- Both clients: isolate notification navigation and local state by verified UUID; preserve any local privacy lock as a separate layer from cloud authentication.

Exit gate: private XiaoC can access only its bound first account and preserves its existing experience; separately, Public App two-account device tests show no stale content, settings, media or navigation from the prior account.

### M6 — Product Migration/Rollout

- Migrate domains in controlled order: Chat/Summary/Core, Memory, content surfaces, Storage, preferences/push, background tasks, then usage/admin.
- Create the first real account and rehearse legacy migration against a production-shaped copy.
- Run two-account adversarial isolation and rollback rehearsal.
- Migrate the existing private user with a write pause and manifest.
- Enable additional accounts gradually; retain kill switches and tenant-level observability.

Exit gate: migration reconciles, rollback is proven, Ombre launch blocker is closed, and no P0 isolation exception remains.

## 9. P0 blocking dependencies

1. Complete Production schema/RLS/grants/RPC/Storage discovery.
2. Establish Supabase Auth and the immutable UUID/companion-root lifecycle decision.
3. Repair `conversation_summary`/Core ownership and all conversation-only keys before a second account can write.
4. Replace client-controlled `user_id` with verified request context across every ordinary API route.
5. Add tenant-aware DB constraints and tested RLS; service-role filtering alone is insufficient.
6. Tenant-qualify private caches, provider sessions, Storage paths and idempotency.
7. Contain Ombre to the legacy UUID and prevent all other accounts from its global PIN/admin paths.
8. Complete reversible legacy data and local-state migration rehearsal.
9. Pass two-user negative tests across DB, API, Memory prompt assembly, background tasks, push and Storage.

No second production account may be admitted before blockers 1–7 are closed. No legacy migration may run before blocker 8 is closed. No general rollout may begin before blocker 9 and the Ombre M4 exit gate are closed.

## 10. Recommended next step

Proceed to **M2 Database Isolation design and read-only discovery only**. First produce the sanitized Production schema baseline and a table-by-table ownership matrix. Do not write migration SQL against inferred schemas, and do not change Production until that design receives separate approval.
