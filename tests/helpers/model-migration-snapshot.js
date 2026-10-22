// Model selection and transport adaptation have dedicated behavioral tests.
// Keep all remaining prompt/context/config source under the original snapshot checks.
export function withoutModelMigration(source) {
  return source
    .replace(/^import \{ buildClaudeRequest \} from [^\n]+\n/gm, "")
    .replace(/JSON\.stringify\(buildClaudeRequest\(\{([\s\S]*?)\n(\s*)\}\)\)/g, "JSON.stringify({$1\n$2})")
    .replace(/export const AI_MODELS = \{[\s\S]*?\n\}/, "")
    .replace(/export const CHAT_MODEL_OPTIONS = \[[\s\S]*?\n\]/, "")
    .replace(/export function normalizeChatModel\([\s\S]*?\n\}/, "")
}
