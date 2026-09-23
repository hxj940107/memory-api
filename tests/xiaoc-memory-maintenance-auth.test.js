import assert from "node:assert/strict"
import test from "node:test"

import {
  rejectMaintenanceOwnerOverride,
  requireXiaoCMaintenanceSecret,
} from "../lib/xiaocMaintenanceAuth.js"

const SECRET = "fixture-maintenance-secret-that-is-never-logged"

test("maintenance secret auth accepts only the exact dedicated header", () => {
  assert.equal(requireXiaoCMaintenanceSecret({ headers: { "x-xiaoc-maintenance-secret": SECRET } }, { XIAOC_MAINTENANCE_SECRET: SECRET }), true)
  assert.throws(() => requireXiaoCMaintenanceSecret({ headers: {} }, { XIAOC_MAINTENANCE_SECRET: SECRET }), { code: "maintenance_unauthorized", status: 401 })
  assert.throws(() => requireXiaoCMaintenanceSecret({ headers: { "x-xiaoc-maintenance-secret": `${SECRET}-wrong` } }, { XIAOC_MAINTENANCE_SECRET: SECRET }), { code: "maintenance_unauthorized", status: 401 })
})

test("maintenance auth fails closed when server configuration is absent", () => {
  assert.throws(() => requireXiaoCMaintenanceSecret({ headers: { "x-xiaoc-maintenance-secret": SECRET } }, {}), { code: "maintenance_not_configured", status: 503 })
})

test("maintenance requests cannot select or override an owner", () => {
  assert.doesNotThrow(() => rejectMaintenanceOwnerOverride({ method: "GET", query: { type: "memory_embedding_maintenance" } }))
  assert.throws(() => rejectMaintenanceOwnerOverride({ method: "GET", query: { user_id: "user" } }), { code: "maintenance_owner_override_forbidden", status: 400 })
  assert.throws(() => rejectMaintenanceOwnerOverride({ method: "POST", body: { user_uuid: "00000000-0000-4000-8000-000000000000" } }), { code: "maintenance_owner_override_forbidden", status: 400 })
})
