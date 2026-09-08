# XiaoC Memory Engine M2C Legacy Shadow Import Dry-Run

> Status: READY FOR M2C REVIEW  
> Date: 2026-09-08 (Asia/Shanghai)  
> Scope: offline classification and deterministic identity rehearsal only.  
> No historical import, database write, embedding generation, retrieval change, or Ombre/runtime mutation is authorized or performed.

## 1. Result

The M0 repo-external archive was used as the sole source:

- archive: `/Users/hxj/XiaoC-Backups/ombre-volume-snapshot-2026-09-08.tar.gz`
- expected SHA-256: `a96b8d211899e6a00dbcd40d42639293fb7ddc0a31a1430f44866e44876d3178`
- observed SHA-256: `a96b8d211899e6a00dbcd40d42639293fb7ddc0a31a1430f44866e44876d3178`
- verification: PASS

The dry-run produced 150 manifest entries from 150 canonical Markdown records. Coverage is 100%. No record body is stored in the manifest or this document.

The archive also contains macOS AppleDouble `._*` sidecars and derived SQLite data. They are not canonical Memory and were excluded. `embeddings.db` and `dehydration_cache.db` were not parsed as Memory and were not imported or regenerated.

## 2. Artifacts and reproducibility

- machine manifest: `tmp/xiaoc-memory-engine-m2c-manifest.json`
- offline generator: `scripts/xiaoc-memory-engine-m2c-dry-run.py`
- manifest SHA-256: `861325ac1b3c8b22ce6b4aa124239c66dee08e263bceda43d5bd75930be070db`
- policy version: `xiaoc-legacy-shadow-dry-run-v1`

The generator was run twice against the same verified archive. The two JSON outputs were byte-identical and had the same SHA-256.

The generator includes executable assertions that:

- read the UUID namespace from the implemented foundation boundary;
- require the production expression `user_id + chr(31) + source_system + chr(31) + legacy_external_id`;
- check an independent fixed UUIDv5 vector;
- recompute every manifest ID from the production-compatible identity rule;
- reject duplicate relative paths or deterministic memory IDs;
- require all entries to remain `legacy_unverified` and `memory_class = observation`;
- reject native PIN/Core/Stable promotion and invalid authority/tier combinations;
- ensure archived records cannot enter an eligible retrieval tier;
- ensure Memory bodies and fabricated provenance fields are absent from manifest entries.

## 3. Canonical parsing

A canonical record is a regular UTF-8 Markdown file beneath one of these source groups:

| Source group | Records |
| --- | ---: |
| `permanent` | 17 |
| `dynamic` | 66 |
| `feel` | 18 |
| `archive` | 49 |
| **Total** | **150** |

Each record must have a closed front matter block, non-empty Markdown body, required structural metadata, valid `created` and `last_active` timestamps, and a 12-character hexadecimal external ID matching its filename. The 150 records passed these checks.

`content_hash` is SHA-256 of the exact UTF-8 body bytes following the closing front matter delimiter. The full body is deliberately omitted from the manifest. Original structured metadata and lifecycle hints are retained locally in the manifest together with a deterministic metadata hash.

## 4. Deterministic identity

The dry-run uses the exact identity contract implemented by `xiaoc_memory_import_legacy`:

```text
UUIDv5(
  f1c7e436-ff13-5d2c-8e4a-5de7386b6db7,
  user_id + chr(31) + source_system + chr(31) + legacy_external_id
)
```

Inputs for this manifest are `user_id = user` and `source_system = ombre`, matching XiaoC's current canonical private user identity and the namespaced Ombre source. Every external ID maps to exactly one deterministic UUID. There are no identity failures or duplicate deterministic IDs.

Future import must use the same values and production RPC. Changing `user_id`, `source_system`, namespace, separator, or external ID changes the UUID and must fail review rather than silently creating a second identity.

## 5. Classification policy

Every record receives:

- `provenance_status = legacy_unverified`;
- no `memory_provenance` row;
- no source message, user-role evidence, conversation locator, or invented confirmation;
- `memory_class = observation`, preventing legacy content from becoming native Stable or a consolidation source;
- no native PIN; historical `pinned = true` becomes `legacy_pin_candidate = true` only.

The policy does not use an LLM, embedding similarity, Ombre importance, activation count, affect score, pinned state, protected state, or digested state to raise authority.

### 5.1 Deterministic tier rules

| Rule | Lifecycle | Retrieval tier | Authority | Reason code |
| --- | --- | --- | --- | --- |
| Source is `archive` | `archived` | `disabled` | `none` | `SOURCE_ARCHIVED` |
| Explicit `resolved = true` | `active` with `resolved_at` from valid `last_active` | `disabled` | `none` | `EXPLICIT_RESOLVED_HINT` |
| Historical PIN | `active` | `shadow_only` | `none` | `LEGACY_PIN_REVIEW_REQUIRED` |
| `permanent` source | `active` | `shadow_only` | `none` | `LEGACY_PERMANENT_HIGH_AUTHORITY_REVIEW` |
| `feel` source | `active` | `shadow_only` | `none` | `SENSITIVE_AFFECTIVE_CONTEXT_REVIEW` |
| Structurally low-risk `dynamic` domain | `active` | `low_authority` | `legacy_limited` | `LOW_RISK_DYNAMIC_DOMAIN` |
| High-risk, mutable, current-state, relationship, plan, or unclassified domain | `active` | `shadow_only` | `none` | `HIGH_RISK_OR_AMBIGUOUS_DOMAIN_REVIEW` |
| Parse, identity, hash, or structural failure | retained when identifiable | `quarantined` | `none` | `STRUCTURE_INVALID` |

`active_legacy` is intentionally unused in this rehearsal. The source metadata does not deterministically distinguish safe historical experiences from current or mutable claims with enough precision. Assigning `active_legacy` from importance, age, activation count, or a guessed reading would exceed M1 authority rules.

Only one record has a sufficiently explicit low-risk structured dynamic domain for `low_authority`. The remaining live records stay in `shadow_only`. This is conservative admission behavior, not a parsing failure.

### 5.2 Temporal policy

`created` and `last_active` remain source hints; neither is automatically treated as `valid_from` or `valid_until`. They describe record/storage activity and do not prove claim validity.

Only an explicit `resolved = true` hint assigns `resolved_at`, using its structurally valid `last_active` timestamp. No dates are inferred from prose, filenames, current time, or model judgment.

### 5.3 Claim identity and duplicates

No `claim_key` is assigned. The snapshot has no structured, high-confidence claim scope that can safely support conflict, supersedes, or resurrection suppression without semantic inference.

Duplicate detection uses only Unicode NFKC normalization plus whitespace normalization and exact hash equality. It does not use embeddings, fuzzy matching, title similarity, shared category, or model judgment. No duplicate clusters were found under this strict rule.

## 6. Aggregate statistics

| Metric | Count |
| --- | ---: |
| Canonical records | 150 |
| Manifest entries | 150 |
| Coverage | 100% |
| `active_legacy` | 0 |
| `low_authority` | 1 |
| `shadow_only` | 100 |
| `quarantined` | 0 |
| `disabled` | 49 |
| Legacy PIN candidates | 8 |
| Duplicate clusters | 0 |
| Duplicate-cluster members | 0 |
| Claim keys assigned | 0 |
| Temporal validity assigned | 1 |
| Parse failures | 0 |
| Identity failures | 0 |

## 7. Safety review

| Gate | Result |
| --- | --- |
| Every canonical record has one manifest entry | PASS — 150/150 |
| Duplicate deterministic memory IDs | PASS — 0 |
| Legacy incorrectly marked verified | PASS — 0 |
| Fake provenance fields or rows | PASS — 0 |
| Native PIN created | PASS — 0 |
| Legacy admitted to native Core/Stable | PASS — 0 |
| Quarantined/disabled item eligible for retrieval | PASS — 0 |
| Record body included in report or manifest | PASS — 0 |
| Supabase writes | PASS — 0 |
| Ombre/Railway writes | PASS — 0 |
| Embeddings generated or imported | PASS — 0 |
| Runtime, Context Gateway, Memory Judge, or retrieval changed | PASS — NO |

The manifest is a local private migration artifact because its preserved source metadata may itself be sensitive. It should remain outside Git unless a later privacy review explicitly approves a redacted form.

## 8. Future import gate

This dry-run is ready for M2C review. It does not authorize import.

Before a real import is approved:

1. Review the 100 `shadow_only` records by ID/hash/category/reason without copying bodies into logs or reports.
2. Decide whether any additional deterministic structured rules can safely distinguish low-authority continuity records. Do not promote based on model confidence, importance, pinned status, or activation count.
3. Review all eight `legacy_pin_candidate` records separately; none may create native PIN/Core membership automatically.
4. Confirm the one resolved temporal mapping and all 49 archived/disabled mappings.
5. Freeze `user_id`, `source_system`, UUID namespace, separator, policy version, body extraction recipe, and archive SHA-256 for the import run.
6. Re-run the manifest and require the same byte hash before any database write.
7. Use only `xiaoc_memory_create_import_run` and `xiaoc_memory_import_legacy` in a separately authorized, count-checked import procedure.
8. Keep Ombre authoritative and retrieval unchanged after import; shadow-read requires a separate phase and approval.

Recommendation: **READY FOR M2C REVIEW**.

## 9. M2C.1 Offline Legacy Classifier Review

> Run date: 2026-09-09 (Asia/Shanghai)  
> Result: REJECT CLASSIFIER  
> This was a one-time migration analysis job. It did not alter the original M2C manifest or any production system.

### 9.1 Fixed model and privacy boundary

The classifier used only the 43 records marked `Uncertain` by the Historical Continuity Review.

- model: `z-ai/glm-5.3`
- provider route: `novita/fp8`
- temperature: `0`
- response mode: JSON object with strict local schema validation
- provider fallback: disabled
- provider selection: Novita only; the returned provider and model were checked
- OpenRouter data policy: `data_collection = deny`
- OpenRouter retention policy: per-request `zdr = true`

Each first-pass request contained only the classification policy, one legacy external ID and that record's body. No manifest, user identity, Core Snapshot, Recent conversation, Summary, Active Context, Persona, Relationship Contract, or unrelated Memory was sent. The script logged only progress counts and aggregate results. Model inputs and raw responses were not persisted.

Exactly 43 unique real Memory records were sent; other Memory records sent were zero. The output artifact contains no Memory body.

### 9.2 Classifier and validation result

| Metric | Count |
| --- | ---: |
| Input uncertain | 43 |
| Processed | 43 |
| Classifier proposed `low_authority` | 1 |
| Post-validator rejected | 1 |
| Second-review rejected | 0 |
| Final classifier candidates | 0 |
| API or JSON parse failures | 27 |
| Other schema-validation failures | 0 |

The sole proposed candidate passed the historical/no-risk shape but had confidence `0.82`, below the fixed `0.90` gate. It therefore failed closed to `shadow_only`. Because no candidate survived deterministic post-validation, the second review had nothing eligible to inspect and could not promote any record.

All 43 records ended as `shadow_only`. No provenance, authority, claim key, content, PIN, Core, Stable, lifecycle, or original manifest field changed.

### 9.3 Risk-flag statistics

Model/fail-closed outputs contained these aggregate risk flags:

| Risk flag | Count |
| --- | ---: |
| `INSUFFICIENT_CONTEXT` | 28 |
| `ONGOING_PREFERENCE` | 10 |
| `BEHAVIOR_RULE` | 6 |
| `RELATIONSHIP_CURRENT_STATE` | 6 |
| `CURRENT_STATE` | 5 |
| `TEMPORAL_AMBIGUITY` | 5 |
| `CURRENT_POSSESSION` | 2 |
| `FINANCE` | 2 |
| `FUTURE_PLAN` | 2 |
| `MIXED_CURRENT_AND_HISTORICAL` | 1 |
| `UNRESOLVED_PLAN` | 1 |
| `LOCATION` | 1 |
| `CURRENT_JOB_OR_ROLE` | 1 |
| `PERSONA_RULE` | 1 |
| `RELATIONSHIP_CONTRACT` | 1 |

Grouped record counts may overlap because one record can carry several risk flags:

- false-current-state/high-authority findings: 11;
- plan findings: 2;
- preference findings: 10;
- mixed, ambiguous, or insufficient-context findings: 33.

### 9.4 Continuity impact

The classifier adds zero accepted candidates. If the five deterministic Historical Continuity Review candidates are accepted later, the projected result remains:

- existing `low_authority`: 1;
- deterministic review candidates: 5;
- classifier candidates: 0;
- projected `low_authority`: 6;
- projected non-archive retrievable: 6 / 101 (`5.94%`);
- remaining `shadow_only`: 95;
- archive disabled: 49.

This run demonstrated safe failure behavior but not adequate classifier reliability. A 27/43 API-or-parse failure rate prevents the results from supporting a migration eligibility decision. The output must not be merged into the original manifest.

Recommendation: **REJECT CLASSIFIER**. A later attempt requires a separately reviewed output contract or model route and new authorization; it must not repair or reinterpret this run.
