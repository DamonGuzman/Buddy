import { Triangle } from './Triangle';
import type { AssistantState, SessionStatus } from '../../../shared/types';

const STATE_LABEL: Record<AssistantState, string> = {
  idle: 'resting',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  error: 'uh oh',
};

const SESSION_TITLE: Record<SessionStatus['state'], string> = {
  disconnected: 'session: disconnected',
  connecting: 'session: connecting…',
  ready: 'session: ready',
  error: 'session: error',
};

interface HeaderProps {
  assistantState: AssistantState;
  session: SessionStatus | null;
  settingsOpen: boolean;
  onToggleSettings: () => void;
}

export function Header(props: HeaderProps): React.JSX.Element {
  const { assistantState, session, settingsOpen, onToggleSettings } = props;
  const sessionState = session?.state ?? 'disconnected';
  const sessionTitle =
    sessionState === 'error' && session?.error
      ? `session: ${session.error}`
      : SESSION_TITLE[sessionState];

  return (
    <header className="header">
      <div className="brand">
        <Triangle size={22} />
        <h1 className="brand-name">clicky</h1>
      </div>
      <span className={`state-pill ${assistantState}`}>
        <span className="dot" />
        {STATE_LABEL[assistantState]}
      </span>
      <div className="header-right">
        {session?.usingMockServer ? <span className="mock-badge">mock</span> : null}
        <span className={`session-dot ${sessionState}`} title={sessionTitle} />
        <button
          type="button"
          className={`icon-btn${settingsOpen ? ' active' : ''}`}
          title={settingsOpen ? 'back to chat' : 'settings'}
          onClick={onToggleSettings}
        >
          {settingsOpen ? <BackIcon /> : <GearIcon />}
        </button>
      </div>
    </header>
  );
}

function GearIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56v.18a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.12-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03h-.18a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.12 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56v-.18a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03h.18a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.56 1.03Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BackIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 5l-7 7 7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
