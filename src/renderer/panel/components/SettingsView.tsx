import { useEffect, useState } from 'react';
import { clicky } from '../clicky';
import type { MicDevice, ModelId, Settings } from '../../../shared/types';

const VOICES = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
] as const;

const MODELS: { id: ModelId; label: string }[] = [
  { id: 'gpt-realtime-2.1-mini', label: 'gpt-realtime-2.1-mini (default)' },
  { id: 'gpt-realtime-2.1', label: 'gpt-realtime-2.1' },
];

interface SettingsViewProps {
  settings: Settings;
  micDevices: MicDevice[];
  micError: string | null;
}

/** Settings: API key, model, voice, captions, mic, hotkey, agent-mode teaser. */
export function SettingsView({ settings, micDevices, micError }: SettingsViewProps): React.JSX.Element {
  const [keyDraft, setKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(t);
  }, [justSaved]);

  const saveKey = async (): Promise<void> => {
    const value = keyDraft.trim();
    if (!value || savingKey) return;
    setSavingKey(true);
    try {
      await clicky.setSettings({ apiKey: value });
      setKeyDraft('');
      setJustSaved(true);
    } finally {
      setSavingKey(false);
    }
  };

  const patch = (p: Parameters<typeof clicky.setSettings>[0]): void => {
    void clicky.setSettings(p);
  };

  return (
    <div className="settings">
      <div className="card">
        <h3>openai</h3>
        <div className="key-status">
          {settings.apiKeyPresent ? (
            <>
              <span className="saved">key saved ✓</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn ghost" onClick={() => patch({ apiKey: null })}>
                clear
              </button>
            </>
          ) : (
            <span className="none">no key yet — clicky can&rsquo;t talk without one</span>
          )}
        </div>
        <div className="keyrow">
          <input
            type="password"
            value={keyDraft}
            placeholder={settings.apiKeyPresent ? 'paste a new key to replace…' : 'sk-…'}
            autoComplete="off"
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey();
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={keyDraft.trim().length === 0 || savingKey}
            onClick={() => void saveKey()}
          >
            {justSaved ? 'saved ✓' : 'save'}
          </button>
        </div>
        <p className="hint">stored encrypted on this device. never shown again, never synced.</p>
        <div className="field">
          <label htmlFor="model">model</label>
          <select
            id="model"
            value={settings.model}
            onChange={(e) => patch({ model: e.target.value as ModelId })}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <h3>voice &amp; captions</h3>
        <div className="field">
          <label htmlFor="voice">voice</label>
          <select
            id="voice"
            value={settings.voice}
            onChange={(e) => patch({ voice: e.target.value })}
          >
            {VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="captions">captions on screen</label>
          <span className="switch">
            <input
              id="captions"
              type="checkbox"
              checked={settings.captionsEnabled}
              onChange={(e) => patch({ captionsEnabled: e.target.checked })}
            />
            <span className="track" />
            <span className="thumb" />
          </span>
        </div>
      </div>

      <div className="card">
        <h3>microphone</h3>
        <div className="field">
          <label htmlFor="mic">input device</label>
          <select
            id="mic"
            value={settings.micDeviceId}
            onChange={(e) => void clicky.selectMic(e.target.value)}
          >
            <option value="">system default</option>
            {micDevices
              .filter((d) => d.deviceId !== '' && d.deviceId !== 'default')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'microphone'}
                </option>
              ))}
          </select>
        </div>
        {micError ? (
          <p className="hint">
            couldn&rsquo;t reach a microphone ({micError.toLowerCase()}) — you can still type below.
          </p>
        ) : null}
        <div className="field">
          <label>push to talk</label>
          <span className="hotkey-chip">{settings.hotkeyLabel}</span>
        </div>
        <p className="hint">hold both keys and talk; let go to send. fixed for now.</p>
      </div>

      <div className="coming-soon">
        <span>🪄</span>
        <span>agent mode — coming soon ✨</span>
      </div>
    </div>
  );
}
