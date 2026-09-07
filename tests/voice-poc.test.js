import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const ts = require('../mobile/XiaoC/node_modules/typescript');
const base = path.resolve('mobile/XiaoC/src/lib');
function load(name, overrides = {}, cache = new Map()) {
  if (cache.has(name)) return cache.get(name);
  const code = ts.transpileModule(fs.readFileSync(path.join(base, name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  cache.set(name, module.exports);
  const resolve = key => key in overrides ? overrides[key] : key.startsWith('./') ? load(key.slice(2), overrides, cache) : require(key);
  new Function('require', 'module', 'exports', '__DEV__', code)(resolve, module, module.exports, true);
  return module.exports;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('audio ownership blocks new chat work and waits for in-flight recording before handoff', async () => {
  const { AudioSessionCoordinator } = load('audioSessionCoordinator');
  const coordinator = new AudioSessionCoordinator();
  const operation = deferred();
  const order = [];
  coordinator.registerChatCleanup(async () => { order.push('released-chat'); });
  const pending = coordinator.chatOperation(async () => { await operation.promise; order.push('recording-ready'); });
  const acquiring = coordinator.acquireCall();
  assert.equal(coordinator.isCallOwner, true);
  await coordinator.chatOperation(async () => assert.fail('new recording must not start'));
  await assert.rejects(coordinator.acquireCall());
  operation.resolve(); await pending;
  const release = await acquiring;
  assert.deepEqual(order, ['recording-ready', 'released-chat']);
  release(); release();
  assert.equal(coordinator.isCallOwner, false);
  assert.equal(await coordinator.chatOperation(async () => 42), 42);
});

test('failed chat audio cleanup does not allow a call to start', async () => {
  const { AudioSessionCoordinator } = load('audioSessionCoordinator');
  const coordinator = new AudioSessionCoordinator();
  coordinator.registerChatCleanup(async () => { throw Error('audio'); });
  await assert.rejects(coordinator.acquireCall());
  assert.equal(coordinator.isCallOwner, false);
});

test('metrics never compare phone and worker clocks or invent physical playback samples', () => {
  const { VoicePocMetrics } = load('voicePocMetrics');
  const metrics = new VoicePocMetrics();
  metrics.mark('speech', 'phone', 100);
  metrics.mark('play', 'worker', 150);
  assert.deepEqual(metrics.samples('speech', 'play', 'phone'), { count: 0, p50: null, p95: null });
  metrics.mark('play', 'phone', 250);
  assert.deepEqual(metrics.samples('speech', 'play', 'phone'), { count: 1, p50: 150, p95: 150 });
});

test('ending during native acquisition releases late resources without opening the mic', async () => {
  const startingAudio = deferred();
  const enteredAudio = deferred();
  let stopped = 0;
  const updates = [];
  const { VoicePocSession } = load('voicePocSession', {
    'expo-av': { Audio: { async setAudioModeAsync() {} } },
    '@livekit/react-native': {
      registerGlobals() {}, AudioDeviceModule: { setAutomaticAudioSessionConfiguration() {} }, AudioSession: {
        async configureAudio() {}, async setAppleAudioConfiguration() {},
        async startAudioSession() { enteredAudio.resolve(); await startingAudio.promise; },
        async stopAudioSession() { stopped++; },
      },
    },
    'livekit-client': { Room: class extends EventEmitter { constructor() { super(); assert.fail('room must not be created'); } } },
  });
  const session = new VoicePocSession(update => updates.push(update));
  const opening = session.start('https://example.invalid', 'x'.repeat(32));
  await enteredAudio.promise;
  const closing = session.close();
  assert.equal(session.close(), closing);
  startingAudio.resolve();
  await opening; await closing;
  assert.equal(stopped, 1);
  assert.equal(updates.at(-1).state, 'ended');
});

test('ordinary build config stays unchanged; PoC identity is separate and gated', () => {
  const configure = require('../mobile/XiaoC/app.config.js');
  const config = JSON.parse(fs.readFileSync('mobile/XiaoC/app.json')).expo;
  const before = process.env.XIAOC_VOICE_POC_BUILD;
  const profile = process.env.EAS_BUILD_PROFILE;
  try {
    delete process.env.XIAOC_VOICE_POC_BUILD;
    assert.equal(configure({ config }), config);
    process.env.XIAOC_VOICE_POC_BUILD = '1';
    process.env.EAS_BUILD_PROFILE = 'voice-poc';
    const poc = configure({ config });
    assert.equal(poc.ios.bundleIdentifier, 'com.hxj.xiaoc.voicepoc');
    assert.equal(poc.extra.voicePoc, true);
    assert.equal(poc.ios.infoPlist.UIBackgroundModes, undefined);
    process.env.EAS_BUILD_PROFILE = 'production';
    assert.throws(() => configure({ config }));
  } finally {
    if (before === undefined) delete process.env.XIAOC_VOICE_POC_BUILD; else process.env.XIAOC_VOICE_POC_BUILD = before;
    if (profile === undefined) delete process.env.EAS_BUILD_PROFILE; else process.env.EAS_BUILD_PROFILE = profile;
  }
});

test('PoC build refuses ordinary production API access before reading credentials', () => {
  const api = load('../config/api', {
    'expo-constants': { default: { expoConfig: { extra: { voicePoc: true } } } },
    'expo-secure-store': {
      getItemAsync() { assert.fail('must not read a production token'); },
      setItemAsync() { assert.fail('must not persist a production token'); },
    },
  });
  assert.throws(() => api.apiUrl('/api/memory'), /PRODUCTION_API_DISABLED/);
});
