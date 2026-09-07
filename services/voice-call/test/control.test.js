import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenVerifier } from 'livekit-server-sdk';
import { authorized, mediaToken } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { createCleanup } from '../src/lifecycle.js';
import { createServer } from '../src/server.js';
import { AudioSource, AudioFrame, dispose } from '@livekit/rtc-node';
import { measurePcm16 } from '../src/audioMetrics.js';
test.after(() => dispose());

const config = {
  key: 'test-key', secret: 's'.repeat(40), bootstrapToken: 'b'.repeat(40), url: 'wss://example.invalid',
};

test('bootstrap fails closed, including unset and malformed credentials', () => {
  for (const header of [undefined, '', 'Bearer wrong', ['Bearer ' + config.bootstrapToken]]) {
    assert.equal(authorized(header, config.bootstrapToken), false);
  }
  assert.equal(authorized('Bearer undefined', undefined), false);
  assert.equal(authorized(`Bearer ${config.bootstrapToken}`, config.bootstrapToken), true);
});

test('media token expires in 60 seconds and only joins its microphone room', async () => {
  const jwt = await mediaToken(config, 'voice-poc-test', 'phone-test');
  const claims = await new TokenVerifier(config.key, config.secret).verify(jwt);
  assert.equal(claims.sub, 'phone-test');
  assert.equal(claims.video.room, 'voice-poc-test');
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.roomAdmin, undefined);
  assert.deepEqual(claims.video.canPublishSources, ['microphone']);
  assert.ok(claims.exp - claims.nbf <= 60);
  await assert.rejects(new TokenVerifier(config.key, 'other-secret').verify(jwt));
});

test('configuration rejects production, missing keys and unencrypted media', () => {
  const env = { VOICE_POC_ENABLED: 'true', VOICE_POC_BOOTSTRAP_TOKEN: config.bootstrapToken,
    LIVEKIT_API_SECRET: config.secret, LIVEKIT_API_KEY: config.key, LIVEKIT_URL: config.url };
  assert.equal(readConfig(env).host, '127.0.0.1');
  for (const change of [{ VOICE_POC_ENABLED: 'false' }, { NODE_ENV: 'production' },
    { LIVEKIT_API_SECRET: '' }, { LIVEKIT_URL: 'ws://example.invalid' }]) {
    assert.throws(() => readConfig({ ...env, ...change }));
  }
});

test('double cleanup releases once, even if one resource fails', async () => {
  const cleanup = createCleanup();
  const released = [];
  cleanup.add(() => released.push('room'));
  cleanup.add(() => { released.push('audio'); throw Error('failed'); });
  cleanup.add(() => released.push('timer'));
  const a = cleanup.close();
  assert.equal(cleanup.close(), a);
  assert.deepEqual(await a, ['RESOURCE_RELEASE_FAILED']);
  assert.deepEqual(released, ['timer', 'audio', 'room']);
  assert.throws(() => cleanup.add(() => {}));
});

function request(server, authorization) {
  return new Promise(resolve => {
    let status;
    server.emit('request', { method: 'POST', url: '/session', headers: { authorization } }, {
      destroyed: false,
      writeHead(value) { status = value; },
      end(body) { resolve({ status, body: JSON.parse(body) }); },
    });
  });
}

test('anonymous request never creates media; concurrent bootstrap creates only one session', async () => {
  let starts = 0;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const { server } = createServer(config, async (_config, callId) => {
    starts++;
    await ready;
    return { callId, roomName: `voice-poc-${callId}`, identity: `phone-${callId}`, ended: false, async close() {} };
  });
  assert.equal((await request(server, undefined)).status, 401);
  assert.equal(starts, 0);
  const first = request(server, `Bearer ${config.bootstrapToken}`);
  assert.equal((await request(server, `Bearer ${config.bootstrapToken}`)).status, 409);
  release();
  const response = await first;
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, 'media_only');
  assert.equal(starts, 1);
});

test('Worker native audio binding accepts, clears and closes an in-memory frame', async () => {
  const source = new AudioSource(48000, 1, 100);
  await source.captureFrame(new AudioFrame(new Int16Array(960), 48000, 1, 960));
  source.clearQueue();
  await source.close();
  assert.equal(source.closed, true);
});

test('effective audio metric distinguishes silent transport frames from microphone signal', () => {
  assert.equal(measurePcm16(new Int16Array(960)).effective, false);
  const signal = new Int16Array(960);
  signal.fill(8);
  const measured = measurePcm16(signal);
  assert.equal(measured.effective, true);
  assert.ok(measured.rms > 0.0002);
});
