import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/multi-user-m2c2-synthetic.json", import.meta.url),
  "utf8",
))

const PHASES = [
  "companion-root-foundation",
  "additive-owner-columns",
  "mapping-registry",
  "backfill",
  "quarantine",
  "composite-keys",
  "constraint-validation",
]

function clone(value) {
  return structuredClone(value)
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function allRows(state) {
  return Object.values(state.tables).flat()
}

function createRehearsal(source) {
  const baseline = clone(source)
  const state = clone(source)
  state.journal = []
  state.companionInstances = []
  state.quarantine = []
  state.constraints = []

  function mappingFor(owner) {
    return state.mappingRegistry.find((entry) => entry.legacyOwner === owner)
  }

  function quarantine(row, table, reason) {
    if (!state.quarantine.some((entry) => entry.rowKey === row.rowKey && entry.table === table)) {
      state.quarantine.push({ table, rowKey: row.rowKey, reason })
    }
    row.quarantined = true
    row.quarantineReason = reason
    row.ownerUuid = null
  }

  function applyPhase(phase) {
    if (state.journal.includes(phase)) return
    const expected = PHASES[state.journal.length]
    if (phase !== expected) throw new Error(`OUT_OF_ORDER:${phase}:expected:${expected}`)

    if (phase === "companion-root-foundation") {
      state.companionInstances = state.authUsers.map(({ id }) => ({ userId: id, lifecycle: "active" }))
    }

    if (phase === "additive-owner-columns") {
      for (const row of allRows(state)) row.ownerUuid = null
    }

    if (phase === "mapping-registry") {
      for (const entry of state.mappingRegistry) {
        entry.registryState = entry.approved && entry.targetUserId ? "approved-target" : "quarantine"
      }
    }

    if (phase === "backfill") {
      for (const [table, rows] of Object.entries(state.tables)) {
        if (table === "conversationSummary") continue
        for (const row of rows) {
          const mapping = mappingFor(row.legacyOwner)
          if (mapping?.registryState === "approved-target") row.ownerUuid = mapping.targetUserId
        }
      }

      for (const row of state.tables.conversationSummary) {
        const parents = state.tables.conversations.filter((parent) =>
          parent.conversationId === row.conversationId && parent.ownerUuid,
        )
        if (parents.length === 1) row.ownerUuid = parents[0].ownerUuid
      }
    }

    if (phase === "quarantine") {
      for (const [table, rows] of Object.entries(state.tables)) {
        for (const row of rows) {
          if (row.orphan) quarantine(row, table, "orphan-retained")
          else if (!row.ownerUuid) quarantine(row, table, "owner-unapproved-or-ambiguous")
        }
      }

      for (const row of state.tables.messages.filter((candidate) => !candidate.quarantined)) {
        const parent = state.tables.conversations.find((conversation) =>
          !conversation.quarantined &&
          conversation.conversationId === row.conversationId &&
          conversation.ownerUuid === row.ownerUuid,
        )
        if (!parent) quarantine(row, "messages", "cross-tenant-or-missing-parent")
      }
    }

    if (phase === "composite-keys") {
      state.constraints = [
        "conversations(user_id,conversation_id) unique",
        "messages(user_id,conversation_id) -> conversations(user_id,conversation_id)",
        "conversation_summary(user_id,conversation_id) unique",
        "conversation_summary(user_id,conversation_id) -> conversations(user_id,conversation_id)",
      ]
    }

    if (phase === "constraint-validation") validateConstraints(state)
    state.journal.push(phase)
  }

  function migrate({ failAfter } = {}) {
    for (const phase of PHASES) {
      applyPhase(phase)
      if (phase === failAfter) throw new Error(`INJECTED_FAILURE_AFTER:${phase}`)
    }
    return state
  }

  function rollback() {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, clone(baseline), {
      journal: [],
      companionInstances: [],
      quarantine: [],
      constraints: [],
    })
    return state
  }

  return { baseline, state, applyPhase, migrate, rollback }
}

function active(rows) {
  return rows.filter((row) => !row.quarantined)
}

function validateConstraints(state) {
  const roots = new Set(state.companionInstances.map((row) => row.userId))
  for (const row of allRows(state).filter((candidate) => !candidate.quarantined)) {
    assert.ok(row.ownerUuid, `active row lacks UUID owner: ${row.rowKey}`)
    assert.ok(roots.has(row.ownerUuid), `active row lacks companion root: ${row.rowKey}`)
  }

  const conversations = new Set()
  for (const row of active(state.tables.conversations)) {
    const key = `${row.ownerUuid}\u001f${row.conversationId}`
    assert.ok(!conversations.has(key), `duplicate tenant conversation: ${key}`)
    conversations.add(key)
  }

  for (const row of active(state.tables.messages)) {
    assert.ok(conversations.has(`${row.ownerUuid}\u001f${row.conversationId}`), `message parent mismatch: ${row.rowKey}`)
  }

  const summaries = new Set()
  for (const row of active(state.tables.conversationSummary)) {
    const key = `${row.ownerUuid}\u001f${row.conversationId}`
    assert.ok(conversations.has(key), `summary parent mismatch: ${row.rowKey}`)
    assert.ok(!summaries.has(key), `duplicate tenant summary: ${key}`)
    summaries.add(key)
  }
}

test("fixture contains every M2C.2 synthetic risk without private content", () => {
  assert.deepEqual(fixture.mappingRegistry.map((row) => row.classification), [
    "private-current", "historical-valid", "test-prototype", "unknown",
  ])
  assert.ok(fixture.tables.conversations.some((row) => row.legacyOwner === null))
  assert.equal(fixture.tables.conversationSummary.filter((row) => row.orphan).length, 1)
  assert.equal(fixture.tables.momentCandidates.filter((row) => row.orphan).length, 3)
  assert.equal(fixture.tables.momentActivity.filter((row) => row.orphan).length, 2)
  assert.equal(fixture.tables.conversations.filter((row) => row.conversationId === "shared-conversation").length, 2)
  assert.ok(fixture.tables.messages.some((row) => row.rowKey === "m-cross"))
  assert.ok(allRows(fixture).every((row) => !("content" in row) && !("text" in row) && !("summary" in row)))
})

test("forward rehearsal maps only approved cohorts and retains quarantine rows", () => {
  const run = createRehearsal(fixture)
  const state = run.migrate()
  const userId = fixture.authUsers[0].id
  const smallId = fixture.authUsers[1].id

  assert.deepEqual(state.journal, PHASES)
  assert.ok(state.tables.conversations.find((row) => row.rowKey === "c-user-shared").ownerUuid === userId)
  assert.ok(state.tables.conversations.find((row) => row.rowKey === "c-small-shared").ownerUuid === smallId)
  for (const key of ["c-test", "c-other", "c-null"]) {
    const row = state.tables.conversations.find((candidate) => candidate.rowKey === key)
    assert.equal(row.ownerUuid, null)
    assert.equal(row.quarantined, true)
  }

  assert.equal(state.tables.messages.find((row) => row.rowKey === "m-cross").quarantineReason, "cross-tenant-or-missing-parent")
  assert.equal(state.tables.conversationSummary.find((row) => row.rowKey === "s-orphan").quarantineReason, "orphan-retained")
  assert.equal(state.tables.conversationSummary.find((row) => row.rowKey === "s-collision-ambiguous").quarantined, true)
  assert.equal(state.tables.momentCandidates.filter((row) => row.quarantined).length, 3)
  assert.equal(state.tables.momentActivity.filter((row) => row.quarantined).length, 2)
})

test("tenant-qualified Summary/Core identity permits the same conversation ID without collision", () => {
  const state = createRehearsal(fixture).migrate()
  state.tables.conversationSummary.push(
    { rowKey: "future-summary-a", conversationId: "shared-conversation", ownerUuid: fixture.authUsers[0].id },
    { rowKey: "future-summary-b", conversationId: "shared-conversation", ownerUuid: fixture.authUsers[1].id },
  )
  validateConstraints(state)
  const summaries = active(state.tables.conversationSummary).filter((row) => row.conversationId === "shared-conversation")
  assert.deepEqual(new Set(summaries.map((row) => row.ownerUuid)), new Set(fixture.authUsers.map((row) => row.id)))
})

test("migration is idempotent and resumes from a detected partial apply", () => {
  const clean = createRehearsal(fixture)
  const expected = digest(clean.migrate())
  clean.migrate()
  assert.equal(digest(clean.state), expected)

  const partial = createRehearsal(fixture)
  assert.throws(() => partial.migrate({ failAfter: "backfill" }), /INJECTED_FAILURE_AFTER:backfill/)
  assert.deepEqual(partial.state.journal, PHASES.slice(0, 4))
  assert.equal(digest(partial.migrate()), expected)
})

test("every phase boundary can stop and roll back to the exact synthetic baseline", () => {
  for (const failAfter of PHASES) {
    const run = createRehearsal(fixture)
    assert.throws(() => run.migrate({ failAfter }), new RegExp(`INJECTED_FAILURE_AFTER:${failAfter}`))
    run.rollback()
    assert.equal(digest(run.state.tables), digest(fixture.tables), `table rollback mismatch after ${failAfter}`)
    assert.equal(digest(run.state.mappingRegistry), digest(fixture.mappingRegistry), `registry rollback mismatch after ${failAfter}`)
    assert.deepEqual(run.state.journal, [])
  }
})

test("out-of-order apply and cross-tenant relationship both fail closed", () => {
  const outOfOrder = createRehearsal(fixture)
  assert.throws(() => outOfOrder.applyPhase("backfill"), /OUT_OF_ORDER/)

  const run = createRehearsal(fixture)
  const state = run.migrate()
  const row = state.tables.messages.find((candidate) => candidate.rowKey === "m-user-only")
  row.ownerUuid = fixture.authUsers[1].id
  assert.throws(() => validateConstraints(state), /message parent mismatch/)
})
