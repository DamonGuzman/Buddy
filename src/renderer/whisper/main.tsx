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
import type {
  AssistantState,
  FilesystemSelection,
  FilesystemTaskView,
  Settings,
  TranscriptEntry,
} from '../../shared/types';
import { saveWhisperSettings, WHISPER_SETTINGS_SAVE_ERROR } from './settings-save';
import './whisper.css';

/** Turns kept in the reply stack (the session journal is the full record). */
const STACK_LIMIT = 6;

function upsert(entries: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const i = entries.findIndex((e) => e.id === entry.id);
  const next =
    i >= 0 ? [...entries.slice(0, i), entry, ...entries.slice(i + 1)] : [...entries, entry];
  return next.slice(-STACK_LIMIT);
}

function upsertFilesystemTask(
  tasks: FilesystemTaskView[],
  task: FilesystemTaskView,
): FilesystemTaskView[] {
  const next = tasks.filter((candidate) => candidate.taskId !== task.taskId);
  return [...next, task].sort((left, right) => right.createdAt - left.createdAt);
}

function App(): React.JSX.Element {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [state, setState] = useState<AssistantState>('idle');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [savingVoice, setSavingVoice] = useState(false);
  const [draft, setDraft] = useState('');
  const [folder, setFolder] = useState<FilesystemSelection | null>(null);
  const [filesystemTasks, setFilesystemTasks] = useState<FilesystemTaskView[]>([]);
  const [filesystemError, setFilesystemError] = useState<string | null>(null);
  const [filesystemBusy, setFilesystemBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubs = [
      clicky.onTranscript((entry) => setEntries((prev) => upsert(prev, entry))),
      clicky.onAssistantState(setState),
      clicky.onSettings(setSettings),
      clicky.onShown(() => inputRef.current?.focus()),
      clicky.onFilesystemState(setFilesystemTasks),
      clicky.onFilesystemSelection(setFolder),
    ];
    void clicky.getSettings().then(setSettings);
    void clicky.getAssistantState().then(setState);
    void clicky.getFilesystemState().then(setFilesystemTasks);
    void clicky.getFilesystemSelection().then(setFolder);
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
  const chooseFolder = async (): Promise<void> => {
    if (filesystemBusy) return;
    setFilesystemBusy(true);
    setFilesystemError(null);
    try {
      setFolder(await clicky.selectFilesystemRoot());
    } catch (error) {
      setFilesystemError(messageOf(error));
    } finally {
      setFilesystemBusy(false);
      inputRef.current?.focus();
    }
  };

  const clearFolder = async (): Promise<void> => {
    if (filesystemBusy) return;
    setFilesystemBusy(true);
    setFilesystemError(null);
    try {
      await clicky.clearFilesystemRoot();
      setFolder(null);
    } catch (error) {
      setFilesystemError(messageOf(error));
    } finally {
      setFilesystemBusy(false);
    }
  };

  const mutateFilesystem = async (
    operation: () => Promise<FilesystemTaskView | void>,
  ): Promise<void> => {
    if (filesystemBusy) return;
    setFilesystemBusy(true);
    setFilesystemError(null);
    try {
      const next = await operation();
      if (next) {
        setFilesystemTasks((current) =>
          ['kept', 'undone', 'discarded'].includes(next.status)
            ? current.filter((task) => task.taskId !== next.taskId)
            : upsertFilesystemTask(current, next),
        );
      }
    } catch (error) {
      setFilesystemError(messageOf(error));
    } finally {
      setFilesystemBusy(false);
    }
  };

  const toggleVoice = async (): Promise<void> => {
    if (savingVoice) return;
    setSavingVoice(true);
    const saved = await saveWhisperSettings(clicky.setSettings, { voiceMuted: !voiceMuted });
    setSavingVoice(false);
    if (saved === null) {
      setSettingsError(WHISPER_SETTINGS_SAVE_ERROR);
      return;
    }
    setSettings(saved);
    setSettingsError(null);
  };

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
      {filesystemTasks.length > 0 ? (
        <div className="filesystem-cards">
          {filesystemTasks.map((task) => (
            <FilesystemCard
              key={task.taskId}
              task={task}
              busy={filesystemBusy}
              onCancel={() => void mutateFilesystem(() => clicky.cancelFilesystemTask(task.taskId))}
              onInspect={() =>
                void mutateFilesystem(() => clicky.openFilesystemSafeCopy(task.taskId))
              }
              onDiscard={() =>
                void mutateFilesystem(() => clicky.discardFilesystemTask(task.taskId))
              }
              onUndo={() => void mutateFilesystem(() => clicky.undoFilesystemTask(task.taskId))}
              onKeep={() => void mutateFilesystem(() => clicky.keepFilesystemTask(task.taskId))}
            />
          ))}
        </div>
      ) : null}
      {folder ? (
        <div className="folder-chip">
          <span className="folder-copy">
            <strong>{folder.name}</strong>
            <span>host filesystem · edits auto-apply with undo</span>
          </span>
          <button
            type="button"
            disabled={filesystemBusy}
            onClick={() => void clearFolder()}
            aria-label="remove helper folder"
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="composer">
        <span className="tri" aria-hidden="true" />
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder={noKey ? 'add your key in settings first' : 'whisper to buddy…'}
          disabled={noKey || filesystemBusy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {settingsError ? (
        <div className="settings-error" role="alert">
          {settingsError}
        </div>
      ) : null}
      {filesystemError ? (
        <div className="settings-error" role="alert">
          {filesystemError}
        </div>
      ) : null}
      <div className="foot">
        <button
          type="button"
          className="folder-button"
          disabled={filesystemBusy}
          onClick={() => void chooseFolder()}
        >
          {filesystemBusy ? 'opening…' : folder ? 'change helper folder' : 'work in a folder'}
        </button>
        <button
          type="button"
          className="quiet"
          data-muted={voiceMuted ? '' : undefined}
          disabled={savingVoice}
          aria-busy={savingVoice}
          onClick={() => void toggleVoice()}
        >
          {savingVoice ? 'saving…' : voiceMuted ? 'voice off · text replies' : 'voice on'}
        </button>
      </div>
    </div>
  );
}

interface FilesystemCardProps {
  task: FilesystemTaskView;
  busy: boolean;
  onCancel(): void;
  onInspect(): void;
  onDiscard(): void;
  onUndo(): void;
  onKeep(): void;
}

function FilesystemCard({
  task,
  busy,
  onCancel,
  onInspect,
  onDiscard,
  onUndo,
  onKeep,
}: FilesystemCardProps): React.JSX.Element {
  const working = task.status === 'preparing' || task.status === 'running';
  const label: Record<FilesystemTaskView['status'], string> = {
    preparing: 'starting the host shell…',
    running: 'buddy is working…',
    publishing: 'checking and applying changes…',
    published: 'changes applied · output handed off',
    kept: 'changes kept',
    undoing: 'restoring the original…',
    undone: 'changes undone',
    discarded: 'staged changes discarded',
    failed: 'folder task stopped',
  };
  return (
    <section className="filesystem-card" data-status={task.status}>
      <div className="filesystem-head">
        <span className="filesystem-dot" />
        <span>
          <strong>{label[task.status]}</strong>
          <small>{task.rootName}</small>
        </span>
      </div>
      {working ? (
        <p>this helper runs independently; verified staged edits publish automatically.</p>
      ) : null}
      {task.summary && task.status === 'published' ? <p>{task.summary}</p> : null}
      {task.error ? <p className="filesystem-error">{task.error}</p> : null}
      {task.status === 'failed' ? (
        <p>your folder is unchanged. open the safe copy to inspect whatever the helper staged.</p>
      ) : null}
      {task.status === 'published' && task.changes.length > 0 ? (
        <div className="change-list">
          {task.changes.slice(0, 6).map((change) => (
            <div key={`${change.kind}:${change.path}`}>
              <span data-kind={change.kind}>
                {change.kind === 'created' ? '+' : change.kind === 'deleted' ? '−' : '•'}
              </span>
              <span>{change.path}</span>
            </div>
          ))}
          {task.changes.length > 6 ? <small>and {task.changes.length - 6} more…</small> : null}
        </div>
      ) : null}
      <div className="filesystem-actions">
        {working ? (
          <button type="button" disabled={busy} onClick={onCancel}>
            stop
          </button>
        ) : null}
        {task.status === 'failed' ? (
          <>
            <button type="button" className="primary" disabled={busy} onClick={onInspect}>
              open safe copy
            </button>
            <button type="button" disabled={busy} onClick={onDiscard}>
              discard safe copy
            </button>
          </>
        ) : null}
        {task.status === 'published' ? (
          <>
            <button type="button" disabled={busy} onClick={onUndo}>
              undo
            </button>
            <button type="button" className="primary" disabled={busy} onClick={onKeep}>
              keep changes
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
