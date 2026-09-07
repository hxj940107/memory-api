export const MEDIA_CONFIG = Object.freeze({
  sampleRate: 48000,
  channels: 1,
  frameMs: 20,
  queueMs: 100,
  toneHz: 330,
  toneAmplitude: 0.025,
  callLimitMs: 10 * 60 * 1000,
  joinTimeoutMs: 30000,
  credentialTtlSeconds: 60,
  reportFrames: 50,
});

export function readConfig(env = process.env) {
  if (env.VOICE_POC_ENABLED !== 'true' || env.NODE_ENV === 'production') {
    throw new Error('POC_DISABLED');
  }
  for (const key of ['VOICE_POC_BOOTSTRAP_TOKEN', 'LIVEKIT_API_SECRET']) {
    if (typeof env[key] !== 'string' || env[key].length < 32) throw new Error(`MISSING_${key}`);
  }
  if (!env.LIVEKIT_API_KEY) throw new Error('MISSING_LIVEKIT_API_KEY');
  const url = new URL(env.LIVEKIT_URL || '');
  if (url.protocol !== 'wss:') throw new Error('LIVEKIT_REQUIRES_WSS');
  const port = Number(env.VOICE_POC_PORT || 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  return {
    url: url.toString(), key: env.LIVEKIT_API_KEY, secret: env.LIVEKIT_API_SECRET,
    bootstrapToken: env.VOICE_POC_BOOTSTRAP_TOKEN,
    host: env.VOICE_POC_HOST || '127.0.0.1', port,
  };
}
