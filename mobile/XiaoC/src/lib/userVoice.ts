export type UserVoiceAsset = {
  id: string;
  status: "ready";
  storage_path: string;
  mime_type: string;
  size: number;
  duration_seconds: number | null;
  provider: "groq" | null;
  model: string | null;
  language: string | null;
  estimated_cost_usd: number | null;
  created_at: string | null;
};

export function normalizeUserVoiceAsset(metadata: unknown): UserVoiceAsset | null {
  const voice = metadata && typeof metadata === "object"
    ? (metadata as { userVoice?: Partial<UserVoiceAsset> }).userVoice
    : null;
  if (
    voice?.status !== "ready" ||
    typeof voice.id !== "string" ||
    typeof voice.storage_path !== "string" ||
    typeof voice.mime_type !== "string" ||
    !Number.isFinite(Number(voice.size))
  ) return null;

  return {
    id: voice.id,
    status: "ready",
    storage_path: voice.storage_path,
    mime_type: voice.mime_type,
    size: Number(voice.size),
    duration_seconds: Number.isFinite(Number(voice.duration_seconds))
      ? Math.max(0, Number(voice.duration_seconds))
      : null,
    provider: voice.provider === "groq" ? "groq" : null,
    model: typeof voice.model === "string" ? voice.model : null,
    language: typeof voice.language === "string" ? voice.language : null,
    estimated_cost_usd: Number.isFinite(Number(voice.estimated_cost_usd))
      ? Math.max(0, Number(voice.estimated_cost_usd))
      : null,
    created_at: typeof voice.created_at === "string" ? voice.created_at : null,
  };
}
