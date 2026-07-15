/**
 * Transport-agnostic tool-call routing. Both model paths surface the same
 * four tools — point_at / spawn_agent / check_agents / use_computer — but
 * deliver them differently: the realtime session pre-parses (and for
 * point_at pre-validates) arguments, while the Codex text path hands over a
 * raw `argsJson` string. The parsers below normalize both into ONE
 * discriminated union with the exact rejection strings each path always
 * produced, and `preparePointAt` owns the previously copy-pasted
 * capture-selection + §6 mapping block.
 *
 * Pure functions only — delivery of tool outputs stays with the transports.
 */

import type { CaptureResult } from '../capture';
import { mapModelPoint } from '../coords';
import type { MappedPoint } from '../coords';
import type { PointAtArgs } from '../realtime/protocol';
import { validatePointAtArgs } from '../realtime/protocol';
import type { ToolCall } from '../realtime/session';

/** One normalized tool invocation, or a rejection carrying the tool output error. */
export type ToolInvocation =
  | { kind: 'spawn_agent'; args: unknown }
  | { kind: 'check_agents'; args: unknown }
  | { kind: 'use_computer'; args: unknown }
  | { kind: 'point_at'; args: PointAtArgs }
  | { kind: 'reject'; error: string };

/** Codex tool args parse fail-soft: malformed JSON degrades to {} (not a reject). */
function parseJsonOrEmpty(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson);
  } catch {
    return {};
  }
}

/**
 * Route a complete tool call from the Codex text model (raw argsJson).
 * point_at is strict (its coordinates are load-bearing); the delegation
 * tools accept malformed JSON as empty args and reject on content instead.
 */
export function parseCodexToolCall(
  name: string,
  argsJson: string,
  metas: CaptureResult['meta'][],
): ToolInvocation {
  if (name === 'spawn_agent' || name === 'check_agents' || name === 'use_computer') {
    return { kind: name, args: parseJsonOrEmpty(argsJson) };
  }
  if (name !== 'point_at') {
    return { kind: 'reject', error: `unknown tool: ${name}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return { kind: 'reject', error: 'arguments were not valid JSON' };
  }
  const args = validatePointAtArgs(parsed, metas);
  if (args === null) {
    return { kind: 'reject', error: 'x, y and screen must be numbers' };
  }
  return { kind: 'point_at', args };
}

/**
 * Route a complete tool call from the realtime session. The session already
 * parsed the arguments and validated/clamped point_at's (validatePointAtArgs),
 * so this only classifies.
 */
export function parseRealtimeToolCall(call: ToolCall): ToolInvocation {
  if (call.name === 'spawn_agent' || call.name === 'check_agents' || call.name === 'use_computer') {
    return { kind: call.name, args: call.args };
  }
  if (call.name !== 'point_at') {
    return { kind: 'reject', error: `unknown tool: ${call.name}` };
  }
  // Session pre-validated/clamped these (validatePointAtArgs).
  return { kind: 'point_at', args: call.args as PointAtArgs };
}

/** A point_at resolved against the turn's captures, ready for dispatch. */
export interface PointAtTarget {
  capture: CaptureResult;
  mapped: MappedPoint & { adjusted: boolean };
}

/** Tool-output error when no capture exists for the named (or any) screen. */
export const NO_CAPTURE_ERROR = 'no screenshot available for that screen';

/**
 * Select the capture a point_at refers to and map the model point into it
 * (§6). Captures are KEYED by meta.screenIndex; an unknown index falls back
 * to the ACTIVE screen's capture, then the first (m2 — mirrors
 * realtime/protocol findCaptureForScreen). Null only for an empty batch.
 */
export function preparePointAt(args: PointAtArgs, captures: CaptureResult[]): PointAtTarget | null {
  const byIndex = captures.find((c) => c.meta.screenIndex === args.screen);
  const capture = byIndex ?? captures.find((c) => c.meta.isActive) ?? captures[0];
  if (!capture) return null;
  const mapped = mapModelPoint(
    { x: args.x, y: args.y, ...(args.label !== undefined ? { label: args.label } : {}) },
    capture.meta,
  );
  return { capture, mapped };
}
