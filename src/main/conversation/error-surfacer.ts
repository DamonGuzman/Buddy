/**
 * M11 error-catalog surfacing: the single place a classified failure is
 * routed to its surfaces — transcript system entry, assistant error state
 * ('pill'), overlay caption, and the once-per-kind panel auto-show — plus the
 * per-run flags that shape it (pill dedupe window, per-hold mic error, the
 * playback-failed episode, the once-only settings_reset, and the
 * once-per-episode codex plan-limit copy).
 */

import { describeKind } from '../errors';
import type { ErrorParams, ErrorPresentation } from '../errors';
import { showPanelOnce } from '../windows/panel';
import type { AudioDeviceError } from '../../shared/types';
import { ERROR_DEDUPE_MS } from './constants';
import type { OverlayPort, RecorderPort, SettingsPort } from './ports';
import type { TranscriptStore } from './transcript-store';

export interface ErrorSurfacerDeps {
  recorder: RecorderPort | null;
  transcript: TranscriptStore;
  overlays: OverlayPort;
  settings: SettingsPort;
  /** Flip the assistant into the 'error' pill state. */
  setErrorState: () => void;
}

export class ErrorSurfacer {
  /** Last pill-grade error transcript entry (dedupe window). */
  private lastPillErrorAt = 0;
  /** Renderer-reported mic capture failure for the CURRENT hold. */
  private micError: { name: string; message: string } | null = null;
  /** Playback is failed until the renderer reports actually-played samples. */
  private playbackFailedValue = false;
  /** settings_reset is surfaced at most once (on the first turn). */
  private settingsResetSurfaced = false;
  /**
   * M17: the turnToken (episode) for which the `codex_plan_limit` message has
   * already been surfaced — so a multi-point turn that repeatedly hits the
   * spent ChatGPT quota says it ONCE, not once per point.
   */
  private codexPlanLimitSurfacedToken: number | null = null;

  constructor(private readonly deps: ErrorSurfacerDeps) {}

  /**
   * Route one classified failure to its surfaces. The single place the
   * policy is enforced.
   */
  surface(pres: ErrorPresentation): void {
    const { recorder, transcript, overlays } = this.deps;
    recorder?.record('error_presented', pres);
    recorder?.flush();
    const now = Date.now();
    const isPill = pres.surfaces.includes('pill');
    // Dedupe: one failure, two paths (server error event + synthesized failed
    // response-done) — the FIRST entry (more specific classification) wins.
    const suppressed = isPill && now - this.lastPillErrorAt < ERROR_DEDUPE_MS;
    if (pres.surfaces.includes('transcript') && !suppressed) {
      transcript.upsert({
        id: transcript.mintId('sys', now),
        role: 'system',
        text: pres.message,
        streaming: false,
        timestamp: now,
      });
    }
    if (pres.surfaces.includes('caption') && !suppressed) {
      overlays.broadcast('overlay:caption', {
        itemId: `sys_err_${now}_${transcript.seq()}`,
        text: pres.message,
        done: true,
      });
    }
    // Actionable kinds surface the panel — at most once per KIND per run
    // (first-run discoverability no longer consumes this budget).
    if (pres.autoShowPanel && pres.kind !== 'unknown') showPanelOnce(pres.kind);
    if (isPill) {
      this.lastPillErrorAt = now;
      this.deps.setErrorState();
    }
  }

  /** M11 (settings_reset): one transcript entry + auto-show, on the first turn. */
  maybeSurfaceSettingsReset(): void {
    if (this.settingsResetSurfaced) return;
    if (!this.deps.settings.settingsWereReset()) return;
    this.settingsResetSurfaced = true;
    this.surface(describeKind('settings_reset'));
  }

  /**
   * M17 fail-closed plan limit: the codex_plan_limit copy, once per episode
   * (shared between the text turn and the grounding pointer path).
   */
  surfacePlanLimitOnce(token: number): void {
    if (this.codexPlanLimitSurfacedToken === token) return;
    this.codexPlanLimitSurfacedToken = token;
    this.surface(describeKind('codex_plan_limit'));
  }

  /**
   * 'audio:capture-error' from the panel renderer: mic capture failed to
   * start, or the playback pipeline failed to init.
   */
  handleDeviceError(payload: AudioDeviceError): void {
    if (payload.source === 'mic') {
      console.warn(`[conversation] mic capture error: ${payload.name}: ${payload.message}`);
      // Remembered for the hold in progress; surfaced at hold end when the
      // hold really produced zero audio (real-hold-with-zero-chunks branch).
      this.micError = { name: payload.name, message: payload.message };
      return;
    }
    console.warn(`[conversation] playback init error: ${payload.name}: ${payload.message}`);
    if (!this.playbackFailedValue) {
      this.playbackFailedValue = true;
      // Captions are forced on while playback is down (see the
      // assistant-transcript listener) so the answer still reaches the user.
      this.surface(describeKind('audio_output_failed'));
    }
  }

  /** M11: mic failures are per-hold. */
  clearMicError(): void {
    this.micError = null;
  }

  /** Kind params for mic_unavailable (NotAllowedError copy variant). */
  micErrorParams(): ErrorParams {
    return this.micError !== null ? { micErrorName: this.micError.name } : {};
  }

  /**
   * M11 (audio_output_failed): samples actually rendered — sound is back,
   * stop forcing captions and re-arm the one-time failure surfacing.
   */
  noteSamplesPlayed(samplesPlayed: number): void {
    if (samplesPlayed > 0) this.playbackFailedValue = false;
  }

  get playbackFailed(): boolean {
    return this.playbackFailedValue;
  }
}
