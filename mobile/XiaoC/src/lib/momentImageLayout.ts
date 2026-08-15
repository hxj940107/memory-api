export function getMomentImageLayout(
  aspectRatio: number | null | undefined,
  availableWidth: number,
) {
  const ratio = Number(aspectRatio) > 0 ? Number(aspectRatio) : 4 / 3;

  if (ratio < 0.9) {
    const width = Math.min(availableWidth, 220);
    return { width, height: width / (3 / 4) };
  }

  if (ratio <= 1.1) {
    const width = Math.min(availableWidth, 250);
    return { width, height: width };
  }

  const width = Math.min(availableWidth, 320);
  return { width, height: width / (4 / 3) };
}
