import {
  Room, RoomEvent, AudioSource, AudioFrame, AudioStream,
  LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind,
} from '@livekit/rtc-node';
import { MEDIA_CONFIG as C } from './config.js';
import { mediaToken } from './auth.js';
import { createCleanup } from './lifecycle.js';
import { measurePcm16 } from './audioMetrics.js';

// Media-only probe: counts input frames; never echoes or stores microphone audio.
// The output is a quiet synthetic tone, not TTS. AudioSource backpressure paces it.
export async function createMediaSession(config, callId) {
  const roomName = `voice-poc-${callId}`;
  const identity = `phone-${callId}`;
  const room = new Room();
  const cleanup = createCleanup();
  const readers = new Set();
  let ended = false;
  let frames = 0;
  let samples = 0;
  let effectiveFrames = 0;
  let effectiveSamples = 0;
  let recentEffectiveFrames = 0;
  let peak = 0;
  let trackMuted = false;
  let source;
  let toneTask;
  const close = () => {
    ended = true;
    return cleanup.close();
  };
  const publishStats = async () => {
    if (!room.localParticipant || ended) return;
    const value = {
      type: 'media_stats', call_id: callId,
      transport_frames: frames,
      transport_audio_ms: Math.round(samples / C.sampleRate * 1000),
      effective_frames: effectiveFrames,
      effective_audio_ms: Math.round(effectiveSamples / C.sampleRate * 1000),
      recent_effective_frames: recentEffectiveFrames,
      recent_peak: Number(peak.toFixed(6)),
      recent_max_sample: Math.round(peak * 32768),
      track_muted: trackMuted,
      worker_monotonic_ms: performance.now(),
    };
    recentEffectiveFrames = 0;
    peak = 0;
    await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(value)), {
      reliable: false, topic: 'poc.metrics', destinationIdentities: [identity],
    });
  };
  cleanup.add(() => room.disconnect());
  cleanup.add(async () => {
    await Promise.allSettled([...readers].map(reader => reader.cancel()));
    source?.clearQueue();
    if (source) await source.close();
    await toneTask?.catch(() => {});
  });
  const limit = setTimeout(() => void close(), C.callLimitMs);
  const joinDeadline = setTimeout(() => void close(), C.joinTimeoutMs);
  cleanup.add(() => { clearTimeout(limit); clearTimeout(joinDeadline); });
  cleanup.add(() => room.removeAllListeners());
  room.on(RoomEvent.Disconnected, () => void close());
  room.on(RoomEvent.ParticipantDisconnected, participant => {
    if (participant.identity === identity) void close();
  });
  room.on(RoomEvent.ParticipantConnected, participant => {
    if (participant.identity === identity) clearTimeout(joinDeadline);
  });
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (participant?.identity !== identity || topic !== 'poc.control' || payload.length > 256) return;
    try {
      if (JSON.parse(new TextDecoder().decode(payload)).type === 'hangup') void close();
    } catch { /* Ignore malformed controls without logging their payload. */ }
  });
  room.on(RoomEvent.TrackMuted, (publication, participant) => {
    if (participant.identity !== identity || publication.kind !== TrackKind.KIND_AUDIO) return;
    trackMuted = true;
    void publishStats();
  });
  room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
    if (participant.identity !== identity || publication.kind !== TrackKind.KIND_AUDIO) return;
    trackMuted = false;
    void publishStats();
  });
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (ended || participant.identity !== identity || track.kind !== TrackKind.KIND_AUDIO) return;
    const reader = new AudioStream(track, C.sampleRate, C.channels).getReader();
    readers.add(reader);
    void (async () => {
      try {
        while (!ended) {
          const { value, done } = await reader.read();
          if (done) break;
          frames++;
          samples += value.samplesPerChannel;
          const level = measurePcm16(value.data);
          peak = Math.max(peak, level.peak);
          if (level.effective) {
            effectiveFrames++;
            effectiveSamples += value.samplesPerChannel;
            recentEffectiveFrames++;
          }
          if (frames % C.reportFrames === 0) await publishStats();
        }
      } catch { if (!ended) void close(); }
      finally { readers.delete(reader); reader.releaseLock(); }
    })();
  });
  try {
    await room.connect(config.url, await mediaToken(config, roomName, `worker-${callId}`), { autoSubscribe: true });
    if (ended) { await room.disconnect(); throw new Error('SESSION_EXPIRED'); }
    source = new AudioSource(C.sampleRate, C.channels, C.queueMs);
    const track = LocalAudioTrack.createAudioTrack('poc-test-tone', source);
    cleanup.add(() => track.close(false));
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant.publishTrack(track, options);
    if (ended) { await track.close(); throw new Error('SESSION_EXPIRED'); }
    toneTask = (async () => {
      let offset = 0;
      const count = C.sampleRate * C.frameMs / 1000;
      while (!ended) {
        const pcm = new Int16Array(count);
        for (let i = 0; i < count; i++) {
          // Alternating one-second tone/silence makes the probe recognisable.
          const time = (offset + i) / C.sampleRate;
          const phase = time % 2;
          const envelope = Math.min(1, phase / 0.02, (1 - phase) / 0.02);
          pcm[i] = phase < 1 ? Math.round(Math.max(0, envelope) * C.toneAmplitude * 32767 * Math.sin(2 * Math.PI * C.toneHz * time)) : 0;
        }
        offset += count;
        await source.captureFrame(new AudioFrame(pcm, C.sampleRate, C.channels, count));
      }
    })();
    void toneTask.catch(() => { if (!ended) void close(); });
    return { callId, roomName, identity, close, get ended() { return ended; } };
  } catch (error) {
    await close();
    throw error;
  }
}
