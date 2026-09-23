import crypto from "node:crypto"

function maintenanceError(code, status) {
  const error = new Error(code)
  error.code = code
  error.status = status
  return error
}

function requestHeader(req, name) {
  const value = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : String(value || "")
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""))
  const rightBuffer = Buffer.from(String(right || ""))
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

export function requireXiaoCMaintenanceSecret(req, env = process.env) {
  const configured = String(env.XIAOC_MAINTENANCE_SECRET || "")
  if (!configured) throw maintenanceError("maintenance_not_configured", 503)
  const supplied = requestHeader(req, "x-xiaoc-maintenance-secret")
  if (!supplied || !constantTimeEqual(supplied, configured)) {
    throw maintenanceError("maintenance_unauthorized", 401)
  }
  return true
}

export function rejectMaintenanceOwnerOverride(req) {
  const source = req?.method === "GET" ? req?.query : req?.body
  if (source && (Object.hasOwn(source, "user_id") || Object.hasOwn(source, "user_uuid"))) {
    throw maintenanceError("maintenance_owner_override_forbidden", 400)
  }
}
