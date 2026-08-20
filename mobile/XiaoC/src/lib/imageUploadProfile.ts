export type ImageKind = "screenshot" | "photo";

type ImageSourceInfo = {
  fileName?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
};

export type ImageCompressionProfile = {
  kind: ImageKind;
  maxLongSide: number;
  quality: number;
};

const SCREENSHOT_NAME_PATTERN =
  /(?:screenshot|screen[_ -]?shot|screen[_ -]?capture|截屏|截图|屏幕快照)/i;

export function isLikelyScreenshot(image: ImageSourceInfo) {
  const fileName = String(image.fileName || "");
  if (SCREENSHOT_NAME_PATTERN.test(fileName)) return true;

  const mimeType = String(image.mimeType || "").toLowerCase();
  const width = Number(image.width || 0);
  const height = Number(image.height || 0);
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const screenRatio = shortSide > 0 ? longSide / shortSide : 0;
  const isUiFriendlyFormat =
    mimeType === "image/png" || mimeType === "image/webp";

  return (
    isUiFriendlyFormat &&
    shortSide >= 720 &&
    longSide >= 1280 &&
    screenRatio >= 1.6 &&
    screenRatio <= 2.5
  );
}

export function getImageCompressionProfile(
  image: ImageSourceInfo,
  imageCount: number,
): ImageCompressionProfile {
  if (isLikelyScreenshot(image)) {
    return {
      kind: "screenshot",
      maxLongSide: imageCount > 1 ? 1280 : 1568,
      quality: imageCount > 1 ? 0.8 : 0.84,
    };
  }

  return {
    kind: "photo",
    maxLongSide: imageCount > 1 ? 768 : 1024,
    quality: imageCount > 1 ? 0.58 : 0.65,
  };
}
