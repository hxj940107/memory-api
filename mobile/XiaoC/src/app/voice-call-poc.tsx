import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { VoicePocSession, type PocUpdate } from '../lib/voicePocSession';
import { isVoicePocBuild } from '../config/voicePoc';

export default function VoiceCallPoc() {
  const enabled = isVoicePocBuild && Platform.OS === 'ios';
  const session = useRef<VoicePocSession | null>(null);
  const alive = useRef(false);
  const [endpoint, setEndpoint] = useState('');
  const [credential, setCredential] = useState('');
  const [status, setStatus] = useState<PocUpdate>({ state: 'idle' });
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);
  const active = status.state === 'connecting' || status.state === 'listening' || status.state === 'reconnecting';

  useFocusEffect(useCallback(() => {
    alive.current = true;
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') void session.current?.close();
    });
    // Display clock only; never drives media or turn detection.
    const timer = setInterval(() => {
      if (startedAt.current !== null) setElapsed(Math.floor((performance.now() - startedAt.current) / 1000));
    }, 1000);
    return () => {
      alive.current = false;
      listener.remove();
      clearInterval(timer);
      void session.current?.close();
      startedAt.current = null;
    };
  }, []));

  const start = async () => {
    if (!enabled || active) return;
    await session.current?.close();
    if (!alive.current) return;
    setStatus({ state: 'connecting' });
    setElapsed(0); setMuted(false); setSpeaker(false);
    session.current = new VoicePocSession(update => {
      if (!alive.current) return;
      if (update.state === 'listening' && startedAt.current === null) startedAt.current = performance.now();
      if (update.state === 'ended' || update.state === 'error') startedAt.current = null;
      setStatus(previous => ({ ...previous, ...update }));
    });
    const bootstrap = credential;
    setCredential('');
    await session.current.start(endpoint.trim(), bootstrap);
  };

  if (!enabled) return <View style={styles.page}><Text style={styles.text}>仅限 XiaoC Voice PoC iPhone development build。</Text><Pressable onPress={() => router.back()}><Text style={styles.text}>返回</Text></Pressable></View>;

  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Text style={styles.title}>小C · 媒体测试</Text>
    <Text style={styles.text}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} · {status.state}</Text>
    <Text style={styles.text}>Checkpoint A/B。没有接入 STT、LLM 或 TTS。下行是轻声测试音，不回放你的麦克风。</Text>
    {!active && <>
      <TextInput style={styles.input} value={endpoint} onChangeText={setEndpoint} placeholder="测试 Worker HTTPS 地址" placeholderTextColor="#888" autoCapitalize="none" autoCorrect={false} />
      <TextInput style={styles.input} value={credential} onChangeText={setCredential} placeholder="临时开发认证口令（不保存）" placeholderTextColor="#888" secureTextEntry autoCapitalize="none" autoCorrect={false} />
      <Pressable style={styles.button} onPress={() => void start()}><Text style={styles.text}>开始媒体测试</Text></Pressable>
    </>}
    <View style={styles.row}>
      <Pressable disabled={!active} style={styles.button} onPress={() => { const next = !muted; setMuted(next); void session.current?.mute(next); }}><Text style={styles.text}>{muted ? '取消静音' : '静音'}</Text></Pressable>
      <Pressable disabled={!active} style={styles.button} onPress={() => { const next = !speaker; void session.current?.speaker(next).then(() => setSpeaker(next)).catch(() => {}); }}><Text style={styles.text}>{speaker ? '系统路由' : '扬声器'}</Text></Pressable>
      <Pressable disabled={!active} style={styles.button} onPress={() => void session.current?.close()}><Text style={styles.text}>挂断</Text></Pressable>
    </View>
    <Text style={styles.text}>传输帧（含静音帧）：{status.transportFrames ?? 0}</Text>
    <Text style={styles.text}>传输时长（含静音帧）：{status.transportAudioMs ?? 0}ms</Text>
    <Text style={styles.text}>有效麦克风帧：{status.effectiveFrames ?? 0}</Text>
    <Text style={styles.text}>有效麦克风音频：{status.effectiveAudioMs ?? 0}ms</Text>
    <Text style={styles.text}>最近 1 秒有效帧：{status.recentEffectiveFrames ?? 0} · 最大样本：{status.recentMaxSample ?? 0} · 峰值：{status.recentPeak ?? 0}</Text>
    <Text style={styles.text}>Worker 音轨状态：{status.workerTrackMuted ? '已静音' : '发送中'}</Text>
    <Text style={styles.text}>远端轨：{status.remoteTrackSubscribed ? '已订阅' : '未订阅'}</Text>
    <Text style={styles.text}>{status.detail}</Text>
    <Text style={styles.text}>{status.diagnostic}</Text>
    <Text style={styles.text}>实际播放、回声、AirPods：待真机听测。Barge-in / P50 / P95：N/A（未实现、未测量）。</Text>
    <Text style={styles.text}>请低音量开始。后台、锁屏、离开页面或断线即结束；不会自动恢复录音。</Text>
    <Pressable style={styles.button} onPress={async () => { await session.current?.close(); router.back(); }}><Text style={styles.text}>返回</Text></Pressable>
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 24, paddingTop: 80, gap: 16, backgroundColor: '#141414' },
  title: { color: '#fff', fontSize: 24 }, text: { color: '#eee', fontSize: 15, lineHeight: 23 },
  input: { borderWidth: 1, borderColor: '#777', borderRadius: 8, padding: 12, color: '#fff' },
  button: { borderWidth: 1, borderColor: '#777', padding: 12, borderRadius: 8 },
  row: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
});
