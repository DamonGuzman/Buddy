/**
 * The audio I/O seam: mic capture control, playback control, and model audio
 * output all flow through ONE transport. Default is the panel renderer
 * (typed IPC); the disposable QA-only phone bridge overrides all three legs
 * (it has its own capture/playback pipeline and ignores playback epochs —
 * epoch filtering is a renderer concern).
 */

import type { CaptureCommand, PlaybackCommand } from '../../shared/types';
import type { PhoneAudioTransport } from '../phone-audio-bridge';
import type { PanelPort } from './ports';

export interface AudioTransport {
  capture(command: CaptureCommand): void;
  playback(command: PlaybackCommand, epoch: number): void;
  /** F1 (M2): forwarded model audio, tagged with its response's epoch. */
  output(chunk: ArrayBuffer, itemId: string, epoch: number): void;
}

/** Production default: the panel renderer's worklet pipeline over typed IPC. */
export function panelAudioTransport(panel: PanelPort): AudioTransport {
  return {
    capture: (command) => panel.send('audio:capture', { command }),
    playback: (command, epoch) => panel.send('audio:playback', { command, epoch }),
    output: (chunk, itemId, epoch) => panel.send('audio:output', { chunk, itemId, epoch }),
  };
}

/** QA-only phone bridge: raw PCM both ways, no epoch tagging. */
export function phoneAudioTransport(phone: PhoneAudioTransport): AudioTransport {
  return {
    capture: (command) => phone.capture(command),
    playback: (command) => phone.playback(command),
    output: (chunk) => phone.sendAudio(chunk),
  };
}
