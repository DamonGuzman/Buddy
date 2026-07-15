/**
 * The production audio-engine singletons, bound to the real environment:
 * the preload `clicky` port and the bundled worklet module URLs. Everything
 * above this file (hooks, dev hooks) shares these instances; the engine
 * classes themselves are environment-free, so tests construct their own with
 * a fake port. Importing this module has no side effects beyond construction
 * — the 'audio:playback' subscription that feeds control() lives in
 * hooks/use-panel-wiring.ts.
 */

import { clicky } from '../clicky';
import { MicCapture } from './capture';
import { AudioPlayer } from './playback';
import captureWorkletUrl from '../worklets/pcm-capture.worklet.js?url&no-inline';
import playerWorkletUrl from '../worklets/pcm-player.worklet.js?url&no-inline';

export const micCapture = new MicCapture(clicky, captureWorkletUrl);
export const audioPlayer = new AudioPlayer(clicky, playerWorkletUrl);
