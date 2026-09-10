# XiaoC Multi-user M2C.1 — Read-only P0 Evidence & Decision Pack

> Status: READ-ONLY EVIDENCE COMPLETE WITH OPERATIONAL GAPS
>
> Evidence time: 2026-09-10 (Production catalog and repository callers)
>
> This document does not authorize Production changes, migration SQL generation or execution, application-code changes, deployment, commit, or push. No private message, Summary, Memory, Moment, Diary, Treehole, filename, object body, token, secret, or signed URL was selected.

## 1. Outcome

M2C.1 closed the database evidence needed to distinguish the three legacy owner cohorts, classify the six known orphans, and identify the immediately containable RPC exposure. It also confirmed the live Cron and Storage object shape and the current Private App service-role lane.

The evidence is sufficient to start **M2C.2 rehearsal design with synthetic data**. It is not sufficient to perform M2C.3 or any Production schema/data checkpoint because Auth platform configuration and backup/PITR restore capability are not yet verified, and the owner/account decisions in section 8 remain unapproved.

Evidence completeness: **PARTIAL (database/repository PASS; platform operational controls PARTIAL)**.

## 2. Evidence method and privacy boundary

- Production queries selected catalog definitions, owner aliases, counts, time ranges, lifecycle states, hashed row/reference keys, relationship counts, Storage path classes/depth, and operational configuration only.
- Orphan row and parent identifiers were represented by one-way digests in the working result. Raw identifiers are not recorded here.
- Function definitions were inspected because they are schema metadata. Repository callers were found by static call-site search.
- Storage names and object bytes were not selected. Only bucket, depth, top-level prefix class, count, timestamps, `owner_id` population, size-metadata availability, and ETag availability were selected.
- Downloaded query-result CSVs are temporary local working evidence under `~/Downloads`; they are not repository artifacts and are not included in git.

## 3. Legacy owner cohorts

Production currently has exactly three observed raw owner aliases in the inspected user-owned tables.

| Cohort | Classification | Tables and counts | UTC range | Evidence-based conclusion | Migration posture |
| --- | --- | --- | --- | --- | --- |
| `user` | **private-current** | 19 table groups: `messages` 3,840; `conversations` 6; `user_state` 1; `memories` 28; `xiaoc_proactive_tasks` 1,217; plus current Album, Moments, Diary, Treehole, audits, and the 150-row Memory Engine import set | earliest represented source time 2026-06-10; active through 2026-09-10 | This is the only cross-domain currently active cohort. The 150 imported Memory rows are a deliberate, verified production import, not a stale-import cohort. | Preserve. Do not bind to an Auth UUID until the user approves the first private account mapping. |
| `small_c` | **historical-valid** | `messages` 3,271; `conversations` 48; `memories` 3; `user_state` 1; `xiaoc_proactive_tasks` 1 | 2026-07-02 through 2026-08-18 | Internally coherent historical Chat/Core-related cohort with parent/child distribution and weeks of activity. It is not evidence of test debris and must not be deleted or silently merged. | Preserve as a separate registry group. Default to quarantine from authenticated tenants until its target account or merge is explicitly approved. |
| `test` | **test-prototype** | `messages` 2; `conversations` 1 | 2026-07-26 11:44:03–11:44:14 | A single, isolated conversation/message burst lasting about 11 seconds, with no state, Memory, Moments, or later activity. Evidence is sufficient for test-prototype classification. | Quarantine by default. No product decision is needed to keep it unreachable; deletion would require a separate later approval. |

No separate **stale-import** owner cohort was found. No unexplained fourth alias was found. This does not turn either `user` or `small_c` into an approved person-to-account mapping: that remains an explicit decision.

The mapping registry must therefore begin with three immutable groups rather than a string replacement rule. Each record should capture raw-alias fingerprint, connected tables/counts, observed range, classification, review state, target UUID (nullable), rollback group, and evidence digest. `unknown` remains the mandatory state for any newly appearing alias or disconnected component.

## 4. Known orphan evidence and recommendation

| Orphan | Metadata evidence | Recommendation | Why |
| --- | --- | --- | --- |
| 1 `conversation_summary` row | updated 2026-07-31; last summarized immediately before; no Core snapshot; parent conversation absent; zero messages with that conversation ID | **retain + quarantine** | There is no surviving lineage from which to prove an owner or repair the parent. Do not attach it to either legacy cohort. It may become a delete-candidate only after a retention decision and rollback artifact. |
| 3 `moment_candidates.published_moment_id` rows | all owner `user`, lifecycle `published`; updated 2026-08-31/09-01; each still has exactly one same-owner source lineage, but the published Moment parent is absent | **retain broken-link history + quarantine from constraint scope** | Source provenance survives, but there is no evidenced replacement Moment ID. Clearing or inventing the published reference would falsify history. They may become delete-candidates only as a separately approved stale-history cleanup. |
| 1 `moment_xiaoc_activity` row | owner `user`; terminal `skipped`; updated 2026-08-17; source version 1; Moment absent; no linked comment or private-follow-up message | **retain terminal audit + quarantine** | It cannot legitimately execute and has no child side effect to repair. |
| 1 `moment_xiaoc_activity` row | owner `user`; terminal `completed:private_follow_up`; updated 2026-08-17; source version 1; Moment absent; no surviving linked comment or private-follow-up message | **retain terminal audit + quarantine** | Completion history should not be re-run or reconstructed. Absence of the old side-effect reference is not evidence for a replacement. |

No orphan should be assigned to the first account merely because its surviving owner alias is `user`. Quarantine means excluded from UUID backfill, authenticated reads, prompt/context assembly, signing, workers, and FK validation scope while the original row remains recoverable.

## 5. SECURITY DEFINER, RPC, and caller findings

### 5.1 Production function inventory

- 30 functions exist in `public`; 22 are `SECURITY DEFINER`.
- All 22 `SECURITY DEFINER` functions have a function-level `search_path`. Memory Engine functions generally use `public, extensions, pg_catalog`; integrity/cleanup functions use a catalog-qualified path; two older Moment functions use `public` only.
- All callable Memory Engine write/retrieval/import functions are denied to `anon` and `authenticated` and executable by `service_role` only. Trigger-only/internal helpers are not service RPC entry points.
- Five `SECURITY INVOKER` functions have inherited `anon`/`authenticated` EXECUTE: the guard functions return `trigger` and cannot be used as ordinary RPC business operations. Their public EXECUTE is unnecessary ACL noise and can be removed in the same narrow containment checkpoint after rehearsal.
- The sole externally exposed `SECURITY DEFINER` writer is `check_pending_moments_for_xiaoc()`.

### 5.2 Function-body conclusions

| Function/group | Body finding | Containment timing |
| --- | --- | --- |
| `check_pending_moments_for_xiaoc()` | Zero parameters, no `auth.uid()`, and globally updates every due `moment_xiaoc_activity` row. `anon`, `authenticated`, and `service_role` can execute it. No live repository caller was found; the current worker uses the HTTP worker route instead. | **M2C.3 first:** revoke `anon`/`authenticated`; retain service only temporarily or retire later after a separate dependency decision. No tenant UUID/backfill is needed for this grant revocation. |
| `claim_moment_check(...)` | Service-only and checks `(p_user_id, p_conversation_id)` before insert. It does not independently prove that both supplied source message IDs belong to that same tenant/conversation. Repository caller: `api/chat.js`, through a service-role Supabase client. | Current grant is already contained. Add tenant-qualified source-message validation only after UUID ownership/backfill/constraints exist. |
| `initialize_core_memory_snapshot(...)` | Service-only `SECURITY INVOKER`, but has no user argument and upserts/selects on globally unique `conversation_id` alone. Repository caller: `api/chat.js`. | Keep service-only. Replace with tenant-qualified conflict/lookup semantics only after Summary/Core UUID foundation and backfill. |
| `patch_client_preferences(...)` | Service-only `SECURITY INVOKER`; caller controls text `p_user_id` and the function upserts directly by that value. Repository caller: `api/user-state.js`. | Keep service-only. Tenant-qualify after UUID `user_state` ownership exists; a future user-facing path must derive identity from `auth.uid()` or a verified API token. |
| `cleanup_xiaoc_observability_audits(...)` | Service-only global retention delete; validates retention to 30–365 days and has fixed `pg_catalog, public` search path. Repository caller: `lib/backgroundObservability.js`. | Keep permanently service-only. No user RPC variant is needed. |
| `xiaoc_memory_*` write/import/retrieval RPCs | Caller-provided `p_user_id` is consistently the service-scoped tenant selector; bodies use explicit table qualification and owner filters. Actual callers are Memory repository/embedding code and controlled historical-import scripts, all using `SUPABASE_SERVICE_ROLE_KEY`. No `auth.uid()` path exists. | Keep service-only through M2/M3. UUID-qualify parameters and child ownership checks only after the native Memory domain is backfilled; do not expose directly to authenticated clients. |

All Production API Supabase clients found in the repository use `SUPABASE_SERVICE_ROLE_KEY`. No mobile direct Supabase client or direct Storage caller was found. The Private App currently reaches Supabase through Vercel endpoints and its existing private/cron authorization lane. This supports narrow M2C.3 function-grant containment, but it does not authorize broad table-grant or RLS changes.

## 6. Operational readiness

### 6.1 Confirmed

- **Cron:** exactly two active `postgres` jobs were observed: Moment interaction every minute and the shared background worker every five minutes. Commands were classified by endpoint without recording URL or authorization material. Both are write-capable operational lanes and require an explicit pause/drain/canary procedure before a future data backfill.
- **Storage inventory:** 142 objects across five buckets were observed. All 142 have size metadata and an ETag; none has `owner_id` populated.
  - `album-images`: 22 depth-2 legacy-owner objects and 75 depth-3 unqualified objects.
  - `chat-images`: 8 depth-1 unqualified objects.
  - `generated-files`: 33 depth-4/5 legacy-owner objects.
  - `moment-images`: 3 depth-2 legacy-owner objects.
  - `xiaoc-memory-backups`: 1 depth-3 unqualified object.
- **Storage verification capability:** object size plus ETag supports inventory/copy reconciliation. ETag alone must not be treated as a guaranteed content checksum; a future copy rehearsal needs source/destination byte-size equality and a downloaded cryptographic digest or an independently stored source digest.
- **Polymorphic tasks:** observed `source_type` values are `conversation`, `message`, `moment`, `proactive_attention_event`, `proactive_message`, `treehole`, and `weather_window`. Required conversation/message references in completed send paths had zero missing-or-cross-owner matches. Null message/conversation columns on skipped, weather, treehole, Moment, and event tasks match their type-specific lifecycle rather than proving corruption.
- **Data API surface:** M2A catalog evidence still confirms `public` tables/functions have PostgREST-facing role grants, with broad table defaults and the RPC exposure described above. Session-local `pgrst.*` settings returned null and therefore do not prove the dashboard exposed-schema/pre-request configuration.
- **Private compatibility lane:** repository callers confirm service-role database access, server-side Storage upload/signing, and no mobile Supabase client. Current API authorization is the existing Private App/cron contract, not Supabase Auth sessions.

### 6.2 Still unconfirmed; do not infer

- Dashboard Data API exposed-schema list and any configured pre-request hook.
- Auth providers, JWT/session lifetime/refresh behavior, Auth hooks, email/phone confirmation, and registration policy. Production still had zero Auth users at M2A.
- Backup schedule, retained restore points, PITR availability, restore granularity, and a tested restore procedure. The dashboard identifies the organization as Free, but plan label alone is not proof of the current backup/restore state.
- A named maintenance owner, exact Cron/worker/push pause sequence, write-drain proof, rollback deadline, and deployment rollback operator.
- Type-specific referential checks for non-message polymorphic `source_id` values (`moment`, proactive event, treehole, weather window) and provider callback references. They are modeled in code, not protected by database FKs, and need synthetic failure-path coverage in M2C.2 plus targeted metadata reconciliation before their domain backfill.

These gaps block Production writes, not local synthetic rehearsal.

## 7. Engineering conclusions that do not need a user decision

- Keep `test` quarantined; do not migrate or delete it.
- Keep all six known orphans recoverable and unreachable; do not fabricate parents or clear references.
- Revoke public EXECUTE from `check_pending_moments_for_xiaoc()` first in the future M2C.3 grant-only checkpoint, after M2C.2 rehearsal and operational rollback evidence.
- Keep Summary/Core, Memory Engine, cleanup, background, Proactive, and import RPCs service-only.
- Do not use ETag as the sole Storage copy checksum.
- Do not implement one generic FK for polymorphic `source_id`; validate each source type through a registry/typed contract and worker tests.
- Do not enable RLS or broadly revoke table grants based only on the current service-role caller inventory.

## 8. Decisions required from the user

Only decisions that establish product/data ownership are listed here.

### D1 — Bind the current `user` cohort

- **Current fact:** it is the only active cross-domain cohort and includes the deliberate 150-row Memory import, but no Production Auth account exists yet.
- **Options:** (A) bind it to the first verified private Auth account; (B) keep it quarantined and nominate another account/cohort later.
- **Recommendation:** **A**, after the private Auth account is created and its UUID is independently verified.
- **Risk:** a wrong binding would expose the complete current relationship history to the wrong tenant; it is not safely reversible after RLS/client cutover without a manifest.
- **Blocks:** not M2C.2; not narrow M2C.3; blocks M2C.5 backfill and all later authenticated cutover. It need not block empty additive M2C.4 if D3 is approved.

### D2 — Disposition of `small_c`

- **Current fact:** this is a coherent 48-conversation/3,271-message historical cohort, not test debris. Metadata alone cannot prove whether it is an earlier identity of the current private user or a distinct person/account.
- **Options:** (A) approve merge into the same first private account; (B) preserve for a different future account; (C) keep indefinitely quarantined pending more non-content provenance.
- **Recommendation:** **C now**. Choose A only if you personally recognize `small_c` as your prior account; otherwise do not merge.
- **Risk:** merging without personal provenance causes cross-person disclosure; leaving it quarantined preserves data but makes historical continuity temporarily unavailable to Auth clients.
- **Blocks:** not M2C.2; not narrow M2C.3; blocks Core M2C.5 completion/constraint scope for this cohort, but not a separately scoped `user`-only backfill if quarantine is explicitly approved.

### D3 — Companion/account deletion lifecycle

- **Current fact:** M2B requires a one-to-one `companion_instances` root; no audited multi-domain purge exists.
- **Options:** (A) suspend/soft-delete with FK `RESTRICT`, followed only by a separately audited purge; (B) immediate cascading deletion.
- **Recommendation:** **A**.
- **Risk:** B could irreversibly erase relationship history across Core, Moments, Storage, Memory, and audit domains; A needs lifecycle state and operational handling but is recoverable.
- **Blocks:** not M2C.2 or M2C.3; blocks final M2C.4 root/FK design.

### D4 — Approve the orphan posture

- **Current fact:** none of the six rows has enough surviving evidence for a truthful parent repair; all are historical/terminal, and none needs to execute.
- **Options:** (A) retain and quarantine all six; (B) nominate specific rows as later delete-candidates after a retention/rollback review; (C) attempt repair only if new external lineage evidence is produced.
- **Recommendation:** **A**. B can be revisited independently and does not help tenancy safety.
- **Risk:** deletion loses audit/recovery evidence; repair without lineage corrupts ownership. Retention is low-risk only if quarantine is enforced.
- **Blocks:** M2C.2 can model A provisionally; affected Production backfill/constraint checkpoints remain blocked until A/B/C is approved. It does not block narrow M2C.3.

Auth sign-in method, Storage direct-upload product policy, Shared Context visibility, and maintenance timing remain future decisions, but they do not need to be made to start M2C.2 and are therefore not presented as immediate choices here.

## 9. Checkpoint readiness

- **M2C.2 rehearsal:** **READY**. Use synthetic A/B/unknown/orphan fixtures; model `user`, `small_c`, and `test` as separate registry groups; use retain/quarantine as the provisional orphan behavior. No Production access or personal attribution is required.
- **M2C.3 grant containment:** **STOP for apply**. The exact exposure and callers are known, but backup/restore evidence, operational rollback ownership, and M2C.2 rehearsal are not complete. A future grant-only artifact may be designed after M2C.2; it must not be applied without separate authorization.
- **M2C.4 additive schema:** **STOP** until D3, platform operational readiness, and M2C.2 rollback/lock rehearsal close.

Final state: **READY FOR M2C.2 / M2C.3 STOP**.
