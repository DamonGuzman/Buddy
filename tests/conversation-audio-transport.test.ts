/**
 * AudioTransport seam unit tests: the panel transport wraps commands in the
 * typed IPC payload shapes (with the M2 playback epoch), while the phone
 * bridge transport forwards raw commands/PCM and drops the epoch.
 */

import { describe, expect, it, vi } from 'vitest';
import { panelAudioTransport, phoneAudioTransport } from '../src/main/conversation/audio-transport';

describe('panelAudioTransport', () => {
  it('sends the exact typed IPC payload shapes', () => {
    const send = vi.fn();
    const transport = panelAudioTransport({ send });
    const chunk = new ArrayBuffer(8);

    transport.capture('start');
    transport.playback('flush', 3);
    transport.output(chunk, 'item_1', 3);

    expect(send.mock.calls).toEqual([
      ['audio:capture', { command: 'start' }],
      ['audio:playback', { command: 'flush', epoch: 3 }],
      ['audio:output', { chunk, itemId: 'item_1', epoch: 3 }],
    ]);
  });
});

describe('phoneAudioTransport', () => {
  it('forwards raw commands and PCM, ignoring epochs', () => {
    const capture = vi.fn();
    const playback = vi.fn();
    const sendAudio = vi.fn();
    const transport = phoneAudioTransport({ capture, playback, sendAudio });
    const chunk = new ArrayBuffer(8);

    transport.capture('stop');
    transport.playback('stop', 7);
    transport.output(chunk, 'item_1', 7);

    expect(capture).toHaveBeenCalledWith('stop');
    expect(playback).toHaveBeenCalledWith('stop');
    expect(sendAudio).toHaveBeenCalledWith(chunk);
  });
});
