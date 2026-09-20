# Private Memory Engine Cutover Preparation

Status: implementation-ready preflight; no Production mutation or cutover is authorized.

## Authoritative retrieval boundary

`owned_authoritative` may retrieve only canonical rows that already pass the existing
M3 deterministic lifecycle, temporal, relation, relevance, dedupe and budget gates.
The adapter adds one source admission boundary before those gates:

- native: `origin_system=xiaoc_native`, `provenance_status=verified_user`,
  `authority_tier=native_verified`, active lifecycle;
- reviewed historical: `origin_system=ombre_legacy`,
  `provenance_status=legacy_unverified`, `retrieval_tier=low_authority`,
  `authority_tier=legacy_limited`, active lifecycle.

`shadow_only`, `disabled`, archived, deleted, superseded, wrong-owner and invalid
authority/provenance combinations remain excluded. Existing ranking continues to
permit at most one legacy-limited result in Top-K. Retrieval remains lexical-only,
Top-K remains at most three, and Memory does not gain proactive-attention eligibility.

## Post-import Ombre delta contract

The 2026-09-09 locked run remains immutable. A delta must be a separate import run;
it must never amend or reuse the completed 150-row run.

1. Take a new read-only full Railway Volume snapshot, including archive, and bind its
   SHA-256. Do not use `/xiaoc/memories` as the full source.
2. Compare stable Ombre IDs against the locked M0 manifest.
3. Put only genuinely new IDs into the delta candidate set. IDs missing from the
   current source are an exclusion set, not an import/restore set. If archive versus
   user deletion cannot be proven, exclude the ID.
4. Build a body-free review manifest containing source snapshot hash, stable external
   ID, safe relative path, exact body hash, deterministic UUID, metadata hash and an
   explicit review decision.
5. Review each new record locally. Each item must be explicitly assigned either:
   `low_authority + legacy_limited` (eligible under the same conservative legacy
   policy) or `shadow_only/disabled + none`. There is no batch default to retrievable.
6. Apply an additive M2D-delta hardening migration. It must create a separate locked
   run contract with exact expected count, manifest/order/classification digests and
   immutable plan rows; protected start/import/finalize/fail/disable RPCs must derive
   all counts from the database. It must not weaken the original 150-row run or direct
   table mutation grants.
7. Import through the protected legacy RPC path as `ombre_legacy`, `observation`,
   `legacy_unverified`; verify exact identity/hash/tier coverage and zero native
   provenance, PINs and embeddings.
8. Rollback is exact-run logical disable. It must never delete or modify Ombre.

The currently observed 15 non-archive additions are candidates, not an automatic
allowlist. The five baseline IDs absent from the non-archive endpoint are excluded
until a full-volume read proves their state; they are never automatically restored.

## Existing Core Snapshot compatibility

In `owned_authoritative`, a persisted Ombre Core Snapshot is legacy data, not Owned
authority. Runtime returns a deterministic empty Core state without fetching,
initializing, deleting or rewriting the stored snapshot. This makes rollback lossless:
`ombre_authoritative` can read the same persisted snapshot again. The stricter
`owned_fresh_empty` conflict behavior is unchanged.

## Minimum Production sequence

1. Push the reviewed Phase 1–4 commits, but keep Production Ombre-authoritative.
2. Apply and validate the existing `supabase_xiaoc_memory_owned_lifecycle.sql` once.
3. Acquire/review the fresh full-volume delta and create the separate approved delta
   manifest. Do not include ambiguous missing IDs.
4. Apply and transactionally validate the future M2D-delta hardening migration, then
   run the protected delta import and exact read-back validation.
5. Deploy the reviewed server code while authority remains Ombre; run identity,
   retrieval, lifecycle and old-conversation Core compatibility smoke checks.
6. Set `XIAOC_MEMORY_AUTHORITY_MODE=owned_authoritative` and deploy the server.
7. Verify lexical retrieval/prompt use, lifecycle exclusion, zero Ombre I/O and old
   conversation continuity. Mobile rebuild is not required.
8. On failure, set `XIAOC_MEMORY_AUTHORITY_MODE=ombre_authoritative` (or remove the
   variable) and redeploy. Stored Ombre snapshots and Ombre source data remain intact.
