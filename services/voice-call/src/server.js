import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readConfig } from './config.js';
import { authorized, mediaToken } from './auth.js';
import { createMediaSession } from './media.js';
import { dispose } from '@livekit/rtc-node';

// Temporary development control plane. No Vercel/production API changes.
export function createServer(config, startSession = createMediaSession) {
  let current;
  let starting = false;
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (!authorized(req.headers.authorization, config.bootstrapToken)) return send(401, { error: 'UNAUTHORIZED' });
    if (req.method !== 'POST' || req.url !== '/session') return send(404, { error: 'NOT_FOUND' });
    if (starting || (current && !current.ended)) return send(409, { error: 'CALL_ALREADY_ACTIVE' });
    // The endpoint has no body. Never buffer arbitrary client payloads.
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) return send(400, { error: 'BODY_NOT_ALLOWED' });
    starting = true;
    let session;
    try {
      session = await startSession(config, randomUUID());
      current = session;
      if (res.destroyed) { await session.close(); return; }
      const token = await mediaToken(config, session.roomName, session.identity);
      send(200, { call_id: session.callId, url: config.url, token, expires_in: 60, mode: 'media_only' });
    } catch {
      await session?.close();
      if (!res.destroyed) send(503, { error: 'MEDIA_SESSION_UNAVAILABLE' });
    } finally { starting = false; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 3000;
  return { server, close: async () => { await current?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig();
    const app = createServer(config);
    app.server.listen(config.port, config.host, () => console.log('VOICE_POC_MEDIA_WORKER_READY'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void app.close().finally(() => dispose()));
  } catch {
    console.error('VOICE_POC_CONFIG_INVALID: enable development mode and configure test credentials');
    process.exitCode = 1;
  }
}
