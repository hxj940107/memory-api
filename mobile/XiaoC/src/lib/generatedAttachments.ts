export type GeneratedAttachment = {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  storage_path: string;
  type: "generated_file" | "generated_image";
  display_url?: string;
};

export const normalizeGeneratedAttachments = (
  metadata: unknown,
): GeneratedAttachment[] => {
  if (!metadata || typeof metadata !== "object") return [];

  const attachments = (metadata as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return [];

  return attachments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const size = Number(value.size);

    if (
      !["generated_file", "generated_image"].includes(String(value.type)) ||
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      typeof value.mime_type !== "string" ||
      typeof value.storage_path !== "string" ||
      !Number.isFinite(size)
    ) {
      return [];
    }

    return [{
      id: value.id,
      name: value.name,
      mime_type: value.mime_type,
      size,
      storage_path: value.storage_path,
      type: value.type as GeneratedAttachment["type"],
      ...(typeof value.display_url === "string"
        ? { display_url: value.display_url }
        : {}),
    }];
  });
};

export const isImageAttachment = (attachment: GeneratedAttachment) =>
  /^image\/(?:png|jpe?g|webp)$/i.test(attachment.mime_type.trim());

export const formatAttachmentSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

export const getAttachmentTypeLabel = (mimeType: string) =>
  mimeType === "text/markdown"
    ? "Markdown"
    : mimeType === "text/plain"
      ? "纯文本"
      : "文件";

export const getSafeDownloadFilename = (name: string) =>
  name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 100) || "小C文件.txt";
