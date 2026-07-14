/**
 * Realtime protocol unit tests: client event framing round-trips, server
 * event parsing guards, and point_at argument validation/clamping.
 */

import { describe, expect, it } from 'vitest';
import type {
  ClientEvent,
  ConversationItemCreateEvent,
  ServerEvent,
  SessionUpdateEvent,
} from '../src/main/realtime/protocol';
import { parseServerEvent, validatePointAtArgs } from '../src/main/realtime/protocol';
import {
  getSessionInstructions,
  getTextInstructions,
  getTextToolDefinitions,
  getToolDefinitions,
  POINT_AT_TOOL,
} from '../src/main/persona';
import type { CaptureMeta } from '../src/shared/types';

const roundTrip = <T>(evt: T): T => JSON.parse(JSON.stringify(evt)) as T;

describe('client event framing', () => {
  it('session.update round-trips with the GA session shape', () => {
    const evt: SessionUpdateEvent = {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: getSessionInstructions(),
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: null,
          },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' },
        },
        tools: getToolDefinitions(),
      },
    };
    const back = roundTrip(evt);
    expect(back).toEqual(evt);
    expect(back.session.audio?.input?.turn_detection).toBeNull();
    expect(back.session.tools?.[0]?.name).toBe('point_at');
  });

  it('user message with input_text + input_image data URL round-trips', () => {
    const evt: ConversationItemCreateEvent = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'context: 1 screenshot(s) attached.' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQ' },
        ],
      },
    };
    expect(roundTrip(evt)).toEqual(evt);
  });

  it('function_call_output and buffer/response events round-trip', () => {
    const events: ClientEvent[] = [
      {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      },
      { type: 'input_audio_buffer.append', audio: 'AAAA' },
      { type: 'input_audio_buffer.commit' },
      { type: 'input_audio_buffer.clear' },
      { type: 'response.create' },
      { type: 'response.cancel' },
    ];
    for (const evt of events) expect(roundTrip(evt)).toEqual(evt);
  });
});

describe('parseServerEvent', () => {
  it('parses the known server events', () => {
    const samples: ServerEvent[] = [
      { type: 'session.created', session: { id: 'sess_1' } },
      { type: 'session.updated', session: {} },
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'hey clicky',
      },
      { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
      { type: 'response.output_audio.delta', item_id: 'item_1', delta: 'AAAA' },
      { type: 'response.output_audio.done', item_id: 'item_1' },
      { type: 'response.output_audio_transcript.delta', item_id: 'item_1', delta: 'hi' },
      { type: 'response.output_audio_transcript.done', item_id: 'item_1', transcript: 'hi' },
      { type: 'response.output_text.delta', item_id: 'item_1', delta: 'hi' },
      { type: 'response.function_call_arguments.delta', call_id: 'call_1', delta: '{"x"' },
      {
        type: 'response.function_call_arguments.done',
        call_id: 'call_1',
        name: 'point_at',
        arguments: '{"x":1,"y":2,"screen":0}',
      },
      {
        type: 'response.done',
        response: { id: 'resp_1', status: 'completed', usage: { total_tokens: 42 } },
      },
      { type: 'error', error: { type: 'server_error', message: 'boom' } },
      { type: 'rate_limits.updated', rate_limits: [{ name: 'tokens', remaining: 100 }] },
    ];
    for (const evt of samples) {
      const parsed = parseServerEvent(JSON.stringify(evt));
      expect(parsed).toEqual(evt);
    }
  });

  it('returns null for malformed frames', () => {
    expect(parseServerEvent('not json')).toBeNull();
    expect(parseServerEvent('42')).toBeNull();
    expect(parseServerEvent('null')).toBeNull();
    expect(parseServerEvent('{"no_type":true}')).toBeNull();
    expect(parseServerEvent('{"type":7}')).toBeNull();
  });

  it('passes unknown event types through (the session ignores them)', () => {
    const parsed = parseServerEvent('{"type":"conversation.item.added","item":{}}');
    expect(parsed).not.toBeNull();
    expect((parsed as { type: string }).type).toBe('conversation.item.added');
  });
});

describe('validatePointAtArgs', () => {
  const capture: CaptureMeta[] = [
    {
      screenIndex: 0,
      displayId: 1,
      imageW: 1280,
      imageH: 720,
      displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scaleFactor: 2,
      isActive: true,
    },
    {
      screenIndex: 1,
      displayId: 2,
      imageW: 1024,
      imageH: 768,
      displayBounds: { x: 2560, y: 0, width: 1024, height: 768 },
      scaleFactor: 1,
      isActive: false,
    },
  ];

  it('accepts well-formed args unchanged', () => {
    expect(
      validatePointAtArgs({ x: 100, y: 200, label: 'save button', screen: 1 }, capture),
    ).toEqual({
      x: 100,
      y: 200,
      label: 'save button',
      screen: 1,
    });
  });

  it('rounds fractional coords and keeps label optional', () => {
    expect(validatePointAtArgs({ x: 10.6, y: 19.2, screen: 0 }, capture)).toEqual({
      x: 11,
      y: 19,
      screen: 0,
    });
  });

  it('clamps coords into the screenshot bounds and negatives to zero', () => {
    expect(validatePointAtArgs({ x: 99999, y: -50, screen: 0 }, capture)).toEqual({
      x: 1279,
      y: 0,
      screen: 0,
    });
  });

  it('maps an unknown screen index to the ACTIVE screen (F1 m2)', () => {
    const args = validatePointAtArgs({ x: 99999, y: 10, screen: 7 }, capture);
    expect(args?.screen).toBe(0); // screen 0 is the active one in `capture`
    expect(args?.x).toBe(1279); // clamped against the ACTIVE screen's image
  });

  it('validates against screenIndex KEYS, not array positions (F1 m2)', () => {
    // A skipped display: captures carry screenIndex 0 and 2, positions 0 and 1.
    const skipped: CaptureMeta[] = [
      { ...capture[0]!, isActive: false },
      { ...capture[1]!, screenIndex: 2, isActive: true },
    ];
    // screen 2 exists (by key) and must clamp against ITS 1024x768 image —
    // positional lookup would have rejected/clamped it to position 1's meta
    // while the conversation later looks it up by key.
    expect(validatePointAtArgs({ x: 5000, y: 5000, screen: 2 }, skipped)).toEqual({
      x: 1023,
      y: 767,
      screen: 2,
    });
    // screen 1 does NOT exist in this batch: explicit active-screen fallback.
    const fallback = validatePointAtArgs({ x: 10, y: 10, screen: 1 }, skipped);
    expect(fallback?.screen).toBe(2);
  });

  it('clamps without capture metadata only at zero', () => {
    expect(validatePointAtArgs({ x: 5000, y: 4000, screen: 3 })).toEqual({
      x: 5000,
      y: 4000,
      screen: 3,
    });
  });

  it('rejects garbage', () => {
    expect(validatePointAtArgs(null, capture)).toBeNull();
    expect(validatePointAtArgs('point', capture)).toBeNull();
    expect(validatePointAtArgs({}, capture)).toBeNull();
    expect(validatePointAtArgs({ x: 'left', y: 10, screen: 0 }, capture)).toBeNull();
    expect(validatePointAtArgs({ x: 10, y: NaN, screen: 0 }, capture)).toBeNull();
    expect(validatePointAtArgs({ x: 10, y: 10 }, capture)).toBeNull();
  });

  it('drops non-string labels and caps long ones', () => {
    expect(
      validatePointAtArgs({ x: 1, y: 1, screen: 0, label: 42 }, capture)?.label,
    ).toBeUndefined();
    const long = validatePointAtArgs({ x: 1, y: 1, screen: 0, label: 'a'.repeat(500) }, capture);
    expect(long?.label?.length).toBe(120);
  });
});

describe('persona tool definition', () => {
  it('point_at requires integer x/y/screen and a label, and asks for the center', () => {
    expect(POINT_AT_TOOL.type).toBe('function');
    expect(POINT_AT_TOOL.name).toBe('point_at');
    expect(POINT_AT_TOOL.description).toContain('CENTER');
    const params = POINT_AT_TOOL.parameters as {
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(params.required).toEqual(['x', 'y', 'label', 'screen']);
    expect(params.properties['x']?.type).toBe('integer');
    expect(params.properties['screen']?.type).toBe('integer');
  });

  it('instructions carry the persona contract', () => {
    const instructions = getSessionInstructions();
    expect(instructions).toContain('buddy');
    expect(instructions).toContain('point_at');
    expect(instructions).toContain('chatgpt sign-in');
    expect(instructions).toContain('<system_reminder>');
    expect(instructions).toContain('<agent_result>');
    expect(getToolDefinitions().map((t) => t.name)).toEqual(['point_at']);
    expect(getToolDefinitions(true).map((t) => t.name)).toEqual([
      'point_at',
      'spawn_agent',
      'check_agents',
    ]);
    expect(getToolDefinitions(true, true).map((t) => t.name)).toEqual([
      'point_at',
      'spawn_agent',
      'check_agents',
      'use_computer',
    ]);
    const computerTool = getToolDefinitions(true, true).find(
      (tool) => tool.name === 'use_computer',
    );
    expect(computerTool?.parameters).not.toHaveProperty('properties.x');
    expect(computerTool?.parameters).not.toHaveProperty('properties.keys');
    expect(getSessionInstructions(true, true)).toContain(
      'you have no direct click or keyboard tools',
    );
    expect(getTextToolDefinitions(true).map((t) => t.name)).toEqual([
      'point_at',
      'spawn_agent',
      'check_agents',
    ]);
  });

  it('makes buddy the user-facing orchestrator when agents are available', () => {
    for (const instructions of [getSessionInstructions(true), getTextInstructions(true)]) {
      expect(instructions).toContain('you are buddy, the warm interaction agent');
      expect(instructions).toContain('as buddy, your primary role');
      expect(instructions).toContain('interface between them and your background subagents');
      expect(instructions).toContain('delegate almost every substantive task');
      expect(instructions).toContain('do not try to complete that work yourself first');
      expect(instructions).toContain('evaluate and synthesize its result');
    }
  });
});
