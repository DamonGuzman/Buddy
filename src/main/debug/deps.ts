/**
 * Dependency seams + route-handler contract for the CLICKY_DEBUG=1 debug
 * server. Route family modules (routes-*.ts) implement `RouteTable`s against
 * these interfaces; debug-server.ts composes them and owns the HTTP listener.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AgentSummary,
  DebugState,
  PlaybackCommand,
  PlaybackStatsUpdate,
  TranscriptEntry,
  TurnTimings,
} from '../../shared/types';

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

export interface AgentDebugDeps {
  spawn(task: string): { ok: true; agentId: string } | { ok: false; reason: string };
  list(): AgentSummary[];
  cancel(id: string): void;
}

export interface DebugServerDeps {
  getState: () => DebugState;
  pipeline?: PipelineDebugDeps;
  audioEval?: AudioEvalDebugDeps;
  grounding?: GroundingDebugDeps;
  agents?: AgentDebugDeps;
}

export type RouteHandler = (
  deps: DebugServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

/** 'METHOD /path' -> handler. */
export type RouteTable = Record<string, RouteHandler>;
