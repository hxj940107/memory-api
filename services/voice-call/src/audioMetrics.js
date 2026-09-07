export const EFFECTIVE_AUDIO_PEAK_THRESHOLD = 4 / 32768;

export function measurePcm16(data) {
  if (!data.length) return { peak: 0, rms: 0, effective: false };
  let peak = 0;
  let sumSquares = 0;
  for (const sample of data) {
    const normalized = Math.abs(sample) / 32768;
    peak = Math.max(peak, normalized);
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / data.length);
  return { peak, rms, effective: peak >= EFFECTIVE_AUDIO_PEAK_THRESHOLD };
}
