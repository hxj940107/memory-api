export const MEMORY_AUTHORITY_MODE = Object.freeze({
  OMBRE_AUTHORITATIVE: "ombre_authoritative",
  OWNED_FRESH_EMPTY: "owned_fresh_empty",
})

export function getMemoryAuthorityMode(env = process.env) {
  const value = String(env?.XIAOC_MEMORY_AUTHORITY_MODE || "").trim()
  if (!value) return MEMORY_AUTHORITY_MODE.OMBRE_AUTHORITATIVE
  if (Object.values(MEMORY_AUTHORITY_MODE).includes(value)) return value
  const error = new Error("Invalid XIAOC_MEMORY_AUTHORITY_MODE")
  error.code = "INVALID_MEMORY_AUTHORITY_MODE"
  throw error
}

export function isOwnedFreshEmptyMode(mode) {
  return mode === MEMORY_AUTHORITY_MODE.OWNED_FRESH_EMPTY
}

export function assertOmbreAuthority(mode) {
  if (mode !== MEMORY_AUTHORITY_MODE.OMBRE_AUTHORITATIVE) {
    const error = new Error("Ombre is not available in owned_fresh_empty mode")
    error.code = "OMBRE_NOT_APPLICABLE"
    throw error
  }
}
