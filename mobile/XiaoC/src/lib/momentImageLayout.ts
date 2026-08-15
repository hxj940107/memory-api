export function getMomentImageLayout(
  aspectRatio: number | null | undefined,
  availableWidth: number,
) {
  const ratio = Number(aspectRatio) > 0 ? Number(aspectRatio) : 4 / 3;
  const maxWidth = ratio < 0.9 ? 220 : ratio <= 1.1 ? 250 : 320;
  const maxHeight = ratio < 0.9 ? 320 : ratio <= 1.1 ? 250 : 240;
  const width = Math.min(availableWidth, maxWidth, maxHeight * ratio);

  return { width, height: width / ratio };
}
