/**
 * Tool-router unit tests: the transport-agnostic parse of both model paths
 * (Codex raw argsJson vs realtime pre-parsed args) into one discriminated
 * union with the exact historical rejection strings, plus the shared
 * point_at capture-selection + §6 mapping (m2 fallback).
 */

import { describe, expect, it } from 'vitest';
import {
  NO_CAPTURE_ERROR,
  parseCodexToolCall,
  parseRealtimeToolCall,
  preparePointAt,
} from '../src/main/conversation/tool-router';
import type { CaptureResult } from '../src/main/capture';

/** 2048x1152 screenshot of a 2560x1440 DIP display (image px -> DIP x1.25). */
function capture(screenIndex: number, isActive = false): CaptureResult {
  return {
    meta: {
      screenIndex,
      displayId: screenIndex + 1,
      imageW: 2048,
      imageH: 1152,
      displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scaleFactor: 1.5,
      isActive,
    },
    jpegBase64: 'ZmFrZQ==',
  };
}

describe('parseCodexToolCall', () => {
  const metas = [capture(0).meta];

  it('classifies the delegation tools, degrading malformed JSON to empty args', () => {
    expect(parseCodexToolCall('spawn_helper_buddy', '{"task":"t"}', metas)).toEqual({
      kind: 'spawn_helper_buddy',
      args: { task: 't' },
    });
    expect(parseCodexToolCall('check_helper_buddies', 'not json', metas)).toEqual({
      kind: 'check_helper_buddies',
      args: {},
    });
    expect(parseCodexToolCall('use_computer', '[broken', metas)).toEqual({
      kind: 'use_computer',
      args: {},
    });
  });

  it('rejects unknown tools with the exact copy', () => {
    expect(parseCodexToolCall('fly_away', '{}', metas)).toEqual({
      kind: 'reject',
      error: 'unknown tool: fly_away',
    });
  });

  it('point_at: malformed JSON and non-numeric args reject with the exact copy', () => {
    expect(parseCodexToolCall('point_at', '[broken', metas)).toEqual({
      kind: 'reject',
      error: 'arguments were not valid JSON',
    });
    expect(parseCodexToolCall('point_at', '{"x":"left","y":1,"screen":0}', metas)).toEqual({
      kind: 'reject',
      error: 'x, y and screen must be numbers',
    });
  });

  it('point_at: valid args are validated/clamped against the capture metas', () => {
    const parsed = parseCodexToolCall(
      'point_at',
      JSON.stringify({ x: 99_999, y: 10.4, screen: 0, label: ' the button ' }),
      metas,
    );
    expect(parsed).toEqual({
      kind: 'point_at',
      args: { x: 2047, y: 10, screen: 0, label: 'the button' },
    });
  });
});

describe('parseRealtimeToolCall', () => {
  it('passes through pre-parsed args and trusts the session-validated point_at', () => {
    expect(
      parseRealtimeToolCall({ callId: 'c1', name: 'spawn_helper_buddy', args: { task: 't' } }),
    ).toEqual({ kind: 'spawn_helper_buddy', args: { task: 't' } });
    expect(
      parseRealtimeToolCall({
        callId: 'c2',
        name: 'point_at',
        args: { x: 1, y: 2, screen: 0 },
      }),
    ).toEqual({ kind: 'point_at', args: { x: 1, y: 2, screen: 0 } });
    expect(parseRealtimeToolCall({ callId: 'c3', name: 'nope', args: {} })).toEqual({
      kind: 'reject',
      error: 'unknown tool: nope',
    });
  });
});

describe('preparePointAt', () => {
  it('selects the capture by screenIndex and maps the model point (§6)', () => {
    const target = preparePointAt({ x: 1024, y: 576, screen: 1 }, [capture(0), capture(1)]);
    expect(target?.capture.meta.screenIndex).toBe(1);
    // Center of the 2048x1152 image -> (1280, 720) DIP.
    expect(target?.mapped.local.x).toBeCloseTo(1280, 5);
    expect(target?.mapped.local.y).toBeCloseTo(720, 5);
  });

  it('falls back to the ACTIVE screen, then the first (m2)', () => {
    const active = preparePointAt({ x: 0, y: 0, screen: 9 }, [capture(0), capture(1, true)]);
    expect(active?.capture.meta.screenIndex).toBe(1);
    const first = preparePointAt({ x: 0, y: 0, screen: 9 }, [capture(0), capture(1)]);
    expect(first?.capture.meta.screenIndex).toBe(0);
  });

  it('returns null for an empty capture batch (caller sends the exact error)', () => {
    expect(preparePointAt({ x: 0, y: 0, screen: 0 }, [])).toBeNull();
    expect(NO_CAPTURE_ERROR).toBe('no screenshot available for that screen');
  });
});
