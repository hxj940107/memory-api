# XiaoC Memory Engine — M3A Retrieval Architecture Study

> Status: architecture study complete; design only  
> Date: 2026-09-09 (Asia/Shanghai)  
> Scope: repository-backed Ombre anatomy and XiaoC-owned retrieval design.  
> No embedding generation, external model call, Supabase write, schema migration, runtime change, cutover, commit, or push is authorized or performed.

## 0. Executive decision and baseline note

XiaoC should replace the current Ombre read path with a **deterministically gated hybrid retriever** owned by XiaoC:

```text
query decision and construction
  -> trusted user scope
  -> lifecycle / tier / provenance / authority gates
  -> claim / relation / temporal suppression
  -> lexical + semantic candidate generation over eligible IDs only
  -> explainable ranking
  -> duplicate and cross-context suppression
  -> top-k and token budget
  -> Context Gateway injection gate
```

The design reuses standard PostgreSQL/pgvector concepts, but neither Ombre runtime nor Ombre source code. The hard invariant is **eligibility before ranking**. Semantic similarity can rank an already eligible claim; it can never make an ineligible claim eligible.

The handoff and repository `HEAD` (`cfdb118`, `feat: complete XiaoC historical memory migration`) state that historical import run `8f80b744-2db8-4f78-85a3-78a2cfec679d` completed 150/150. `docs/xiaoc-memory-engine-m2d.md:3` still says production import was not executed, and its final section still describes the dry-run as pending authorization. This is a documentation-state conflict, not authorization to repeat the import. M3A uses the confirmed completed-import baseline and does not modify M2D.

## 1. Current Ombre Retrieval Anatomy

### 1.1 Actual XiaoC runtime path

The production chat path identified from code is:

1. `api/chat.js:1168-1181` builds one query from the last three user messages in selected Recent history plus the current user message, joins them with newlines, and truncates to 600 characters.
2. `api/chat.js:1205-1221` builds a 10-minute dynamic-cache key from conversation ID, Core exclusion IDs, abbreviated cross-context text, remaining Memory budget, and only the first configured 80 normalized query characters.
3. `api/chat.js:1312-1436` calls `GET {memoryBaseUrl}/memory-search?user_id=...&query=...`. `user_id` is sent but the Ombre handler does not read or enforce it.
4. `Ombre-Brain/server.py:417-457` calls `BucketManager.search(query, limit=5)`, converts each result into `name: content`, truncates each content to 500 characters, and returns a plain-text header plus `\n---\n` separators.
5. `lib/dynamicMemoryFilter.js:18-90` reparses that lossy plain text. It has no stable bucket ID, so it creates positional IDs such as `ombre-1`.
6. `lib/contextEligibility.js:86-162` suppresses approximate duplicates against Core, Recent, Active, Summary, the same conversation, and prior Dynamic candidates; current-user remention can override most of these suppressions. It then applies a character budget.
7. `api/chat.js:3313-3356` retrieves Dynamic Memory first and then selects the existing native Stable Memory rows under one shared Memory budget.
8. `api/chat.js:3447-3465` injects Stable under `User Profile` and Dynamic under `Memory` in the dynamic system context. The fixed prompt rule says these are background facts, not reasons to revive a topic (`api/chat.js:3443-3445`).

Core/PIN uses a separate path. `lib/coreMemorySnapshot.js:64-208` reads pinned IDs from `/xiaoc/memories`, logs into the Ombre dashboard, fetches full bucket details, checks the ID set and content twice, and persists a deterministic conversation snapshot. Existing snapshots are frozen and are outside Dynamic retrieval.

### 1.2 Ombre storage and eligible source set

`BucketManager.list_all(include_archive=False)` recursively loads `permanent`, `dynamic`, and `feel`, but not `archive` (`Ombre-Brain/bucket_manager.py:637-660`). Therefore the `/memory-search` candidate pool:

- includes permanent, dynamic, and feel buckets;
- includes pinned and protected buckets;
- includes resolved and digested buckets if they pass ranking;
- excludes archive only because the caller uses `include_archive=False`;
- has no user ownership boundary, provenance model, authority tier, claim identity, supersedes graph, or native lifecycle contract.

The production XiaoC integration attempts to remove Core duplication only after Ombre returns its top five. It loads full Core-source content via the admin endpoint and matches exact title/content or a long exact prefix (`lib/coreMemorySnapshot.js:142-183`, `lib/dynamicMemoryFilter.js:34-45`). Thus an ineligible duplicate may consume an Ombre top-five slot even when XiaoC later suppresses it.

### 1.3 Embedding behavior

Ombre's embedding engine (`Ombre-Brain/embedding_engine.py`) does the following:

- stores one JSON-serialized vector per `bucket_id` in `buckets/embeddings.db` SQLite;
- truncates embedding input to 2,000 characters;
- defaults in source to model `gemini-embedding-001` and an OpenAI-compatible Gemini URL;
- loads every stored vector and calculates cosine similarity in Python;
- returns the highest `top_k` scores;
- returns an empty result on disabled configuration, API failure, empty vectors, malformed JSON, or dimension mismatch.

Inside `BucketManager.search`, vector results are an optional top-50 **prefilter** only (`bucket_manager.py:478-490`). Their similarity is not a component of the final score. If vector search fails, returns empty, or has no overlap with the current domain candidates, fuzzy candidates remain. In the `/memory-search` HTTP path there is no second vector-only union channel.

The MCP `breath` search tool is different: it calls `BucketManager.search`, excludes pinned/protected afterward, then adds vector-only results with cosine `> 0.5` (`server.py:769-805`). That path is not the XiaoC `/memory-search` production path.

The deployed production embedding model, provider route, dimension, enabled state, database coverage, and success rate are **UNKNOWN** from the repository. Environment variables can override model and base URL (`Ombre-Brain/utils.py:111-119`), and no production configuration snapshot is committed. The default model name is code evidence, not proof of the live deployment or vector dimension.

### 1.4 Ranking, threshold, and top-k

`BucketManager.search` (`bucket_manager.py:439-556`) applies:

```text
topic = weighted RapidFuzz partial ratio:
        name x3 + domain x2.5 + tag x2 + body[0:1000] x1
emotion = 0.5 when XiaoC supplies no valence/arousal
time = exp(-0.02 * days_since_last_active)
importance = clamp(importance, 1..10) / 10

score = 100 * (
  topic*4.0 + emotion*2.0 + time*1.5 + importance*1.0
) / 8.5
```

The weights and threshold can be overridden by an uncommitted `config.yaml`; the code/default values are `4.0 / 2.0 / 1.5 / 1.0`, fuzzy threshold `50`, and default max results `5` (`bucket_manager.py:61-90`, `config.example.yaml:75-86`). The live override values are **UNKNOWN**.

A direct fuzzy match of at least 85 to content, name, or tag forces the raw score to at least threshold + 10. Threshold is tested before the resolved penalty. A resolved result that passes is then multiplied by `0.3` and may still be returned. Results sort descending by the final number and `/memory-search` takes five.

Consequences:

- constant neutral emotion contributes about 11.76 points to every query and does not differentiate candidates;
- recency and importance can push weak lexical matches over the threshold;
- `last_active` is storage/retrieval activity metadata, not claim temporal validity;
- exact matches can resurrect resolved claims;
- vector similarity only changes which records survive into fuzzy scoring, not their final rank;
- no deterministic factual authority protects current state.

`/memory-search` does not call `touch()`, so this XiaoC read does not update `last_active` or activation count. Ombre's MCP search tool does call `touch()` after results are rendered (`server.py:824`), showing another runtime-path difference.

### 1.5 Returned structure, fallback, and failure behavior

The HTTP response is plain text rather than a structured retrieval contract. It contains a display title and at most 500 content characters, but no bucket ID, score, source type, provenance, authority, lifecycle, temporal state, vector score, reason code, or suppression metadata.

Fallback behavior:

- optional embedding failure -> fuzzy-only scoring;
- `/memory-search` error -> HTTP empty string;
- XiaoC network/error/empty response -> no Dynamic Memory for that turn;
- stale individual Core source detail -> skip that detail but retain its ID in the exclusion set;
- non-404 Core exclusion/auth/network failure -> fail closed and skip Dynamic injection;
- dynamic cache hit -> reuse the already post-filtered result for up to 10 minutes under the derived key.

There is no separate production retrieval retry, lexical exact-ID identity, conflict resolution, supersedes suppression, or explicit no-retrieval decision. Retrieval is attempted on every normal chat turn, including acknowledgements and greetings.

Privacy/observability issue found during read-only study: `api/chat.js:1346-1375` logs the full constructed query and full returned Memory text; `api/chat.js:1439-1448` also logs PIN/Dynamic bodies. Ombre's breath hook logs an 80-character pinned preview (`server.py:348-351`). M3 shadow telemetry must not repeat this behavior. This is an existing issue, not changed in M3A.

## 2. Reuse / Replace Decision Matrix

Classification: **A** standard component; **B** concept worth reimplementing; **C** incompatible behavior; **D** missing capability XiaoC must add.

| Capability | Current Ombre behavior | Evidence | Class / useful idea | Reuse code? | XiaoC replacement |
|---|---|---|---|---|---|
| Storage | Markdown buckets plus derived SQLite vectors | `bucket_manager.py:44-60`; `embedding_engine.py:44-73` | A: durable canonical store concept | No | Existing `memory_items` + relation/provenance tables in PostgreSQL |
| Embedding | External OpenAI-compatible call, 2,000-char input, one vector per bucket | `embedding_engine.py:31-119` | B: derived/versioned artifact only | No | Existing versioned `memory_embeddings`, content-hash bound |
| Vector search | Full SQLite scan, Python cosine, optional top-50 prefilter | `embedding_engine.py:142-190`; `bucket_manager.py:478-490` | A cosine; C global/ineligible prefilter | No | pgvector exact cosine over deterministically eligible IDs and one version |
| Keyword search | RapidFuzz partial ratio over name/domain/tag/body | `bucket_manager.py:563-587` | B: lexical channel matters for Chinese names/nicknames | No | XiaoC tokenizer/alias-aware lexical scoring, initially exact eligible-set scan |
| Hybrid search | Vector narrows pool; fuzzy does final rank; MCP path also unions vector-only | `bucket_manager.py:478-556`; `server.py:769-805` | B: multiple channels; C: inconsistent paths | No | Parallel lexical/semantic components on the same eligible set, one rank contract |
| Metadata filter | Optional domain filter with full-search fallback | `bucket_manager.py:463-476` | C for safety: empty filter must not broaden scope | No | Trusted deterministic user/status/tier/version filters; optional category is soft only |
| Temporal filter | None; `last_active` is only a soft recency score | `bucket_manager.py:620-631` | C | No | `valid_from/valid_until/resolved_at/event_time` gate before rank |
| Ranking | Weighted topic/emotion/time/importance; fixed threshold | `bucket_manager.py:492-556` | B explainable components; C authority collapse | No | hard gates + named component scores + deterministic tie-breakers |
| Threshold | Default 50; exact fuzzy >=85 forces admission | `bucket_manager.py:524-546` | C | No | channel-specific relevance floors after eligibility; legacy has stronger floor |
| Top-k | `/memory-search` five after scoring | `server.py:430-457` | A bounded output | No | candidate cap, then top-k max 3 passive / configurable deep tool, token budget |
| PIN | Breath returns up to eight pinned; search pool can still include them | `server.py:342-383`; `coreMemorySnapshot.js` | C mixed concerns | No | Active `memory_pins` feeds frozen Core; exclude current Core IDs before retrieval |
| Permanent/dynamic/feel/archive | First three searched together; archive omitted | `bucket_manager.py:637-660` | C | No | Memory class/category do not grant eligibility; lifecycle and tier do |
| Deduplication | No search-level semantic dedupe; XiaoC text heuristics after top-five | `dynamicMemoryFilter.js`; `contextEligibility.js` | B cross-layer suppression | No | ID/relation/claim/hash first, then bounded textual novelty before top-k/injection |
| Conflict resolution | None in Ombre retrieval | no relation/claim gate in `search` | D | No | precedence + claim/relation suppression before candidate generation |
| Supersedes | None | same | D | No | `memory_relations.supersedes`, lifecycle and claim winner resolution |
| Provenance | Not returned or used | `server.py:443-457` | D | No | first-class `provenance_status` and evidence summary |
| Authority | Importance acts as score, not factual authority | `bucket_manager.py:510-522` | C | No | deterministic `authority_tier`, never inferred from score |
| Claim suppression | None | same | D | No | suppress old/superseded/duplicate/revalidated claim clusters |
| Current-state protection | Post-return textual duplicate checks only | `contextEligibility.js:107-143` | D | No | current user/Recent/Active claim guards before ranking and again at injection |
| Retrieval eligibility | Archive exclusion only; resolved still recallable | `bucket_manager.py:458`; `:538-546` | C | No | lifecycle/tier/provenance/authority/temporal gates |
| Context injection | Plain strings, then XiaoC cross-layer filter and budget | `dynamicMemoryFilter.js`; `memoryContextGateway.js` | B Gateway boundary; C string contract | No | structured selected/suppressed results with reason codes |

## 3. XiaoC Retrieval Principles

1. **Eligibility before ranking.** Scope and safety filters operate on database rows/IDs before vector or lexical top-k.
2. **Current evidence controls perspective.** Current user > newer explicit user evidence > verified native Memory > eligible legacy > derived/model Summary.
3. **Memory is factual background, not attention.** Every retrieval result has `eligible_for_proactive_attention = false`; retrieval cannot create or refresh Active Context.
4. **Authority, confidence, importance, similarity, recency, and attention remain distinct.** Only relevance-oriented components combine in a soft score. Authority is a gate/cap and an output field.
5. **One semantic contract across channels.** Passive, shadow, and future deep-tool modes may use different budgets, but they share eligibility and conflict rules.
6. **No silent broadening.** A failed filter, missing relation load, unknown embedding version, or uncertain temporal state fails closed for the affected candidate.
7. **Structured in, structured out.** IDs and reason codes survive through Context Gateway; formatting occurs only at the final injection boundary.
8. **Retrieval is read-only.** A hit, injection, or assistant mention does not mutate heat, authority, lifecycle, provenance, or attention.
9. **Privacy by default.** Diagnostics contain IDs/hashes/counts/components, never Memory bodies or raw queries by default.

## 4. Retrieval Eligibility Pipeline

| Stage | Input | Output | Rule | Fail-closed behavior |
|---|---|---|---|---|
| 0. Retrieval decision | Current message, bounded Recent/Active metadata | `skip` or a `QueryPlan` | Skip pure greeting/acknowledgement and self-contained immediate requests unless explicit recall/continuity exists | Ambiguous low-signal request skips passive retrieval; future deep tool remains possible |
| 1. Query construction | Current message, at most bounded relevant Recent turns, Active entities/topics, explicit recall intent | normalized lexical terms, semantic text, entities, temporal hints, mode | Current message is primary; add history only when it resolves a reference or continuity | If construction invalid/empty, return empty with `QUERY_EMPTY` |
| 2. User scope | Trusted server-derived `user_id` | same-user row IDs | `user_id` is inside the database query/RPC, never post-filtered | Missing/untrusted owner aborts retrieval |
| 3. Lifecycle | scoped rows | active rows | ordinary retrieval permits `lifecycle_status=active` only | Unknown/archived/superseded/deleted excluded |
| 4. Retrieval tier | active rows | mode-eligible rows | native policy rows; legacy ordinary mode allows only reviewed `low_authority` (and future approved `active_legacy`) | `shadow_only`, `quarantined`, `disabled` excluded from production; shadow mode is separate and non-injecting |
| 5. Provenance/authority | tier-eligible rows | authority-valid rows | native: `verified_user`, `manual_confirmed`, or valid `derived_verified`; legacy must remain `legacy_unverified + legacy_limited` | Illegal combinations excluded and surfaced as integrity diagnostics |
| 6. Claim suppression | candidates plus current/Recent/Active claim evidence | non-contradicted candidates | current explicit statement/correction suppresses incompatible stored claims immediately for this turn | Unresolved mutable legacy claim is withheld |
| 7. Relation suppression | candidate IDs and relation graph | canonical representatives | exclude targets of active `supersedes`; suppress represented observations under Stable; suppress legacy `revalidates`/duplicate clusters when native representative exists | Relation load failure excludes affected cluster, not global fallback to unsafe rows |
| 8. Temporal validity | validity fields + server time + query temporal intent | time-valid candidates | exclude expired/resolved future state from current-state queries; historical intent may retrieve a clearly past event labeled historical | Ambiguous current-vs-past legacy claim excluded from passive production |
| 9. Candidate generation | eligible IDs + one embedding version + lexical plan | union of channel candidates with component evidence | semantic and lexical channels operate only inside eligible IDs | Missing embedding yields lexical-only for that row and a reason; no mixed version |
| 10. Ranking | eligible candidates and query intent | ordered candidates with component scores | hard gates are complete; apply explainable soft scoring | Invalid score/component excludes candidate |
| 11. Deduplication | ordered candidates + claim/hash/relation clusters | one representative per fact | prefer current eligible Stable/native authority, then strongest relevance; preserve alternate IDs in diagnostics | Uncertain duplicate may consume no extra injection slot |
| 12. Top-k | deduplicated list | bounded selected set | passive default max 3; legacy max 1 unless explicit recall and evaluation later approves more | Budget/limit overflow is suppressed, not truncated into misleading fragments |
| 13. Context Injection Gate | structured selected set + Core/Recent/Active/Summary + token budget | injected structured set and formatted prompt text | cross-layer novelty, current-message relevance, authority label, and budget checked again | Any contradiction or formatter failure returns no Memory block |

The production RPC/query must not implement `SELECT nearest globally LIMIT k` followed by application status filtering. The eligible relation-resolved ID set must be part of the vector/lexical query plan before distance ranking.

## 5. Query Construction

### 5.1 When passive retrieval should run

Run when at least one deterministic signal exists:

- explicit recall language: “还记得 / 上次 / 之前 / 当时 / 你知道我……”;
- unresolved pronoun/reference whose antecedent is outside visible Recent but an Active topic/entity exists;
- named entity, nickname, place, person, event, preference, or relationship fact with enough lexical substance;
- current request needs personal history to answer naturally;
- a changed/corrected claim requires old-claim suppression even if no result is ultimately injected.

Skip when:

- pure greeting, thanks, acknowledgement, emoji-only, or short conversational filler;
- the current message and Recent already contain the complete answer/context;
- a self-contained immediate question has no personal-history dependency;
- the request is operational/project-only and Memory would add no companion continuity;
- owner/query validation fails.

### 5.2 Query plan

Do not embed the concatenation of three arbitrary historical user messages. Build a versioned, deterministic plan:

```ts
type QueryPlan = {
  mode: "passive" | "deep_tool" | "shadow"
  shouldRetrieve: boolean
  reasonCodes: string[]
  lexicalTerms: string[]
  lexicalPhrases: string[]
  semanticText: string
  entities: Array<{ value: string; kind: string; source: "current" | "recent" | "active" }>
  temporalIntent: "current" | "historical" | "mixed" | "unknown"
  explicitRecall: boolean
  queryVersion: string
}
```

For passive mode, `semanticText` starts with the current user message. Add at most one bounded Recent antecedent or one Active topic/context only when a demonstrative/pronoun or explicit continuity signal needs resolution. Preserve names, nicknames, locations, dates, and uncommon noun phrases as lexical phrases. Do not send Persona, Core, Summary, or unrelated Recent content to the embedding provider.

The first version should use deterministic Unicode NFKC normalization, punctuation/whitespace normalization, CJK n-grams, ASCII word tokens, exact phrase preservation, and a small generic recall-intent vocabulary. No incident-specific production keyword is allowed.

## 6. Semantic / Lexical Strategy

Recommendation: **hybrid retrieval**.

Vector-only is insufficient for exact nicknames, rare names, short place names, dates, acronyms, and corrections. Lexical-only is insufficient for paraphrase, fuzzy episodic recall, and relationship meaning expressed with different wording. Chinese conversational references also need continuity-aware query construction, not merely a different index.

Initial fusion should avoid opaque reciprocal-rank magic that obscures authority. For each already eligible candidate, retain:

- `semantic_similarity` in `[0,1]` when a compatible embedding exists;
- `lexical_score` in `[0,1]` from exact phrase, entity, token, and CJK n-gram matches;
- `entity_overlap` and `explicit_recall_match` as separate explainable values;
- channel presence flags and missing-embedding reason.

Generate a bounded lexical set and a bounded semantic set over the same eligible IDs, union by `memory_id`, then rank once. At the current size (150 legacy rows, only 6 production-eligible and no native embeddings), exact eligible-set scans are preferable to approximate ANN. Add an index only after native volume and query plans justify it.

## 7. Embedding Architecture

Use the existing `memory_embeddings` table and protected `xiaoc_memory_register_embedding` boundary. It already stores provider, model, logical version, preprocessor version, dimensions, content hash, vector, and rollout status; generation creates `shadow`, activation is a separate protected transition. The canonical Memory never depends on a vector.

Required design rules:

- embed a versioned retrieval representation derived from immutable `canonical_content`; v1 should not silently add mutable metadata;
- bind the artifact to `content_hash`, provider, model, dimensions, preprocessor version, and logical embedding version;
- one configured read identity per run; never compare distances across versions/dimensions;
- `shadow` vectors may be evaluated but not used for production injection;
- `active` is the only production semantic read version; `retired` supports rollback; `stale` is excluded;
- generation failure creates no fake vector. Retrieval continues lexical-only and reports `EMBEDDING_MISSING/FAILED` without weakening eligibility;
- model migration writes a parallel shadow version, backfills idempotently, compares offline/shadow quality, then atomically changes activation only after approval;
- re-embed only when the declared content/preprocessor/model identity changes. Lifecycle, PIN, or retrieval-tier changes do not alter vectors;
- record call counts, tokens if supplied, cost, latency, result status, and IDs/hashes only—never input body in telemetry.

Model/provider/dimension selection is intentionally open. M3A makes no external call, and the live Ombre model/dimension is not a compatibility target. Select the XiaoC model in M3B1 using a small non-private benchmark plus the approved private evaluation procedure, Chinese retrieval quality, stability, cost, and data policy.

### Schema sufficiency

No blocking schema change is required before an offline exact-search implementation. The existing schema supports versioned vectors and all hard eligibility fields. Before production-scale lexical indexing, evaluate an additive search-artifact design (for example versioned normalized lexical text/tokens or a dedicated search document) because PostgreSQL's default full-text parser is not enough evidence for Chinese quality. Do not overload `metadata` or mutate canonical content. At the current data size, deterministic application/RPC lexical scoring over eligible rows avoids premature schema changes.

An eventual retrieval telemetry table is optional, not required: current bounded structured diagnostics can attach to existing per-message metadata/logging. If durable query-by-query comparison cannot be retained safely within existing observability, propose a separately reviewed content-free table in M3D.

## 8. Ranking Architecture

### 8.1 Hard gates

Hard gates are not scores:

- trusted same-user scope;
- allowed retrieval mode and tier;
- `lifecycle_status=active`;
- valid provenance/authority combination;
- not superseded, deleted, archived, quarantined, disabled, or production-shadow-only;
- claim/current-state/temporal validity;
- relation and duplicate-cluster suppression;
- compatible active embedding identity for semantic channel;
- Core source exclusion and any explicit caller exclusions.

### 8.2 Soft components

After hard gates, v1 can calculate:

```text
relevance =
  semantic_similarity * W_semantic
  + lexical_score * W_lexical
  + entity_overlap * W_entity
  + explicit_recall_match * W_recall
  + temporal_relevance * W_temporal
  + relationship_relevance * W_relationship

quality adjustments (bounded, never eligibility):
  + importance_component
  + bounded event recency when the query has matching temporal intent
```

Authority and provenance should not be blended into this number as if they were relevance. Instead they define comparison bands/caps:

1. an eligible verified-native claim wins a same-claim conflict regardless of legacy similarity;
2. `legacy_limited` must pass a stricter lexical/semantic floor and can fill only a bounded legacy slot;
3. within the same authority band and no claim conflict, relevance orders candidates.

`confidence` is evidence/extraction confidence and may set a native eligibility minimum, but it is not a topical rank boost. `importance` is a small bounded tie-quality component, not authority. System retrieval recency must not be used; event/validity time is used only when aligned to query intent.

### 8.3 Tie-breakers

Deterministic tie order:

1. exact entity/phrase match;
2. higher lexical score for explicit named recall, otherwise higher semantic similarity;
3. verified native Stable over represented observation;
4. stronger temporal match;
5. higher bounded importance;
6. newer applicable evidence/event time, not `updated_at` from system maintenance;
7. stable `memory_id` lexical order.

All weights, floors, bands, and tie rules belong to a versioned retrieval policy and appear in diagnostics. Offline evaluation chooses values; M3A does not freeze numeric weights.

## 9. Claim / Conflict Suppression

For each candidate, construct a same-user claim cluster from `claim_key`, direct relations, duplicate cluster identity, and consolidation lineage. Resolve it before semantic search where structured identity exists, and again before injection for current-turn evidence.

Precedence:

```text
current user statement/correction
  > newer explicit user evidence in Recent/Active
  > active verified native Memory
  > active manual_confirmed / valid derived_verified under native policy
  > eligible legacy_unverified (legacy_limited)
  > Summary/derived context
```

Rules:

- active target of `supersedes` is excluded; the newer source is considered if independently eligible;
- a verified native `revalidates` legacy row: return native, suppress legacy without upgrading the old row;
- a verified native correction of legacy: native may be returned; old legacy and known duplicate cluster remain suppressed/quarantined;
- active Stable suppresses the observations it consolidates for ordinary retrieval, while provenance remains available on demand;
- `contradicts` without a resolved winner suppresses both from passive factual injection and emits `UNRESOLVED_CONFLICT`;
- current user correction suppresses an incompatible stored claim immediately even before capture persists;
- Summary never wins a conflict. Existing cross-context formatting should omit the stale Summary chunk when claim identity is known;
- no `claim_key` plus a mutable/temporally ambiguous legacy claim means no current-state admission, regardless of similarity.

This prevents resurrection: a stale cached rank, high similarity, PIN history, importance, or vector result cannot re-admit the old claim.

## 10. Legacy Safety

Current imported distribution is fixed: `active_legacy=0`, `low_authority=6`, `shadow_only=95`, `disabled=49`; all 150 are `legacy_unverified`.

- `low_authority`: ordinary production candidate only under strong relevance, historical framing/validity, no native/current conflict, and a strict legacy slot cap. It cannot become current fact, Stable, Core, PIN, or proactive attention.
- `shadow_only`: available only to explicitly authorized shadow/review mode; it can be scored for evaluation but never formatted into production prompt context.
- `disabled`: unavailable to ordinary, shadow-quality recall, and deep-tool retrieval. Administrative audit by exact ID is a different capability, not retrieval.
- `active_legacy`: none exist; the architecture supports the vocabulary but M3 must not populate or enable it without a separate reviewed policy.
- future user confirmation: create a new native verified Memory backed only by the new user evidence and link it with `revalidates` or `supersedes`; the old row remains `legacy_unverified`.

Legacy results must be visibly labeled to Context Gateway as `legacy_unverified / legacy_limited / historical_hint`. Prompt formatting should say it is a weak historical clue and must not override the current conversation. The label is model guidance in addition to—not instead of—deterministic gates.

## 11. Context Injection Contract

The retrieval service returns structured data:

```ts
type RetrievalCandidate = {
  memory_id: string
  content: string
  content_hash: string
  memory_class: "observation" | "stable"
  category: string
  provenance_status: "verified_user" | "derived_verified" | "manual_confirmed" | "legacy_unverified"
  lifecycle_status: string
  retrieval_tier: string | null
  authority_tier: "native_verified" | "legacy_limited" | "none"
  claim_key: string | null
  source_time: string | null
  temporal_state: "current" | "historical" | "expired" | "resolved" | "unknown"
  relation_summary: { representative_id: string; suppressed_ids: string[] }
  score_parts: {
    semantic_similarity: number | null
    lexical_score: number
    entity_overlap: number
    explicit_recall_match: number
    temporal_relevance: number
    importance_component: number
    policy_score: number | null
  }
  reason_codes: string[]
  eligible_for_prompt: boolean
  eligible_for_proactive_attention: false
}
```

Response envelope:

```ts
{
  query: { attempted, mode, version, reason_codes, raw_text_logged: false },
  selected: RetrievalCandidate[],
  suppressed: [{ memory_id, content_hash, reason_codes }],
  diagnostics: {
    policy_version, embedding_read_version, candidate_count,
    eligible_count, selected_count, latency_ms, token_budget,
    used_chars, error_code
  }
}
```

Passive defaults: maximum three results, maximum one legacy result, and the existing dynamically allocated Memory budget. Results order is strongest factual grounding first, then historical support; never order solely by age. Do not cut a claim mid-sentence to fit. Select whole results that fit the budget.

Context Gateway applies the final Core/Recent/Active/Summary duplicate and contradiction check, preserves IDs/reasons in internal diagnostics, and renders only selected content. It must not flatten the result to strings before the final gate. `eligible_for_prompt` never implies “mention this”; the stable prompt boundary remains in force.

## 12. Shadow Read Architecture

M3D production behavior:

```text
same QueryPlan
  -> Ombre current result -> existing production Context Gateway -> model
  -> XiaoC retrieval(mode=shadow) -> metrics only -> never prompt/model
```

The XiaoC branch must be non-blocking and protected by a short timeout/circuit breaker. Failure cannot delay or fail chat. Shadow mode may inspect `shadow_only` only when metrics clearly separate `would_be_production_eligible=false`; disabled/quarantined/deleted data remains out unless a separate offline review explicitly requires exact-ID audit.

Per-query content-free metrics:

- query attempted/skipped and reason codes;
- hashed query fingerprint using a keyed/versioned local digest, never raw query;
- candidate, eligible, selected, suppressed, missing-embedding counts;
- total and stage latency;
- mapped ID overlap with Ombre when a safe `legacy_memory_map` mapping exists;
- XiaoC-only memory IDs;
- Ombre-only bucket ID or content hash only if returned/derived safely—current `/memory-search` lacks IDs, so this metric is initially **UNKNOWN/unavailable**, not inferred from titles;
- authority/provenance/retrieval-tier distributions;
- selection and suppression reason-code distributions;
- empty-result, timeout, and error rates;
- policy/query/embedding versions.

Do not log raw Memory body, titles, raw query, model prompt, or evidence quote. The current Ombre plain-text response prevents reliable identity overlap; M3D should report comparison coverage separately rather than approximate identity from private text.

## 13. Evaluation Plan

Build a private, versioned offline dataset with expected eligibility, expected claim winner, acceptable result IDs, forbidden IDs, and whether injection is appropriate. Keep bodies local and reports content-free.

Required categories:

| Category | Success condition |
|---|---|
| Explicit recall | relevant eligible fact/event in top-k; no unsafe version |
| Implicit continuity | resolves a generic short reference using allowed Recent/Active context |
| Current-state contradiction | current/new fact wins even if stale vector similarity is higher |
| Old preference | historical preference labeled/withheld according to temporal state |
| Changed plan | completed/cancelled/superseded plan never presented as current |
| Relationship fact | only verified/high-authority eligible source can ground current relationship claim |
| Historical event | retrieves past episode with historical temporal label |
| Temporal fact | validity window and query intent align |
| Nickname/entity | lexical channel recovers exact short/rare entity |
| Irrelevant semantic similarity | similar wording but wrong claim/entity is rejected |
| No retrieval needed | no call or empty injection without continuity loss |
| Legacy trap | shadow/disabled/ambiguous legacy never enters production result |
| Superseded claim | active representative selected; old cluster forbidden |
| Cross-layer duplicate | fact already in Current/Recent/Active/Core consumes no Memory slot |
| Missing embedding | lexical fallback works without eligibility broadening |
| Cross-user isolation | zero IDs from another user at every stage |

Include a fixture modeling the known travel-plan/short-reference continuity failure, but keep the concrete incident phrase only in test data. Production query rules use generic referent/entity/Active-context logic.

Measure at least precision@k, recall of acceptable IDs, explicit-recall success, continuity success, dangerous contradiction rate, legacy false-current-state rate, forbidden-tier leakage, empty recall rate, no-retrieval precision, p50/p95 latency, error/timeout rate, and average selected characters. Report native and legacy cohorts separately.

Hard safety expectations before shadow production: zero cross-user leakage, zero forbidden-tier leakage, zero superseded resurrection, and zero dangerous contradictions in the curated regression set.

## 14. Ombre Exit Criteria

### 14.1 Ombre primary + XiaoC shadow -> XiaoC primary + Ombre fallback

Require a reviewed representative set and a production shadow observation window. Minimum gates:

- 100% pass for cross-user, lifecycle/tier, Core exclusion, relation, temporal, and resurrection tests;
- dangerous contradiction rate = 0 across the reviewed dataset and representative production reviews;
- legacy false-current-state rate = 0;
- forbidden-tier production selection = 0;
- explicit recall success >= 95% on eligible cases;
- continuity success >= 90% on eligible implicit-continuity cases;
- precision@3 >= 90% and no statistically/materially worse safe recall than Ombre on the reviewed set;
- unexpected empty-result rate <= 5% for cases with a known eligible answer, measured separately from correct empty results;
- p95 XiaoC retrieval latency <= 500 ms excluding one-time embedding generation, and shadow timeout/error rate < 1%;
- 100% selected results include policy/version/reason diagnostics and no raw bodies in telemetry;
- rollback to Ombre-only read is exercised without changing stored Memory or Core snapshots.

Because only six legacy rows are currently production-eligible, raw overlap with Ombre is not a quality target. Safe precision and correctly empty results are more important than copying Ombre's broader recall.

### 14.2 XiaoC primary + Ombre fallback -> XiaoC only

In addition to retaining all gates above:

- the fallback is unused for at least a defined observation window (recommended 14 normal-use days and at least 50 attempted eligible queries; extend the window if volume is lower);
- no unresolved XiaoC-only capture/retrieval consistency failures;
- explicit recall and continuity thresholds remain satisfied on newly observed cases;
- p95/error budgets remain satisfied without Ombre;
- Core/PIN source migration has its own separately approved 100% mapping and snapshot tests; existing snapshots remain unchanged;
- native backup/restore and embedding-version rollback are exercised;
- Ombre historical backup remains verified and a separately authorized retirement plan exists.

Ombre retirement/deletion is not part of M3 and requires explicit authorization.

## 15. Proposed M3 Implementation Sequence

### M3A — Architecture (this document)

- Do: identify real paths, define contracts, gates, evaluation and exit criteria.
- Do not: code, write DB, create embeddings, change runtime.
- Production impact: none.
- Rollback: delete/revert this uncommitted document only.
- Gate: architecture review accepts hybrid strategy, safety model, and schema conclusion.

### M3B1 — Embedding and lexical foundation

- Do: choose provider/model/dimension/preprocessor via approved evaluation; implement offline deterministic query normalization; add idempotent embedding job and tests behind disabled gates; use existing protected embedding RPC.
- Do not: activate vectors, query production chat, send Memory bodies before separate approval.
- Production impact: none by default; any real embedding generation requires separate authorization.
- Rollback: leave artifacts `shadow/stale`, keep active read version unset.
- Gate: content-hash/version/dimension tests, privacy review, cost estimate, and 100% idempotent coverage diagnostics.

### M3B2 — Deterministic eligibility and claim resolver

- Do: implement same-user lifecycle/tier/provenance/authority/claim/relation/temporal filtering as a read-only repository/RPC plus exhaustive tests.
- Do not: rank or inject; do not enable shadow runtime.
- Production impact: none.
- Rollback: unused module/RPC behind off gate; additive DB function can remain unused.
- Gate: zero forbidden-tier/cross-user/resurrection failures and fixed 6/95/49 legacy behavior.

### M3B3 — Candidate generation, hybrid ranking, and structured contract

- Do: lexical + semantic retrieval over B2 eligible IDs, explainable components, dedupe, top-k, token budgeting, content-free diagnostics.
- Do not: connect to chat or replace Ombre.
- Production impact: none.
- Rollback: disabled read version/policy.
- Gate: deterministic test snapshots and latency targets on local/imported data.

### M3C — Offline evaluation

- Do: run the private evaluation suite, tune versioned weights/floors, manually review errors, freeze a candidate policy.
- Do not: use production prompts or change runtime.
- Production impact: none.
- Rollback: retain prior policy version and discard candidate version.
- Gate: all hard safety expectations plus agreed recall/precision thresholds.

### M3D — Production shadow read

- Do: mirror the same QueryPlan to XiaoC under timeout/circuit breaker; keep Ombre as the only prompt source; record content-free comparison metrics.
- Do not: inject XiaoC results, change Core/PIN, or treat shadow hits as attention.
- Production impact: bounded read/latency/cost only; chat output unchanged.
- Rollback: one centralized shadow gate off; no data rollback.
- Gate: Section 14.1 metrics and reviewed representative sample.

### M3E1 — Controlled XiaoC primary + Ombre fallback

- Do: enable XiaoC Dynamic results for explicitly controlled sessions; fallback only on engine failure, not merely empty eligible result; preserve Ombre switch.
- Do not: migrate Core/PIN or retire Ombre.
- Production impact: controlled Dynamic context change.
- Rollback: centralized read-source gate to Ombre; persisted snapshots untouched.
- Gate: sustained thresholds, no dangerous contradictions, fallback and rollback drill.

### M3E2 — XiaoC-only Dynamic retrieval

- Do: remove normal Dynamic fallback after Section 14.2 gates; retain recovery configuration during stabilization.
- Do not: delete Ombre or automatically move Core/PIN.
- Production impact: XiaoC owns Dynamic retrieval.
- Rollback: restore previous read-source configuration during the approved window.
- Gate: separate Core/PIN migration design and later Ombre retirement decision.

## 16. Open Questions / Unknowns

1. Live Ombre embedding provider, model, dimension, enabled state, vector coverage, and current config overrides are unknown from repo.
2. Live Ombre matching weight/threshold overrides are unknown; code defaults are documented above.
3. `/memory-search` omits bucket IDs and scores, so safe identity-level shadow overlap with Ombre is unavailable without changing Ombre or relying on unsafe content matching. M3A recommends accepting this as a metric limitation rather than modifying Ombre.
4. The first XiaoC embedding provider/model/dimension and data-retention policy require a separately approved M3B1 decision.
5. Chinese lexical representation should begin with an exact small-set implementation; whether a versioned search-artifact schema/index is needed depends on measured native volume and quality.
6. Numeric ranking weights and relevance floors remain to be selected by M3C evaluation; the architecture fixes components and gates, not arbitrary values.
7. Native capture into the new `memory_items` tables is not currently the production write path; M3 evaluation must separate the six eligible legacy rows from future native fixtures.
8. M2D documentation status is stale relative to the confirmed completed import and should be reconciled in a separately scoped documentation update, not inside M3A execution.

## 17. Final architecture verdict

- Ombre runtime inspected: **YES**
- Actual Ombre retrieval path identified: **YES**
- Ombre embedding behavior: optional cosine top-50 prefilter in XiaoC's HTTP path; live configuration/dimension unknown
- Ombre ranking behavior: RapidFuzz topic + neutral emotion + `last_active` recency + importance; default threshold 50; resolved rank penalty; top five
- Ombre PIN behavior: separate breath/Core snapshot path, but pinned/permanent records are not inherently excluded from `/memory-search`
- Reusable concepts: bounded results, lexical + semantic channels, cosine similarity, graceful lexical fallback, Context Gateway and token budget
- Ombre runtime/code dependency recommended: **NO**
- Recommended XiaoC retrieval: **HYBRID**
- Eligibility-before-ranking: **YES**
- Legacy safety model: **PASS**
- Claim suppression design: **PASS**
- Context injection contract: **PASS**
- Shadow-read design: **PASS**
- Evaluation plan: **PASS**
- Ombre exit criteria: **PASS**
- Schema changes required before initial offline implementation: **NO**
- Possible later additive schema: versioned Chinese lexical search artifact/index and, only if existing observability proves insufficient, content-free retrieval telemetry
- External calls: **0**
- Supabase writes: **0**
- Production runtime changes: **NO**
- Historical Memory modified: **0**
- Document created: `docs/xiaoc-memory-engine-m3a-retrieval.md`
- Recommended next phase: **M3B1 — Embedding and lexical foundation**, only after architecture approval and separate authorization for any real embedding call
- Blocking issues: **none for offline implementation; live Ombre identity overlap remains unavailable and is explicitly non-blocking**

Final recommendation: **READY FOR M3 IMPLEMENTATION**, beginning with offline, feature-gated M3B1 only.
