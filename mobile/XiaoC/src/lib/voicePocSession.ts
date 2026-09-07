import type { Room as LiveRoom, RemoteAudioTrack } from 'livekit-client';
import { audioSessionCoordinator } from './audioSessionCoordinator';
import { VoicePocMetrics } from './voicePocMetrics';

export type PocState = 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'ended' | 'error';
export type PocUpdate = {
  state?: PocState; detail?: string; transportFrames?: number; transportAudioMs?: number;
  effectiveFrames?: number; effectiveAudioMs?: number; recentEffectiveFrames?: number;
  recentPeak?: number; recentMaxSample?: number; workerTrackMuted?: boolean;
  remoteTrackSubscribed?: boolean; diagnostic?: string;
};

export class VoicePocSession {
  private room?: LiveRoom;
  private releaseAudio?: () => void;
  private audio?: typeof import('@livekit/react-native').AudioSession;
  private request = new AbortController();
  private ended = false;
  private closing?: Promise<void>;
  private opening?: Promise<void>;
  private outputs = new Set<RemoteAudioTrack>();
  private limit?: ReturnType<typeof setTimeout>;
  private connectDeadline?: ReturnType<typeof setTimeout>;
  readonly metrics = new VoicePocMetrics();
  private notify: (value: PocUpdate) => void;

  constructor(notify: (value: PocUpdate) => void) { this.notify = notify; }

  start(url: string, credential: string) {
    if (this.opening || this.ended) throw new Error('SESSION_ALREADY_STARTED');
    this.opening = this.connect(url, credential);
    return this.opening;
  }

  private async connect(url: string, credential: string) {
    try {
      if (!__DEV__ || new URL(url).protocol !== 'https:' || credential.length < 32) throw new Error('INVALID_DEVELOPMENT_CONFIG');
      this.notify({ state: 'connecting' });
      this.connectDeadline = setTimeout(() => { void this.close('error'); }, 25000);
      this.releaseAudio = await audioSessionCoordinator.acquireCall();
      if (this.ended) return;
      // Lazy import: ordinary app startup never loads a missing WebRTC binary.
      const sdk: typeof import('@livekit/react-native') = require('@livekit/react-native');
      sdk.registerGlobals({ autoConfigureAudioSession: false });
      // A previous fast-refresh may have installed LiveKit's default
      // speaker-preferring policy. This PoC owns and configures its session.
      sdk.AudioDeviceModule.setAutomaticAudioSessionConfiguration(null);
      const { Room, RoomEvent, Track }: typeof import('livekit-client') = require('livekit-client');
      this.audio = sdk.AudioSession;
      await this.audio.configureAudio({ ios: { defaultOutput: 'earpiece' } });
      await this.audio.setAppleAudioConfiguration({
        audioCategory: 'playAndRecord',
        audioCategoryOptions: ['allowBluetooth', 'allowBluetoothA2DP', 'allowAirPlay'],
        audioMode: 'voiceChat',
      });
      if (this.ended) return;
      await this.audio.startAudioSession();
      if (this.ended) return;
      const response = await fetch(`${url.replace(/\/$/, '')}/session`, {
        method: 'POST', headers: { Authorization: `Bearer ${credential}` }, signal: this.request.signal,
      });
      if (!response.ok) throw new Error('BOOTSTRAP_FAILED');
      const session = await response.json();
      if (this.ended) return;
      if (session.mode !== 'media_only' || typeof session.token !== 'string' ||
          typeof session.url !== 'string' || !session.url.startsWith('wss://')) throw new Error('INVALID_SESSION');
      const room = new Room({ disconnectOnPageLeave: false });
      this.room = room;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        if (this.ended) { (track as RemoteAudioTrack).setVolume(0); return; }
        this.outputs.add(track as RemoteAudioTrack);
        this.metrics.mark('remote_track_subscribed');
        this.notify({ remoteTrackSubscribed: true, diagnostic: '远端轨已订阅；实际听到测试音需真机确认' });
      });
      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (this.ended || topic !== 'poc.metrics' || participant?.identity !== `worker-${session.call_id}` || payload.length > 1024) return;
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          if (data.type === 'media_stats' && Number.isFinite(data.transport_frames) && Number.isFinite(data.effective_audio_ms)) {
            this.notify({
              transportFrames: data.transport_frames,
              transportAudioMs: data.transport_audio_ms,
              effectiveFrames: data.effective_frames,
              effectiveAudioMs: data.effective_audio_ms,
              recentEffectiveFrames: data.recent_effective_frames,
              recentPeak: data.recent_peak,
              recentMaxSample: data.recent_max_sample,
              workerTrackMuted: data.track_muted === true,
            });
          }
        } catch { /* No payload logging. */ }
      });
      room.on(RoomEvent.Disconnected, () => { void this.close('ended'); });
      // No unverified automatic audio resumption in the first media probe.
      room.on(RoomEvent.Reconnecting, () => {
        this.notify({ state: 'reconnecting' });
        void this.close('error');
      });
      room.on(RoomEvent.MediaDevicesError, () => { void this.close('error'); });
      await room.connect(session.url, session.token);
      if (this.ended) return;
      await room.localParticipant.setMicrophoneEnabled(true);
      if (this.ended) return;
      clearTimeout(this.connectDeadline);
      this.metrics.mark('mic_publish_completed');
      this.notify({ state: 'listening', detail: '仅媒体：上行帧计数 + 下行测试音；未接模型' });
      this.limit = setTimeout(() => { void this.close('ended'); }, 10 * 60 * 1000);
    } catch {
      // Do not await close here: close waits for acquisition to settle.
      void this.close('error');
    } finally {
      clearTimeout(this.connectDeadline);
    }
  }

  async mute(muted: boolean) {
    if (this.ended || !this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(!muted);
      if (this.ended) await this.room.localParticipant.setMicrophoneEnabled(false);
    } catch { void this.close('error'); }
  }

  async speaker(enabled: boolean) {
    if (this.ended || !this.audio) return;
    try {
      await this.audio.setAppleAudioConfiguration({
        audioCategory: 'playAndRecord',
        audioCategoryOptions: enabled
          ? ['allowBluetooth', 'allowBluetoothA2DP', 'allowAirPlay', 'defaultToSpeaker']
          : ['allowBluetooth', 'allowBluetoothA2DP', 'allowAirPlay'],
        audioMode: enabled ? 'videoChat' : 'voiceChat',
      });
      await this.audio.selectAudioOutput(enabled ? 'force_speaker' : 'default');
      this.notify({ diagnostic: enabled ? '已请求切换到扬声器；实际路由需真机听测' : '已请求恢复系统路由；实际路由需真机听测' });
    } catch (error) {
      this.notify({ diagnostic: '音频路由切换失败；会话保持连接' });
      throw error;
    }
  }

  close(state: 'ended' | 'error' = 'ended') {
    if (this.closing) return this.closing;
    this.ended = true;
    this.request.abort();
    clearTimeout(this.limit);
    clearTimeout(this.connectDeadline);
    let immediateReleaseFailed = false;
    for (const track of this.outputs) {
      try { track.setVolume(0); } catch { immediateReleaseFailed = true; }
    }
    // Stop the native capture immediately, before waiting for network work.
    for (const publication of this.room?.localParticipant.audioTrackPublications.values() || []) {
      try { publication.track?.stop(); } catch { immediateReleaseFailed = true; }
    }
    this.closing = Promise.resolve().then(async () => {
      await this.opening?.catch(() => {});
      let failed = immediateReleaseFailed;
      try {
        this.room?.removeAllListeners();
        await this.room?.disconnect(true);
      } catch { failed = true; }
      try { await this.audio?.stopAudioSession(); } catch { failed = true; }
      if (this.releaseAudio) {
        try {
          const { Audio }: typeof import('expo-av') = require('expo-av');
          await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true, staysActiveInBackground: false });
        } catch { failed = true; }
      }
      this.outputs.clear();
      this.releaseAudio?.();
      this.notify({ state: failed ? 'error' : state, detail: failed ? '资源释放报错，需要真机核查' : '会话已关闭；系统麦克风状态需真机确认' });
    });
    return this.closing;
  }
}
