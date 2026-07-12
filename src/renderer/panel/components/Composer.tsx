import { useState } from 'react';

interface ComposerProps {
  disabled: boolean;
  disabledReason: string | undefined;
  /** True while a turn is pending ('thinking') — blocks double-submit. */
  busy?: boolean;
  onSend: (text: string) => void;
}

/** Text-input fallback: typed question → same pipeline as voice. */
export function Composer({
  disabled,
  disabledReason,
  busy = false,
  onSend,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');

  const send = (): void => {
    const trimmed = text.trim();
    if (!trimmed || disabled || busy) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="composer" title={disabled ? disabledReason : undefined}>
      {busy && <span className="composer-hint">clicky is thinking…</span>}
      <input
        type="text"
        value={text}
        placeholder="ask clicky anything…"
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button
        type="button"
        className="send"
        disabled={disabled || busy || text.trim().length === 0}
        title={disabled ? disabledReason : busy ? 'clicky is thinking…' : 'send'}
        onClick={send}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4.5 12h14m0 0-5.5-5.5M18.5 12 13 17.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
