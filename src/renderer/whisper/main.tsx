/**
 * Whisper renderer: buddy's little text composer. A short reply stack (the
 * last few conversation turns, mirrored from main) above a one-line composer,
 * in the caption bubble's visual language. Enter sends through the same
 * pipeline as the panel composer; esc tucks the window away; the foot toggle
 * flips quiet mode (voiceMuted — text-only answers for silent environments).
 *
 * The window is summoned by a hotkey tap or a buddy click (main focuses it);
 * 'whisper:shown' re-focuses the input on every summon.
 */

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clicky } from './clicky';
import type { AssistantState, Settings, TranscriptEntry } from '../../shared/types';
import './whisper.css';

/** Turns kept in the reply stack (the session journal is the full record). */
const STACK_LIMIT = 6;

function upsert(entries: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const i = entries.findIndex((e) => e.id === entry.id);
  const next = i >= 0 ? [...entries.slice(0, i), entry, ...entries.slice(i + 1)] : [...entries, entry];
  return next.slice(-STACK_LIMIT);
}

function App(): React.JSX.Element {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [state, setState] = useState<AssistantState>('idle');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubs = [
      clicky.onTranscript((entry) => setEntries((prev) => upsert(prev, entry))),
      clicky.onAssistantState(setState),
      clicky.onSettings(setSettings),
      clicky.onShown(() => inputRef.current?.focus()),
    ];
    void clicky.getSettings().then(setSettings);
    void clicky.getAssistantState().then(setState);
    inputRef.current?.focus();
    return () => unsubs.forEach((u) => u());
  }, []);

  // Keep the newest turn in view as replies stream in.
  useEffect(() => {
    const stack = stackRef.current;
    if (stack) stack.scrollTop = stack.scrollHeight;
  }, [entries]);

  // Auto-grow the composer with the draft (up to the CSS max-height); the
  // reply stack flexes to absorb the difference, the window stays fixed.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 72)}px`;
  }, [draft]);

  const send = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft('');
    void clicky.askText(text);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clicky.hide();
    }
  };

  const voiceMuted = settings?.voiceMuted ?? false;
  const noKey = settings !== null && !settings.apiKeyPresent;

  return (
    <div className="whisper" data-state={state}>
      <div className="stack" ref={stackRef}>
        {entries.length === 0 && (
          <div className="empty">
            type to buddy — it can still see your screens and point while it answers
          </div>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="turn" data-role={entry.role}>
            {entry.text}
            {entry.streaming ? <span className="caret" /> : null}
          </div>
        ))}
      </div>
      <div className="composer">
        <span className="tri" aria-hidden="true" />
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder={noKey ? 'add your key in settings first' : 'whisper to buddy…'}
          disabled={noKey}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="foot">
        <span className="hint">enter to send · esc to tuck away</span>
        <button
          type="button"
          className="quiet"
          data-muted={voiceMuted ? '' : undefined}
          onClick={() => void clicky.setSettings({ voiceMuted: !voiceMuted })}
        >
          {voiceMuted ? 'voice off · text replies' : 'voice on'}
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
