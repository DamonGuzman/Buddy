#!/usr/bin/env node
/**
 * Mock Realtime server CLI — `npm run mock` (ws://127.0.0.1:8123).
 *
 * Speaks the GA v1 protocol subset in src/main/realtime/protocol.ts with
 * scripted scenarios (see ./scenarios.js): point/button, two, error,
 * audio-only nudge, chat fallback. Point the app at it with
 * CLICKY_MOCK_URL=ws://127.0.0.1:8123.
 *
 * Usage: node tools/mock-realtime/index.js [port]   (or PORT=... env)
 */
'use strict';

const { createMockServer, DEFAULT_PORT } = require('./server');
const { SCENARIOS } = require('./scenarios');

const port = Number(process.env.PORT || process.argv[2] || DEFAULT_PORT);

createMockServer({ port, log: (line) => console.log(line) })
  .then((server) => {
    console.log(`[mock-realtime] ready on ${server.url}`);
    console.log('[mock-realtime] scenarios:');
    for (const s of SCENARIOS) console.log(`  - ${s.name}: ${s.description}`);
    const shutdown = () => {
      console.log('[mock-realtime] shutting down');
      void server.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((err) => {
    console.error(`[mock-realtime] failed to start on port ${port}:`, err.message);
    process.exit(1);
  });
