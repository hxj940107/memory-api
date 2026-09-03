export type MessageVoiceAsset = {
  id: string;
  status: "ready";
  storage_path: string;
  mime_type: string;
  size: number;
  duration_seconds: number | null;
  provider: string | null;
  voice_id: string | null;
  voice_version: string | null;
  content_hash: string;
  created_at: string | null;
};

export function normalizeMessageVoiceAsset(metadata: unknown): MessageVoiceAsset | null {
  const voice = metadata && typeof metadata === "object"
    ? (metadata as { voice?: Partial<MessageVoiceAsset> }).voice
    : null;
  if (
    voice?.status !== "ready" ||
    typeof voice.id !== "string" ||
    typeof voice.storage_path !== "string" ||
    typeof voice.mime_type !== "string" ||
    typeof voice.content_hash !== "string" ||
    !Number.isFinite(Number(voice.size))
  ) {
    return null;
  }
  return {
    id: voice.id,
    status: "ready",
    storage_path: voice.storage_path,
    mime_type: voice.mime_type,
    size: Number(voice.size),
    duration_seconds: Number.isFinite(Number(voice.duration_seconds))
      ? Math.max(0, Number(voice.duration_seconds))
      : null,
    provider: typeof voice.provider === "string" ? voice.provider : null,
    voice_id: typeof voice.voice_id === "string" ? voice.voice_id : null,
    voice_version: typeof voice.voice_version === "string" ? voice.voice_version : null,
    content_hash: voice.content_hash,
    created_at: typeof voice.created_at === "string" ? voice.created_at : null,
  };
}

export function formatVoiceDuration(seconds: number | null | undefined) {
  const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
}
