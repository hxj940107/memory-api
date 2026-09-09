# XiaoC Memory Engine M3C Private Offline Evaluation

Date: 2026-09-09  
Dataset: `m3c-synthetic-v1`  
Retrieval policy: `m3b3-offline-v1`  
Initial M3C verdict: **NOT READY FOR M3D**  
Current post-R1 verdict: **READY FOR M3D0 only; production shadow remains unauthorized**

## 1. Method and privacy boundary

M3C uses a deterministic, machine-readable synthetic golden set. The harness is `scripts/xiaoc-memory-engine-eval.js`; its source fixture is `tests/fixtures/xiaoc-memory-retrieval-eval.json`. It runs the complete offline candidate → M3B2 eligibility/suppression → M3B3 ranking → threshold → top-k path.

The dataset contains 24 cases across 15 categories: explicit recall, implicit continuity, current-state contradiction, changed plan, historical event, relationship fact, nickname/entity, temporal state, semantic behavior, irrelevant semantic similarity, short ambiguous query, no-retrieval decisions, legacy traps, superseded claims and cross-user isolation. Semantic behavior uses fixed two-dimensional synthetic vectors. No Historical Memory body, production query, external model, embedding API or Supabase client is used.

Every case defines effective golden expectations for selected IDs, suppressed IDs, empty/non-empty behavior, dangerous IDs and reason expectations. The artifact contains IDs, scores, thresholds and reason codes only. It deliberately omits fixture query/body strings and is written with owner-only permissions.

## 2. Base metrics

At the default `K=3`:

| Metric | Result | Gate |
|---|---:|---:|
| Recall@3 | 87.50% | diagnostic |
| Precision@3 | 87.50% | diagnostic |
| MRR | 84.38% | diagnostic |
| Explicit recall success | 0% | >=95% |
| Implicit continuity success | 0% | >=90% |
| Dangerous contradiction rate | 0% | 0% |
| Legacy false-current-state rate | 0% | 0% |
| Superseded resurrection rate | 0% | 0% |
| Cross-user leakage | 0% | 0% |
| Irrelevant recall rate | 100% | <=5% |
| Empty-result correctness | 87.50% | >=95% |
| No-retrieval correctness | 100% | >=95% |

At `K=1`, Recall@1 is 81.25%, Precision@1 is 86.67%, and MRR is 81.25%. Safety gates pass. Quality gates fail. A higher recall number cannot offset the semantic false positives or continuity misses.

## 3. Failures and taxonomy

Four cases fail, all with content-free explanations in the artifact:

1. `explicit_boracay_history` — `LEXICAL_MISS`. The relevant ID scores lexical `0.103333`, below the lexical-only `0.28` floor. Explicit-recall metadata adds a bounded rank component but correctly does not bypass the topical threshold. The missing layer is a generic query-plan/recall-phrase extraction boundary, not a keyword exception.
2. `implicit_island_grounded` — `THRESHOLD_FAILURE`. The relevant ID has lexical relevance `0.275556`, narrowly below `0.28`. Lowering every lexical threshold is not justified because it reduces empty-result correctness elsewhere.
3. `semantic_collision` — `RANKING_FAILURE`. A deliberately wrong event with synthetic semantic `0.99` and no lexical/entity support passes the semantic-only floor. The current contract has no structured entity/claim compatibility guard for such collisions.
4. `lexical_semantic_disagreement` — `RANKING_FAILURE`. A semantic-only distractor ranks above an exact entity hit and is also selected at K=3. Exact lexical evidence survives, but the unrelated semantic result is not rejected.

There are no unexplained failures and no evidence of an eligibility, claim-resolution, temporal, legacy-authority, supersedes or user-isolation regression.

## 4. Ablation

| Mode | Recall@3 | Precision@3 | MRR | Irrelevant recall | Empty correctness |
|---|---:|---:|---:|---:|---:|
| Lexical only | 81.25% | 100% | 81.25% | 0% | 100% |
| Semantic only (synthetic) | 25.00% | 66.67% | 21.88% | 100% | 87.50% |
| Hybrid | 87.50% | 87.50% | 84.38% | 100% | 87.50% |

Hybrid improves recall and MRR over lexical-only on this set, but does not yet improve the overall safety/quality tradeoff: the semantic channel introduces both irrelevant-recall failures. The evidence supports retaining hybrid as the architecture direction only after adding a generic compatibility/floor policy and re-evaluating it. It does not support enabling the current hybrid policy in shadow production.

## 5. Threshold sensitivity

Threshold deltas are applied uniformly to the current provisional floors for diagnosis only:

| Setting | Recall@3 | Precision@3 | Irrelevant recall | Empty correctness |
|---|---:|---:|---:|---:|
| Lower (`-0.08`) | 93.75% | 83.33% | 100% | 75.00% |
| Current | 87.50% | 87.50% | 100% | 87.50% |
| Higher (`+0.08`) | 87.50% | 87.50% | 100% | 87.50% |

Lowering thresholds recovers the implicit-continuity case but worsens precision and empty correctness and does not solve semantic collision. Raising them by this amount changes neither collision because `0.99/1.0` semantic distractors remain far above the floor. Recommendation: do not tune a global threshold to this dataset. Add generic query construction and semantic compatibility evidence, then recalibrate on an expanded holdout set.

## 6. Top-k sensitivity

| K | Recall | Precision | MRR | Irrelevant recall | Safety violations |
|---:|---:|---:|---:|---:|---:|
| 1 | 81.25% | 86.67% | 81.25% | 100% | 0 |
| 3 | 87.50% | 87.50% | 84.38% | 100% | 0 |
| 5 | 87.50% | 87.50% | 84.38% | 100% | 0 |

Increasing K beyond 3 provides no gain on this dataset. K=1 loses one acceptable result due to semantic disagreement. Keep the conservative default K=3 for offline work; do not enlarge it to mask recall failures.

## 7. Required next work

M3D is blocked by quality, not by a production incident. The recommended next phase is a bounded **M3C-R1 Offline Retrieval Quality Remediation**:

- implement a generic, versioned QueryPlan input that separates recall boilerplate from lexical phrases/entities and requires sufficient grounding for implicit references;
- add deterministic entity/claim compatibility evidence and a stricter semantic-only admission policy so a high cosine score cannot independently establish identity;
- add counterexamples and a separate holdout partition;
- rerun the same M3C gates without weakening safety thresholds.

No incident-specific term, LLM classifier, embedding provider or large formula rewrite is authorized by this result.

After quality gates pass, a separate **M3D0 DB Retrieval RPC Foundation** is required before production shadow read. The current database has no production-safe bounded candidate RPC. The future read boundary must be same-user scoped, filter eligible IDs before distance ranking, use only one compatible active embedding identity, cap lexical/semantic pools, and return suppression relations whose replacement may sit outside the candidate pool. A Chinese lexical index/search artifact remains conditional on measured query plans and scale. M3C creates no migration.

## 8. Final gate

- Deterministic rerun: PASS
- Safety gates: PASS
- Quality gates: FAIL
- Real Historical Memory bodies used: 0
- External calls / embeddings / Supabase writes: 0 / 0 / 0
- Production retrieval or Ombre changes: none
- Shadow-read readiness: **NOT READY**

Final recommendation: **do not enter M3D until M3C-R1 passes and M3D0 provides the bounded database read foundation.**

## 9. M3C-R1 offline quality remediation (2026-09-09)

M3C-R1 reproduced all four original failures before changing retrieval behavior. Their traces confirmed the original taxonomy: one conversational-shell lexical miss, one grounded-reference threshold miss, and two semantic evidence-compatibility failures. Eligibility, temporal, claim, relation and legacy gates were not involved and remain unchanged.

### 9.1 Architecture delta

`lib/xiaocMemoryQueryPlan.js` adds a deterministic, model-free `xiaoc-query-plan-v1` between raw input and candidate generation. It:

- removes a bounded vocabulary of generic Chinese recall shells while retaining the payload;
- extracts normalized lexical, entity-like and numeric terms;
- recognizes implicit references without treating the reference itself as evidence;
- accepts only bounded caller-supplied grounding anchors;
- labels grounding `NONE`, `WEAK` or `STRONG`;
- refuses weak reference-only queries unless a strong anchor exists;
- never creates claims or changes Memory provenance, authority or lifecycle.

The production-independent orchestration now uses the QueryPlan retrieval query. This fixed the original explicit recall generically by retrieving against its payload, and fixed grounded implicit continuity by using the anchor rather than conversational filler. No incident-specific entity or travel rule exists.

Semantic-only selection now has a separate evidence admission step after M3B2 and before ranking:

- ungrounded semantic-only candidates are rejected;
- grounded semantic-only candidates require similarity at least `0.82`;
- grounding must come from an explicitly trusted recall flag or at least one strong bounded anchor;
- when another eligible candidate has strong lexical evidence (`>=0.72`), a competing semantic-only candidate is rejected as incompatible;
- hybrid candidates with lexical support keep the existing M3B3 formula and thresholds.

These values are centralized in the versioned offline policy. The global lexical/hybrid/semantic thresholds and the ranking formula were not changed. The change is an evidence admission boundary, not a similarity weight retune. Compatibility rejection remains downstream of all M3B2 hard gates and cannot re-admit an ineligible candidate.

### 9.2 Holdout methodology

The original 24 golden expectations were not changed. A separate 12-case holdout was created before final gate reporting. It contains:

- two explicit recall cases;
- two grounded implicit-continuity cases, including one semantic paraphrase;
- two semantic collisions;
- two lexical/semantic disagreements;
- two ambiguous ungrounded references;
- one legacy/current contradiction;
- one superseded claim.

More than half the holdout avoids travel and uses books, food, baking, shopping, nicknames, relationships, cities, appointments and other life domains. All vectors remain deterministic synthetic fixtures.

### 9.3 Before and after

| Metric | Original before R1 | Original after R1 | Holdout | Combined 36 |
|---|---:|---:|---:|---:|
| Recall@3 | 87.50% | 100% | 100% | 100% |
| Precision@3 | 87.50% | 100% | 100% | 100% |
| MRR | 84.38% | 100% | 100% | 100% |
| Explicit recall success | 0% | 100% | 100% | 100% |
| Implicit continuity success | 0% | 100% | 100% | 100% |
| Irrelevant recall rate | 100% | 0% | 0% | 0% |
| Empty-result correctness | 87.50% | 100% | 100% | 100% |
| No-retrieval correctness | 100% | 100% | 100% | 100% |

Combined Recall@1 and Precision@1 are also 100%. Dangerous contradiction, legacy false-current-state, superseded resurrection and cross-user leakage remain zero in original, holdout and combined cohorts. Semantic collision wrong selections are zero, and semantic-only ungrounded false admission is zero.

### 9.4 Ablation and sensitivity after R1

On the combined 36 cases:

| Mode | Recall@3 | Precision@3 | Implicit continuity | Irrelevant recall |
|---|---:|---:|---:|---:|
| Lexical only | 91.67% | 100% | 66.67% | 0% |
| Semantic only synthetic | 8.33% | 100% | 33.33% | 0% |
| Hybrid | 100% | 100% | 100% | 0% |

Hybrid now retains lexical precision and adds the grounded semantic recall case. Semantic-only remains intentionally narrow rather than serving as a general fallback.

Threshold sensitivity at current, `-0.08`, and `+0.08` is identical on this small remediated suite: all core metrics remain 100% with zero unsafe/irrelevant exposure. Top-k sensitivity for K=1/3/5 is also identical. This is evidence of separation on the current fixtures, not production calibration; M3D shadow observation must still retain the conservative K=3 and current thresholds.

### 9.5 R1 gate

- Original failures reproduced before change: 4/4
- Original expectations changed: no
- Original after R1: safety PASS, quality PASS
- Independent holdout: safety PASS, quality PASS
- Combined 36: safety PASS, quality PASS
- Remaining failures: none
- Real Historical Memory bodies / embeddings / external calls / Supabase writes: 0 / 0 / 0 / 0
- Production retrieval and Ombre changes: none

M3C-R1 is ready for the next isolated engineering phase: **M3D0 — Bounded DB Retrieval RPC Foundation**. This does not authorize production shadow read. M3D0 must implement and transactionally validate the read-only, user-scoped, eligible-before-ranking database boundary described above before any M3D runtime connection.
