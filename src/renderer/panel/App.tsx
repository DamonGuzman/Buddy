/**
 * Panel UI (M1 minimal): app name, assistant/session state, disabled text
 * input. Transcript list, settings view, and the live text pipeline land in
 * the panel milestone.
 */

import { useEffect, useState } from 'react';
import { clicky } from './clicky';
import type { AssistantState, SessionStatus, Settings } from '../../shared/types';

const STATE_LABEL: Record<AssistantState, string> = {
  idle: 'resting',
  listening: 'listening…',
  thinking: 'thinking…',
  speaking: 'speaking…',
  error: 'something went wrong',
};

export function App(): React.JSX.Element {
  const [assistantState, setAssistantState] = useState<AssistantState>('idle');
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void clicky.getSettings().then(setSettings);
    const offState = clicky.onAssistantState(setAssistantState);
    const offSession = clicky.onSessionStatus(setSession);
    const offSettings = clicky.onSettings(setSettings);
    return () => {
      offState();
      offSession();
      offSettings();
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: '9px solid transparent',
            borderRight: '9px solid transparent',
            borderBottom: '16px solid #3b82f6',
          }}
        />
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>clicky</h1>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8' }}>
          {STATE_LABEL[assistantState]}
        </span>
      </header>

      <div style={{ fontSize: 12, color: '#64748b', marginTop: 12, lineHeight: 1.6 }}>
        <div>
          hold <strong style={{ color: '#e2e8f0' }}>{settings?.hotkeyLabel ?? 'Ctrl+Alt'}</strong>{' '}
          and talk
        </div>
        <div>
          session: {session ? session.state : 'disconnected'}
          {session?.usingMockServer ? ' (mock)' : ''}
        </div>
        <div>api key: {settings ? (settings.apiKeyPresent ? 'set' : 'not set') : '…'}</div>
      </div>

      {/* transcript area (panel milestone) */}
      <div
        style={{
          flex: 1,
          marginTop: 16,
          borderRadius: 8,
          background: '#1e293b',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#475569',
          fontSize: 13,
        }}
      >
        transcript will appear here
      </div>

      <input
        type="text"
        disabled
        placeholder="type a question (coming soon)"
        style={{
          marginTop: 12,
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid #334155',
          background: '#1e293b',
          color: '#e2e8f0',
          fontSize: 13,
          outline: 'none',
        }}
      />
    </div>
  );
}
