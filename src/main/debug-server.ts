/**
 * Debug harness: CLICKY_DEBUG=1 starts a local HTTP server on
 * 127.0.0.1:8199. QA and E2E tests drive the app through it (no API key
 * needed).
 *
 * M1 routes:
 *   GET /state  -> DebugState JSON (assistant state, overlay count, hotkey...)
 *
 * M2 routes (overlay — see the marked section at the bottom of this file):
 *   POST /overlay/pointer            {screenIndex, points:[{x,y,label?}]} | {type:'idle'|'hide'}
 *   POST /overlay/assistant-state    {state}
 *   POST /overlay/caption            {itemId, text, done}
 *   POST /overlay/capture-indicator  {active}
 *
 * Later milestones extend ROUTES with: simulate hotkey press/release, inject
 * text turn, dump last capture metadata.
 *
 * M8.5 routes (audio-experience eval — see the marked section at the bottom):
 *   GET  /timings                 last + recent TurnTimings
 *   GET  /audio/output-stats      per-item played-audio stats (playback tap)
 *   GET  /audio/last-output.wav   last ~15s of PLAYED audio (24k mono s16 WAV)
 *   POST /eval/ground-truth       eval scene pages report [data-target] rects
 *   GET  /eval/ground-truth       latest report per scene
 *
 * Auth (hardened — replaces the M8.5 optional-token scheme):
 * - EVERY route requires a token via the `X-Debug-Token` header or a
 *   `?token=` query param (the latter for eval scene pages, which POST from a
 *   file:// origin with a simple no-cors request).
 * - The token comes from CLICKY_DEBUG_TOKEN; when unset, a random per-launch
 *   token is generated, logged once, and written to <userData>/debug-token.txt
 *   so local tooling can pick it up with zero setup.
 * - Requests carrying a cross-site Origin header (anything but the literal
 *   "null" a local file:// page sends) are rejected — a browser CSRF POST from
 *   a website always carries its Origin.
 * - Requests whose Host isn't 127.0.0.1:<port> / localhost:<port> are
 *   rejected — DNS-rebinding defense.
 * - In packaged builds (app.isPackaged) the server refuses to start unless
 *   BOTH CLICKY_DEBUG=1 and an explicit CLICKY_DEBUG_TOKEN are set.
 */

import { app } from 'electron';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DEBUG_HOST, DEBUG_PORT, ENV_DEBUG } from '../shared/constants';
import type {
  AssistantState,
  DebugState,
  PlaybackCommand,
  PlaybackStatsUpdate,
  PointerCommand,
  PointerPoint,
  TranscriptEntry,
  TurnTimings,
} from '../shared/types';
import { getOverlayManager } from './windows/overlay';
import type { OverlayManager } from './windows/overlay';

/** M6: hooks into the conversation pipeline (drive real code paths, not sims). */
export interface PipelineDebugDeps {
  pressHotkey: () => void;
  releaseHotkey: () => void;
  askText: (text: string) => Promise<void>;
  getTranscript: () => TranscriptEntry[];
  playback: (command: PlaybackCommand) => void;
}

/** M8.5 (orchestrator-approved): audio-experience eval hooks. */
export interface AudioEvalDebugDeps {
  /** Latest per-item playback stats from the panel's playback tap. */
  getOutputStats: () => PlaybackStatsUpdate[];
  /** Last ~15s of PLAYED audio as Int16 PCM 24kHz mono (null until reported). */
  getLastOutputRing: () => ArrayBuffer | null;
  /** Turn latency instrumentation. */
  getTimings: () => { last: TurnTimings | null; history: TurnTimings[] };
}

/** M9: element-snap grounding hooks (drive the snapper without the model). */
export interface GroundingDebugDeps {
  query: (q: { x: number; y: number; label: string; radiusPx?: number }) => Promise<unknown>;
}

export interface DebugServerDeps {
  getState: () => DebugState;
  pipeline?: PipelineDebugDeps;
  audioEval?: AudioEvalDebugDeps;
  grounding?: GroundingDebugDeps;
}

type RouteHandler = (
  deps: DebugServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

/** method + path -> handler. Extend here (integration-approved). */
const ROUTES: Record<string, RouteHandler> = {
  'GET /state': (deps, _req, res) => {
    sendJson(res, 200, deps.getState());
  },
};

export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_DEBUG] === '1';
}

/** Constant-time string comparison (length leak is fine for random tokens). */
function tokenEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Mandatory token check: the request must carry the token in the
 * X-Debug-Token header or a ?token= query param (the latter for eval scene
 * pages, which POST from a file:// origin with a simple no-cors request).
 */
function checkDebugToken(req: IncomingMessage, expected: string): boolean {
  if (expected.length === 0) return false;
  const header = req.headers['x-debug-token'];
  if (typeof header === 'string' && tokenEquals(header, expected)) return true;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const qp = url.searchParams.get('token');
    return qp !== null && tokenEquals(qp, expected);
  } catch {
    return false;
  }
}

/**
 * CSRF defense: any request a BROWSER makes cross-site carries an Origin
 * header. We accept only requests without one (curl / node fetch / same-app
 * tooling) or with the literal "null" (a local file:// eval scene page).
 * Anything else is a web page doing a cross-site request — reject.
 */
function checkOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === 'null';
}

/**
 * DNS-rebinding defense: the Host header must be the loopback address (or
 * localhost) with our port. A rebound hostname (attacker.com -> 127.0.0.1)
 * shows up here as the attacker's hostname.
 */
function checkHost(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === '127.0.0.1' ||
    host === 'localhost'
  );
}

/**
 * Resolve the auth token: explicit CLICKY_DEBUG_TOKEN, or a random per-launch
 * token persisted to <userData>/debug-token.txt for zero-setup local tooling.
 */
function resolveToken(): string {
  const explicit = process.env['CLICKY_DEBUG_TOKEN'];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const token = randomBytes(24).toString('hex');
  const tokenPath = join(app.getPath('userData'), 'debug-token.txt');
  try {
    writeFileSync(tokenPath, token, { encoding: 'utf8' });
    console.log(`[debug] auth token generated for this launch: ${token} (also at ${tokenPath})`);
  } catch (err) {
    console.error(`[debug] could not write ${tokenPath}:`, err);
    console.log(`[debug] auth token generated for this launch: ${token}`);
  }
  return token;
}

/**
 * Start the debug server. Returns null when CLICKY_DEBUG !== '1', or when
 * running packaged without BOTH CLICKY_DEBUG=1 and an explicit token.
 */
export function startDebugServer(deps: DebugServerDeps): Server | null {
  if (!isDebugEnabled()) return null;
  if (app.isPackaged) {
    const explicitToken = process.env['CLICKY_DEBUG_TOKEN'];
    if (explicitToken === undefined || explicitToken.length === 0) {
      console.error(
        '[debug] refusing to start in a packaged build: set BOTH CLICKY_DEBUG=1 ' +
          'and an explicit CLICKY_DEBUG_TOKEN to enable the debug server.',
      );
      return null;
    }
  }

  const token = resolveToken();
  // M8.5: CLICKY_DEBUG_PORT overrides the default port so parallel QA
  // instances (other agents' dev apps hold 8199) can coexist.
  const portEnv = Number(process.env['CLICKY_DEBUG_PORT']);
  const port = Number.isInteger(portEnv) && portEnv > 0 ? portEnv : DEBUG_PORT;

  const server = createServer((req, res) => {
    if (!checkHost(req, port)) {
      sendJson(res, 403, { error: 'bad Host header' });
      return;
    }
    if (!checkOrigin(req)) {
      sendJson(res, 403, { error: 'cross-origin requests are not allowed' });
      return;
    }
    if (!checkDebugToken(req, token)) {
      sendJson(res, 401, { error: 'X-Debug-Token header (or ?token=) required' });
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    const handler = ROUTES[`${req.method ?? 'GET'} ${path}`];
    if (!handler) {
      sendJson(res, 404, { error: 'not found', routes: Object.keys(ROUTES) });
      return;
    }
    void Promise.resolve(handler(deps, req, res)).catch((err: unknown) => {
      sendJson(res, 500, { error: String(err) });
    });
  });

  server.listen(port, DEBUG_HOST, () => {
    console.log(`[debug] listening on http://${DEBUG_HOST}:${port}`);
  });
  server.on('error', (err) => {
    console.error('[debug] server error:', err);
  });
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ===========================================================================
// --- overlay debug routes (M2) ---
//
// Each route forwards to the overlay windows through the exact same
// OverlayManager paths production dispatch uses (routePointer / broadcast),
// so QA drives the real code paths:
//
//   POST /overlay/pointer            {screenIndex, points:[{x,y,label?}]}
//                                    or {type:'idle'} / {type:'hide'}
//   POST /overlay/assistant-state    {state: 'idle'|'listening'|'thinking'|'speaking'|'error'}
//   POST /overlay/caption            {itemId: string, text: string, done?: boolean}
//   POST /overlay/capture-indicator  {active: boolean}
// ===========================================================================

const MAX_DEBUG_BODY_BYTES = 64 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DEBUG_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ASSISTANT_STATES: readonly AssistantState[] = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'error',
];

function parseAssistantState(value: unknown): AssistantState | null {
  return typeof value === 'string' && (ASSISTANT_STATES as readonly string[]).includes(value)
    ? (value as AssistantState)
    : null;
}

function parsePointerPoints(value: unknown): PointerPoint[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const points: PointerPoint[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) return null;
    const x = rec['x'];
    const y = rec['y'];
    const label = rec['label'];
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    if (typeof y !== 'number' || !Number.isFinite(y)) return null;
    if (label !== undefined && typeof label !== 'string') return null;
    points.push({ x, y, ...(typeof label === 'string' ? { label } : {}) });
  }
  return points;
}

/** 503s when overlays are not started yet; otherwise hands them to `use`. */
function withOverlays(res: ServerResponse, use: (overlays: OverlayManager) => void): void {
  const overlays = getOverlayManager();
  if (!overlays) {
    sendJson(res, 503, { error: 'overlay windows not started' });
    return;
  }
  use(overlays);
}

const OVERLAY_ROUTES: Record<string, RouteHandler> = {
  'POST /overlay/pointer': async (_deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    if (!body) {
      sendJson(res, 400, { error: 'JSON object body required' });
      return;
    }
    let cmd: PointerCommand;
    const type = body['type'];
    if (type === 'idle' || type === 'hide') {
      cmd = { type };
    } else {
      const points = parsePointerPoints(body['points']);
      const screenIndex = body['screenIndex'];
      if (!points || typeof screenIndex !== 'number' || !Number.isInteger(screenIndex)) {
        sendJson(res, 400, {
          error:
            'expected {screenIndex: int, points: [{x: number, y: number, label?: string}, ...]}' +
            " or {type: 'idle' | 'hide'}",
        });
        return;
      }
      cmd = { type: 'animate', points, screenIndex };
    }
    withOverlays(res, (overlays) => {
      overlays.routePointer(cmd);
      sendJson(res, 200, { ok: true, sent: cmd });
    });
  },

  'POST /overlay/assistant-state': async (_deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    const state = parseAssistantState(body?.['state']);
    if (!state) {
      sendJson(res, 400, { error: `expected {state: ${ASSISTANT_STATES.join(' | ')}}` });
      return;
    }
    withOverlays(res, (overlays) => {
      overlays.broadcast('overlay:assistant-state', state);
      sendJson(res, 200, { ok: true, sent: state });
    });
  },

  'POST /overlay/caption': async (_deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    const itemId = body?.['itemId'];
    const text = body?.['text'];
    const done = body?.['done'] ?? false;
    if (typeof itemId !== 'string' || typeof text !== 'string' || typeof done !== 'boolean') {
      sendJson(res, 400, { error: 'expected {itemId: string, text: string, done?: boolean}' });
      return;
    }
    withOverlays(res, (overlays) => {
      overlays.broadcast('overlay:caption', { itemId, text, done });
      sendJson(res, 200, { ok: true });
    });
  },

  'POST /overlay/capture-indicator': async (_deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    const active = body?.['active'];
    if (typeof active !== 'boolean') {
      sendJson(res, 400, { error: 'expected {active: boolean}' });
      return;
    }
    withOverlays(res, (overlays) => {
      overlays.broadcast('overlay:capture-indicator', { active });
      sendJson(res, 200, { ok: true });
    });
  },
};

Object.assign(ROUTES, OVERLAY_ROUTES);
// --- end overlay debug routes (M2) ---

// ===========================================================================
// --- M6 pipeline debug routes ---
//
// Drive the FULL production pipeline (same functions as real input, never
// simulations):
//
//   POST /hotkey/press    -> the exact hold-start code path (hotkey FSM)
//   POST /hotkey/release  -> the exact hold-end code path
//   POST /ask             {text} -> the panel:ask-text path
//   GET  /transcript      -> transcript entries array (ring buffer, last 50)
//   POST /playback        {command: 'stop' | 'flush'} passthrough to the panel
// ===========================================================================

/** 503s when the pipeline isn't wired (pre-M6 boot); otherwise hands it over. */
function withPipeline(
  deps: DebugServerDeps,
  res: ServerResponse,
  use: (pipeline: PipelineDebugDeps) => void | Promise<void>,
): void | Promise<void> {
  if (!deps.pipeline) {
    sendJson(res, 503, { error: 'conversation pipeline not wired' });
    return;
  }
  return use(deps.pipeline);
}

const PIPELINE_ROUTES: Record<string, RouteHandler> = {
  'POST /hotkey/press': (deps, _req, res) =>
    withPipeline(deps, res, (pipeline) => {
      pipeline.pressHotkey();
      sendJson(res, 200, { ok: true });
    }),

  'POST /hotkey/release': (deps, _req, res) =>
    withPipeline(deps, res, (pipeline) => {
      pipeline.releaseHotkey();
      sendJson(res, 200, { ok: true });
    }),

  'POST /ask': async (deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    const text = body?.['text'];
    if (typeof text !== 'string' || text.trim().length === 0) {
      sendJson(res, 400, { error: 'expected {text: string}' });
      return;
    }
    await withPipeline(deps, res, async (pipeline) => {
      await pipeline.askText(text);
      sendJson(res, 200, { ok: true });
    });
  },

  'GET /transcript': (deps, _req, res) =>
    withPipeline(deps, res, (pipeline) => {
      sendJson(res, 200, pipeline.getTranscript());
    }),

  'POST /playback': async (deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    const command = body?.['command'];
    if (command !== 'stop' && command !== 'flush') {
      sendJson(res, 400, { error: "expected {command: 'stop' | 'flush'}" });
      return;
    }
    withPipeline(deps, res, (pipeline) => {
      pipeline.playback(command);
      sendJson(res, 200, { ok: true, sent: command });
    });
  },
};

Object.assign(ROUTES, PIPELINE_ROUTES);
// --- end M6 pipeline debug routes ---

// ===========================================================================
// --- M8.5 audio-experience eval routes (orchestrator-approved) ---
//
//   GET  /timings                {last: TurnTimings|null, history: TurnTimings[]}
//   GET  /audio/output-stats     {items: PlaybackStatsUpdate[]} (newest last)
//   GET  /audio/last-output.wav  last ~15s of PLAYED audio, 24kHz mono s16 WAV
//   POST /eval/ground-truth      {scene, targets:[{name, rect:{x,y,width,height}}]}
//                                (global DIP; posted by eval/scenes/*.html)
//   GET  /eval/ground-truth      {scenes: {<scene>: {receivedAt, targets}}}
// ===========================================================================

/** Latest ground-truth report per scene (posted by the eval scene pages). */
interface GroundTruthReport {
  receivedAt: number;
  scene: string;
  dpr?: number;
  window?: unknown;
  targets: {
    name: string;
    /** Human phrasing for the ask ("the save button in the toolbar"). */
    desc?: string;
    rect: { x: number; y: number; width: number; height: number };
  }[];
}
const groundTruthByScene = new Map<string, GroundTruthReport>();

/** 503s when the audio-eval hooks aren't wired; otherwise hands them over. */
function withAudioEval(
  deps: DebugServerDeps,
  res: ServerResponse,
  use: (audioEval: AudioEvalDebugDeps) => void,
): void {
  if (!deps.audioEval) {
    sendJson(res, 503, { error: 'audio eval hooks not wired' });
    return;
  }
  use(deps.audioEval);
}

/** Wrap Int16 PCM (24kHz mono) bytes in a minimal RIFF/WAVE header. */
function pcm16ToWav(pcm: ArrayBuffer, sampleRate = 24_000): Buffer {
  const dataLen = pcm.byteLength;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

function parseGroundTruthBody(body: unknown): GroundTruthReport | null {
  const rec = asRecord(body);
  if (!rec || typeof rec['scene'] !== 'string' || !Array.isArray(rec['targets'])) return null;
  const targets: GroundTruthReport['targets'] = [];
  for (const t of rec['targets']) {
    const tr = asRecord(t);
    const rect = asRecord(tr?.['rect']);
    if (!tr || !rect || typeof tr['name'] !== 'string') return null;
    const { x, y, width, height } = rect as Record<string, unknown>;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number'
    ) {
      return null;
    }
    targets.push({
      name: tr['name'],
      ...(typeof tr['desc'] === 'string' ? { desc: tr['desc'] } : {}),
      rect: { x, y, width, height },
    });
  }
  return {
    receivedAt: Date.now(),
    scene: rec['scene'],
    ...(typeof rec['dpr'] === 'number' ? { dpr: rec['dpr'] } : {}),
    ...(rec['window'] !== undefined ? { window: rec['window'] } : {}),
    targets,
  };
}

const AUDIO_EVAL_ROUTES: Record<string, RouteHandler> = {
  'GET /timings': (deps, _req, res) =>
    withAudioEval(deps, res, (audioEval) => {
      sendJson(res, 200, audioEval.getTimings());
    }),

  'GET /audio/output-stats': (deps, _req, res) =>
    withAudioEval(deps, res, (audioEval) => {
      sendJson(res, 200, { items: audioEval.getOutputStats() });
    }),

  'GET /audio/last-output.wav': (deps, _req, res) =>
    withAudioEval(deps, res, (audioEval) => {
      const ring = audioEval.getLastOutputRing();
      if (ring === null) {
        sendJson(res, 404, { error: 'no played audio reported yet' });
        return;
      }
      const wav = pcm16ToWav(ring);
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': wav.length,
        'content-disposition': 'attachment; filename="last-output.wav"',
      });
      res.end(wav);
    }),

  'POST /eval/ground-truth': async (_deps, req, res) => {
    const report = parseGroundTruthBody(await readJsonBody(req));
    if (!report) {
      sendJson(res, 400, {
        error: 'expected {scene: string, targets: [{name, rect:{x,y,width,height}}, ...]}',
      });
      return;
    }
    groundTruthByScene.set(report.scene, report);
    sendJson(res, 200, { ok: true, scene: report.scene, targets: report.targets.length });
  },

  'GET /eval/ground-truth': (_deps, _req, res) => {
    sendJson(res, 200, { scenes: Object.fromEntries(groundTruthByScene) });
  },
};

Object.assign(ROUTES, AUDIO_EVAL_ROUTES);
// --- end M8.5 audio-experience eval routes ---

// ===========================================================================
// --- M9 grounding debug routes ---
//
//   POST /grounding/query   {x, y, label, radiusPx?}  (x/y in GLOBAL DIP)
//     -> drives the UIA snapper daemon directly against whatever is on
//        screen (no model, no cost): matched element, score, elapsed, and
//        the full scored candidate list for diagnosis. Token-gated like
//        every other route.
// ===========================================================================

const GROUNDING_ROUTES: Record<string, RouteHandler> = {
  'POST /grounding/query': async (deps, req, res) => {
    if (!deps.grounding) {
      sendJson(res, 503, { error: 'grounding hooks not wired' });
      return;
    }
    const body = asRecord(await readJsonBody(req));
    const x = body?.['x'];
    const y = body?.['y'];
    const label = body?.['label'];
    const radiusPx = body?.['radiusPx'];
    if (
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      typeof y !== 'number' ||
      !Number.isFinite(y) ||
      typeof label !== 'string' ||
      label.length === 0 ||
      (radiusPx !== undefined && typeof radiusPx !== 'number')
    ) {
      sendJson(res, 400, {
        error: 'expected {x: number, y: number, label: string, radiusPx?: number} (global DIP)',
      });
      return;
    }
    const result = await deps.grounding.query({
      x,
      y,
      label,
      ...(typeof radiusPx === 'number' ? { radiusPx } : {}),
    });
    sendJson(res, 200, result);
  },
};

Object.assign(ROUTES, GROUNDING_ROUTES);
// --- end M9 grounding debug routes ---

// ===========================================================================
// --- M15 buddy-hover debug routes (isolated section, appended at the very
// end of the file to minimize merge conflicts with parallel main work) ---
//
//   GET /hover/state -> OverlayManager.hoverDebugInfo(): assistant state,
//     buddy host, interactive window + region, persisted buddyRest, and per-
//     overlay {displayId, screenIndex, bounds, scaleFactor, forwarding,
//     interactive, rendererPid, hover status} — everything the hover QA
//     harness needs (cursor targeting, CPU sampling by pid, state asserts).
//
// Same pattern as the M2 overlay routes: reach the overlays through
// getOverlayManager(), never a parallel code path.
// ===========================================================================

const HOVER_ROUTES: Record<string, RouteHandler> = {
  'GET /hover/state': (_deps, _req, res) => {
    withOverlays(res, (overlays) => {
      sendJson(res, 200, overlays.hoverDebugInfo());
    });
  },
};

Object.assign(ROUTES, HOVER_ROUTES);
// --- end M15 buddy-hover debug routes ---
