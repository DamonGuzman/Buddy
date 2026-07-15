/**
 * M6 pipeline debug routes.
 *
 * Drive the FULL production pipeline (same functions as real input, never
 * simulations):
 *
 *   POST /hotkey/press    -> the exact hold-start code path (hotkey FSM)
 *   POST /hotkey/release  -> the exact hold-end code path
 *   POST /ask             {text} -> the panel:ask-text path
 *   GET  /transcript      -> transcript entries array (ring buffer, last 50)
 *   POST /playback        {command: 'stop' | 'flush'} passthrough to the panel
 */

import type { ServerResponse } from 'node:http';
import { asRecord, isNonBlankString, readJsonBody, sendJson } from './debug-http';
import type { DebugServerDeps, PipelineDebugDeps, RouteTable } from './deps';

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

export const PIPELINE_ROUTES: RouteTable = {
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
    if (!isNonBlankString(text)) {
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
