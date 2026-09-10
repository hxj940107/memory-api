# XiaoC Memory Engine M3D — Production Shadow Read

> Status: M3D/M3D1 deployed; Production 1% Shadow ACTIVE.
> Scope: read-only, non-injecting comparison beside the existing Ombre production path.

## Architecture and non-interference

Production Chat remains `Ombre -> existing Context Gateway -> prompt -> model`. After the existing Ombre result has already been filtered into the Dynamic Memory value used by Chat, M3D schedules an independent `waitUntil` task:

```text
trusted fixed user scope + current message + bounded Active topic/entity anchors
  -> QueryPlan / low-signal skip
  -> M3D0 bounded lexical RPC
  -> M3D0 bounded relation RPC
  -> M3B2 eligibility and claim resolution
  -> M3C-R1 compatibility policy
  -> M3B3 ranking
  -> hash/count-only comparison telemetry
```

The task receives copies of already available inputs and has no return path into Dynamic Memory, Stable Memory, Context Gateway, prompt messages, model output, Active Context, Summary, Moments, Diary, Memory Judge or Proactive Attention. It performs no Memory mutation. OFF, success, timeout and failure therefore use the same production prompt/context/model path.

## Flags, sampling and timeout

- `XIAOC_MEMORY_SHADOW_READ_ENABLED=true` is required. Missing or any other value is OFF.
- `XIAOC_MEMORY_SHADOW_SAMPLE_RATE` is clamped to `0..1` and defaults to `0`.
- `XIAOC_MEMORY_SHADOW_TIMEOUT_MS` defaults to `350`, with a `50..1500` millisecond bound.
- Sampling is deterministic from a one-way hash of the request correlation ID. No random state or user content controls rollout.
- Sampling happens only after the deterministic QueryPlan says retrieval is appropriate. With Shadow enabled and a nonzero rate, each trusted decision emits one body-free event: `eligible_opportunity` identifies the denominator, `sampled` identifies selection, and `attempted` identifies an executed read. Flag OFF and sample `0` emit nothing and make no Shadow RPC.
- The timeout is one total wall-clock deadline covering grounding/QueryPlan, DB retrieval, relation resolution, eligibility and ranking—not a separate budget for every RPC. The configured default remains `350ms`.

The approved Production baseline is currently Shadow enabled at a `0.01` sample rate with the bounded timeout unchanged. This activation does not authorize a higher sample rate or cutover.

## Trusted scope and QueryPlan grounding

Shadow reads require the request owner to equal the server-fixed `APP_USER.defaultUserId`. Missing or mismatched scope skips before any RPC. M3D never derives an owner from client text, Memory content or model output. M3D0 independently checks the same owner on every returned candidate and relation.

The grounding adapter maps at most four existing Active Context `entity`/`topic` values, each at most 64 characters. It does not copy Recent transcripts, Summary, Core, Stable, Dynamic Memory or full Active Context bodies. Greetings and acknowledgements are skipped before retrieval; QueryPlan then applies its existing deterministic recall and grounding rules.

## Zero-embedding degradation

M3D currently runs `lexical_only`. It invokes the bounded lexical and relation RPCs and makes zero embedding-provider calls. Semantic candidate count and semantic RPC latency remain zero. This is the expected production mode while compatible active embeddings are absent, not an error. Semantic production shadow requires a separately reviewed query-embedding strategy.

## Comparison and privacy contract

Ombre's current endpoint has no stable result ID, so M3D temporarily hashes the normalized result content. XiaoC uses the canonical content hash where available and hashes Memory IDs before logging. This may undercount overlap when Ombre truncates or formats content differently; overlap is comparison evidence, never truth.

Telemetry contains only:

- hashed correlation/query fingerprints and hashed identities;
- baseline, candidate, eligible, selected, overlap and difference counts;
- top-1 and top-K overlap indicators;
- retrieval/degradation modes, reason counts and tier/authority distributions;
- lexical, semantic, relation, ranking and total latency;
- bounded error codes.

It excludes the user query, Memory bodies, Recent, Summary, Core, Active Context bodies, vectors and prompt. Terms are `baseline-only`, `shadow-only`, `overlap` and `difference`, never `correct` or `incorrect`.

Telemetry currently uses the project's structured server runtime logger. No Supabase analytics table or schema was added. Durable cross-deployment aggregation remains an explicit storage gap to address before a broad rollout if the hosting log retention is insufficient.

For a controlled 1% smoke test, runtime log aggregation can group `xiaoc_memory_shadow_read` events as follows:

- count `eligible_opportunity`, `sampled`, `attempted`, successful `error_code = null`, and each stable error code;
- aggregate `ombre.count`, XiaoC candidate/eligible/selected counts, empty flags, overlap/baseline-only/shadow-only, reason codes and tier/authority distributions;
- calculate P50/P95 from `latency.shadow_total_ms` and inspect the RPC/ranking components.

The normal error vocabulary is intentionally coarse: `TIMEOUT`, `DB_ERROR`, `MALFORMED_RESPONSE`, `TRUSTED_USER_MISSING`, `QUERYPLAN_ERROR`, `RELATION_ERROR`, and `RANKING_ERROR`. Raw exception messages are never included. This logging is sufficient for the initial 1% operational smoke test; persistent aggregation is not required before 1%, but should be revisited before a broader or long-running rollout.

## Failure isolation

Flag OFF, sample zero, unsampled requests, untrusted scope and QueryPlan skips make zero DB calls and emit no new telemetry. DB errors, malformed rows, relation errors, ranking errors and timeout are caught inside the shadow task, reduced to privacy-safe error metadata and never reject Chat. There is no retry and no distributed breaker; the feature flag is the kill switch.

## Rollout plan

1. Stage 0: flag OFF, sample `0`.
2. **Current stage:** explicitly approved `1%` sample with exactly:
   - `XIAOC_MEMORY_SHADOW_READ_ENABLED=true`
   - `XIAOC_MEMORY_SHADOW_SAMPLE_RATE=0.01`
   - `XIAOC_MEMORY_SHADOW_TIMEOUT_MS=350`
3. Stage 2: separately approved `10%` sample; not started.
4. Stage 3: separately approved `100%` shadow; not started.

Each stage requires review of error/timeout rate, latency, Ombre/XiaoC overlap and empty rates, legacy-tier distribution and reason-code distribution. Advancement is manual.

Immediately turn the flag OFF if cross-user anomalies, Memory writes, prompt/context differences, Chat failures caused by shadow, or body/query logging are nonzero. Quality differences require review but are not themselves proof that either retriever is correct.

The kill switch is only `XIAOC_MEMORY_SHADOW_READ_ENABLED=false`; alternatively, sample rate `0` stops all new Shadow RPCs. Neither requires a code rollback. After any configuration change, verify OFF/zero behavior in logs rather than assuming propagation.

### First review gate

Treat 1% as an operational smoke test, not a quality sample. Review after at least **20 attempted Shadow reads** and at least **7 calendar days**, whichever is later. Twenty attempts is an engineering rollout gate appropriate to a private, low-volume app; it is not a statistical SLA and cannot establish retrieval quality. If 1% produces too few attempts, report it as `operationally safe but low-information`; do not raise the rate implicitly. After the smoke gate has no safety anomaly, a separately approved 10% stage is the practical route to useful comparison evidence.

Immediate stop conditions (threshold zero): prompt/context difference, Shadow-caused Chat failure, Memory mutation, cross-user anomaly, or privacy logging violation. Timeout rate, DB error rate and P95 latency require strong review and may justify stopping, but numeric thresholds remain TBD until a production baseline exists; do not invent them during rollout.

### 1% activation checklist

- Confirm the deployed code revision contains the M3D/M3D1 tests and that all three environment values match the plan above.
- Confirm Ombre remains authoritative and no XiaoC result can reach Context Gateway or any prompt component.
- Confirm Memory Engine RPC grants and trusted fixed user scope remain unchanged.
- Confirm the runtime log view can filter the event name and retain enough data for the first review gate.
- Verify initial events contain no body/query and use only stable error codes.
- Verify zero embeddings remains `LEXICAL_ONLY`; semantic quality is explicitly out of scope.
- Exercise the kill switch operationally if any zero-tolerance stop condition appears.

## M3E prerequisites

M3D completion does not authorize cutover. Replacing Ombre still requires real shadow telemetry review, a separately approved embedding/query-vector and backfill lifecycle, quality review, non-interference evidence and a controlled cutover/rollback design. There is no primary, fallback or merge-to-XiaoC flag in M3D.

The next embedding gate is: lexical Shadow must first be operationally stable, then provider/privacy and query-vector handling must receive separate approval, then embeddings may enter a Shadow-only lifecycle, and only then may hybrid Shadow quality be evaluated. M3D1 selects no provider, sends no historical Memory, and creates no embedding.
