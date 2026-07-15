import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeKind } from '../src/main/errors';
import { ErrorSurfacer } from '../src/main/conversation/error-surfacer';
import type { OverlayPort } from '../src/main/conversation/ports';
import { TranscriptStore } from '../src/main/conversation/transcript-store';
import type { CaptionUpdate } from '../src/shared/types';

const showPanelCalls = vi.hoisted(() => [] as string[]);
const actionableNotices = vi.hoisted(() => [] as Array<{ kind: string; message: string }>);
const resolvedTargets = vi.hoisted(() => [] as string[]);

vi.mock('../src/main/windows/panel', () => ({
  showPanelOnce: (reason: string) => showPanelCalls.push(reason),
  presentPanelActionableError: (notice: { kind: string; message: string }) =>
    actionableNotices.push(notice),
  currentPanelActionableError: (kinds: string[]) => ({ revision: 1, kind: kinds[0] }),
  resolvePanelActionableError: (expected: { kind: string } | null) => {
    if (expected) resolvedTargets.push(expected.kind);
  },
}));

function makeHarness(): {
  surfacer: ErrorSurfacer;
  transcript: TranscriptStore;
  events: string[];
  captions: string[];
} {
  const events: string[] = [];
  const captions: string[] = [];
  const transcript = new TranscriptStore(50, () => {});
  const overlays: OverlayPort = {
    broadcast: (channel, payload) => {
      if (channel === 'overlay:caption') {
        events.push('caption');
        captions.push((payload as CaptionUpdate).text);
      }
    },
    routePointer: () => {},
  };
  return {
    surfacer: new ErrorSurfacer({
      recorder: null,
      transcript,
      overlays,
      settings: {
        get: () => ({
          apiKeyUnreadable: false,
          model: 'gpt-realtime-2.1-mini',
          voice: 'marin',
          captionsEnabled: false,
          voiceMuted: false,
          fullRealtimeMode: false,
          computerUseEnabled: false,
          preferApiKeyGrounding: false,
        }),
        getApiKey: () => null,
        settingsWereReset: () => false,
      },
      setErrorState: () => events.push('state:error'),
    }),
    transcript,
    events,
    captions,
  };
}

describe('ErrorSurfacer policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    showPanelCalls.length = 0;
    actionableNotices.length = 0;
    resolvedTargets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions to error before broadcasting an actionable caption', () => {
    const h = makeHarness();
    h.surfacer.surface(describeKind('no_api_key'));
    expect(h.events).toEqual(['state:error', 'caption']);
  });

  it('does not let a prior pill suppress a different actionable reason', () => {
    const h = makeHarness();
    const noKey = describeKind('no_api_key');
    const mic = describeKind('mic_unavailable', { micErrorName: 'NotFoundError' });

    h.surfacer.surface(noKey);
    vi.advanceTimersByTime(100);
    h.surfacer.surface(mic);

    expect(h.transcript.list().map((entry) => entry.text)).toEqual([noKey.message, mic.message]);
    expect(h.captions).toEqual([noKey.message, mic.message]);
    expect(showPanelCalls).toEqual(['no_api_key', 'mic_unavailable']);
  });

  it('preserves first-error-wins dedupe for a correlated transient follow-up', () => {
    const h = makeHarness();
    const rateLimit = describeKind('rate_limited');

    h.surfacer.surface(rateLimit);
    vi.advanceTimersByTime(100);
    h.surfacer.surface(describeKind('response_interrupted'));

    expect(h.transcript.list().map((entry) => entry.text)).toEqual([rateLimit.message]);
    expect(h.captions).toEqual([]);
  });

  it('still dedupes a repeated actionable kind inside the correlation window', () => {
    const h = makeHarness();
    const noKey = describeKind('no_api_key');

    h.surfacer.surface(noKey);
    vi.advanceTimersByTime(100);
    h.surfacer.surface(noKey);

    expect(h.transcript.list()).toHaveLength(1);
    expect(h.captions).toEqual([noKey.message]);
    expect(actionableNotices.map((notice) => notice.kind)).toEqual(['no_api_key', 'no_api_key']);
  });

  it('preserves actionable repair state when a transient error supersedes conversation copy', () => {
    const h = makeHarness();
    h.surfacer.surface(describeKind('model_unavailable'));
    h.surfacer.surface(describeKind('network_unreachable'));

    expect(actionableNotices.map((notice) => notice.kind)).toEqual(['model_unavailable']);
  });

  it('clears a speaker repair notice only after samples actually play', () => {
    const h = makeHarness();
    h.surfacer.handleDeviceError({ source: 'playback', name: 'NotFoundError', message: '' });
    h.surfacer.noteSamplesPlayed(0);
    h.surfacer.noteSamplesPlayed(120);
    expect(resolvedTargets).toEqual(['audio_output_failed']);
  });
});
