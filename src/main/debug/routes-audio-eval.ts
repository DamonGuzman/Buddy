/**
 * M8.5 audio-experience eval routes (orchestrator-approved).
 *
 *   GET  /timings                {last: TurnTimings|null, history: TurnTimings[]}
 *   GET  /audio/output-stats     {items: PlaybackStatsUpdate[]} (newest last)
 *   GET  /audio/last-output.wav  last ~15s of PLAYED audio, 24kHz mono s16 WAV
 *   POST /eval/ground-truth      {scene, targets:[{name, rect:{x,y,width,height}}]}
 *                                (global DIP; posted by eval/scenes/*.html)
 *   GET  /eval/ground-truth      {scenes: {<scene>: {receivedAt, targets}}}
 */

import type { ServerResponse } from 'node:http';
import { asRecord, readJsonBody, sendJson } from './debug-http';
import type { AudioEvalDebugDeps, DebugServerDeps, RouteTable } from './deps';

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

export const AUDIO_EVAL_ROUTES: RouteTable = {
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
