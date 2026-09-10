# XiaoC Memory Engine M3D — Production Shadow Read

> Status: implemented; production flags remain OFF.
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

No production environment value is changed by this implementation.

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

## Failure isolation

Flag OFF, sample zero, unsampled requests, untrusted scope and QueryPlan skips make zero DB calls and emit no new telemetry. DB errors, malformed rows, relation errors, ranking errors and timeout are caught inside the shadow task, reduced to privacy-safe error metadata and never reject Chat. There is no retry and no distributed breaker; the feature flag is the kill switch.

## Rollout plan (not executed)

1. Stage 0: flag OFF, sample `0`.
2. Stage 1: explicitly approved `1%` sample.
3. Stage 2: explicitly approved `10%` sample.
4. Stage 3: explicitly approved `100%` shadow.

Each stage requires review of error/timeout rate, latency, Ombre/XiaoC overlap and empty rates, legacy-tier distribution and reason-code distribution. Advancement is manual.

Immediately turn the flag OFF if cross-user anomalies, Memory writes, prompt/context differences, Chat failures caused by shadow, or body/query logging are nonzero. Quality differences require review but are not themselves proof that either retriever is correct.

## M3E prerequisites

M3D completion does not authorize cutover. Replacing Ombre still requires real shadow telemetry review, a separately approved embedding/query-vector and backfill lifecycle, quality review, non-interference evidence and a controlled cutover/rollback design. There is no primary, fallback or merge-to-XiaoC flag in M3D.
