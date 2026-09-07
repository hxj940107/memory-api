import { timingSafeEqual } from 'node:crypto';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { MEDIA_CONFIG } from './config.js';

export function authorized(header, expected) {
  if (typeof expected !== 'string' || expected.length < 32 || typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function mediaToken(config, room, identity) {
  const token = new AccessToken(config.key, config.secret, {
    identity, ttl: MEDIA_CONFIG.credentialTtlSeconds,
  });
  token.addGrant({
    roomJoin: true, room, canPublish: true, canSubscribe: true,
    canPublishData: true, canPublishSources: [TrackSource.MICROPHONE],
    canUpdateOwnMetadata: false,
  });
  return token.toJwt();
}
