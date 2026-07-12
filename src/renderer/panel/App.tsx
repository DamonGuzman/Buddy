/**
 * Panel app: header (brand + assistant/session state), transcript with
 * text-input fallback, and a gear-toggled settings view. Also hosts the two
 * audio engines — mic capture (push-to-talk, works while the window is
 * hidden) and model-voice playback — because this renderer is kept alive by
 * main from app start.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clicky } from './clicky';
import { micCapture } from './audio/capture';
import { audioPlayer } from './audio/playback';
import { Header } from './components/Header';
import { Transcript } from './components/Transcript';
import { Composer } from './components/Composer';
import { SettingsView } from './components/SettingsView';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type {
  AssistantState,
  MicDevice,
  RuntimeFlags,
  SessionStatus,
  Settings,
  TranscriptEntry,
} from '../../shared/types';

let prewarmStarted = false; // once per renderer, even under StrictMode

/** Keep the renderer transcript bounded, mirroring main's 50-entry ring. */
const MAX_TRANSCRIPT_ENTRIES = 50;

async function enumerateMics(): Promise<MicDevice[]> {
  const seen = new Map<string, MicDevice>();
  try {
    const local = await navigator.mediaDevices.enumerateDevices();
    for (const d of local) {
      if (d.kind !== 'audioinput') continue;
      seen.set(d.deviceId, { deviceId: d.deviceId, label: d.label });
    }
  } catch (err) {
    console.warn('[mic] enumerateDevices failed:', err);
  }
  try {
    for (const d of await clicky.listMics()) {
      if (!seen.has(d.deviceId)) seen.set(d.deviceId, d);
    }
  } catch {
    /* main-side list is best-effort */
  }
  return [...seen.values()];
}

export function App(): React.JSX.Element {
  const [assistantState, setAssistantState] = useState<AssistantState>('idle');
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [micDevices, setMicDevices] = useState<MicDevice[]>([]);
  const [micError, setMicError] = useState<string | null>(null);
  // M11 addition (orchestrator-approved): hookAlive + dev flags from main.
  const [runtime, setRuntime] = useState<RuntimeFlags | null>(null);

  // Capture needs the *current* mic preference without resubscribing.
  const micDeviceIdRef = useRef('');
  micDeviceIdRef.current = settings?.micDeviceId ?? '';

  const upsertEntry = useCallback((entry: TranscriptEntry): void => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id);
      if (idx === -1) {
        const appended = [...prev, entry];
        // Unbounded growth leak fix: drop the oldest entries past the ring size.
        return appended.length > MAX_TRANSCRIPT_ENTRIES
          ? appended.slice(appended.length - MAX_TRANSCRIPT_ENTRIES)
          : appended;
      }
      const next = prev.slice();
      next[idx] = entry;
      return next;
    });
  }, []);

  // ---- subscriptions + boot ----------------------------------------------
  useEffect(() => {
    void clicky.getSettings().then(setSettings);
    // M11: tolerate an older preload (crash-recreate races) — best-effort.
    try {
      void clicky.getRuntime().then(setRuntime);
    } catch {
      /* runtime flags are progressive enhancement */
    }

    const offs = [
      clicky.onAssistantState(setAssistantState),
      clicky.onSessionStatus(setSession),
      clicky.onSettings(setSettings),
      clicky.onRuntime(setRuntime),
      clicky.onTranscript(upsertEntry),
      clicky.onAudioOutput((delta) => audioPlayer.enqueue(delta)),
      clicky.onPlayback(({ command }) => audioPlayer.control(command)),
      clicky.onCaptureCommand(({ command }) => {
        if (command === 'start') {
          void micCapture.start(micDeviceIdRef.current).then(() => {
            setMicError(micCapture.error());
          });
        } else {
          micCapture.stop();
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [upsertEntry]);

  // ---- mic permission pre-warm + device list ------------------------------
  useEffect(() => {
    const refresh = (): void => {
      void enumerateMics().then(setMicDevices);
    };
    if (!prewarmStarted) {
      prewarmStarted = true;
      void micCapture.prewarm().then((ok) => {
        setMicError(ok ? null : micCapture.error());
        refresh();
      });
    } else {
      refresh();
    }
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, []);

  // ---- dev hooks (test tone, transcript seed, capture stats) --------------
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const dev = {
      playTestTone: (seconds?: number) => audioPlayer.playTestTone(seconds),
      /**
       * Playback QA: returns drain-event timestamps (ms from start).
       * Expected ≈ [2000, ~3100, ~4100]:
       *  - 2s tone enqueued all at once drains at ~2000ms → contiguous,
       *    gapless scheduling (any inter-chunk gap would inflate this).
       *  - flush during a 3s tone drains immediately (~3100ms mark).
       *  - re-enqueue under the flushed itemId is dropped entirely; a fresh
       *    1s item plays to ~4100ms. If stale-drop failed → ~8100ms.
       */
      playbackQa: async (): Promise<number[]> => {
        const marks: number[] = [];
        const t0 = performance.now();
        audioPlayer.onDrained(() => marks.push(Math.round(performance.now() - t0)));
        audioPlayer.enqueueTone('qa-1', 2);
        await sleep(2600);
        audioPlayer.enqueueTone('qa-2', 3);
        await sleep(500);
        audioPlayer.control('flush');
        audioPlayer.enqueueTone('qa-2', 5); // superseded item → must be dropped
        audioPlayer.enqueueTone('qa-3', 1);
        await sleep(2200);
        return marks;
      },
      seedTranscript: () => SEED_ENTRIES.forEach(upsertEntry),
      seedEntry: (entry: TranscriptEntry) => upsertEntry(entry),
      clearTranscript: () => setEntries([]),
      openSettings: () => setView('settings'),
      openChat: () => setView('chat'),
      // Visual QA (dev-only): drive main-owned state locally for screenshots.
      setAssistantState: (state: AssistantState) => setAssistantState(state),
      setSession: (status: SessionStatus | null) => setSession(status),
      setSettingsLocal: (s: Settings | null) => setSettings(s),
      scrollSettings: (px: number) => {
        document
          .querySelector('[data-settings-scroll] [data-slot="scroll-area-viewport"]')
          ?.scrollBy({ top: px });
      },
      startCapture: () => void micCapture.start(micDeviceIdRef.current),
      captureTone: () => void micCapture.startWithTestTone(),
      stopCapture: () => micCapture.stop(),
      captureStats: () => micCapture.stats(),
    };
    (window as unknown as Record<string, unknown>)['__clickyDev'] = dev;
    return () => {
      delete (window as unknown as Record<string, unknown>)['__clickyDev'];
    };
  }, [upsertEntry]);

  const noKey = settings !== null && !settings.apiKeyPresent;
  const composerDisabled = session?.state === 'error' && noKey;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <Header
        assistantState={assistantState}
        session={session}
        devFlags={runtime?.devFlags ?? []}
        settingsOpen={view === 'settings'}
        onToggleSettings={() => setView((v) => (v === 'chat' ? 'settings' : 'chat'))}
      />

      {view === 'chat' && noKey ? (
        <Card className="mx-4 mt-3 flex-row items-center gap-2.5 rounded-lg border-clicky/30 bg-clicky/10 px-3.5 py-2.5 shadow-none">
          <span className="flex-1 text-xs leading-relaxed">
            add your openai key to give clicky a voice
          </span>
          <Button type="button" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={() => setView('settings')}>
            open settings
          </Button>
        </Card>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col">
        {view === 'settings' ? (
          settings ? (
            <SettingsView settings={settings} micDevices={micDevices} micError={micError} />
          ) : null
        ) : (
          <>
            <Transcript
              entries={entries}
              hotkeyLabel={settings?.hotkeyLabel ?? 'Ctrl+Alt (left alt)'}
              hookAlive={runtime?.hookAlive ?? true}
            />
            <Composer
              disabled={composerDisabled}
              disabledReason="add your openai key in settings so clicky can connect"
              busy={assistantState === 'thinking'}
              onSend={(text) => void clicky.askText(text)}
            />
          </>
        )}
      </main>
    </div>
  );
}

/** Dev-only fake conversation for visual QA (window.__clickyDev.seedTranscript). */
const SEED_ENTRIES: TranscriptEntry[] = [
  {
    id: 'seed-1',
    role: 'user',
    text: 'how do i make this spreadsheet column fit its text?',
    streaming: false,
    timestamp: Date.now() - 60_000,
  },
  {
    id: 'seed-2',
    role: 'assistant',
    text: "see the line between the C and D column headers? double-click it and the column snaps to fit. i'm pointing at it now.",
    streaming: false,
    timestamp: Date.now() - 55_000,
  },
  {
    id: 'seed-3',
    role: 'user',
    text: 'nice. can i do all columns at once?',
    streaming: false,
    timestamp: Date.now() - 20_000,
  },
  {
    id: 'seed-4',
    role: 'assistant',
    text: 'yep — click the little triangle at the top-left corner to select everything, then double-click any header divider. every column',
    streaming: true,
    timestamp: Date.now() - 2_000,
  },
];
