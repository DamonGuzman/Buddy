import { useEffect, useRef } from 'react';
import { Triangle } from './Triangle';
import type { TranscriptEntry } from '../../../shared/types';

const STICK_THRESHOLD_PX = 48;

interface TranscriptProps {
  entries: TranscriptEntry[];
  hotkeyLabel: string;
}

/**
 * Scrolling transcript. Auto-follows the newest entry unless the user has
 * scrolled up to read history (re-sticks when they return to the bottom).
 */
export function Transcript({ entries, hotkeyLabel }: TranscriptProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="hero">
        <span className="buddy">
          <Triangle size={44} />
        </span>
        <p>
          hold <span className="kbd">{hotkeyLabel}</span> and talk — i&rsquo;ll look at your screen
          and point things out
        </p>
        <p className="sub">or type a question below if you&rsquo;re somewhere quiet</p>
      </div>
    );
  }

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      {entries.map((entry) => (
        <div key={entry.id} className={`row ${entry.role}`}>
          {entry.role === 'assistant' ? (
            <span className="avatar">
              <Triangle size={14} />
            </span>
          ) : null}
          <div className={`bubble${entry.streaming ? ' streaming' : ''}`}>
            {entry.text}
            {entry.streaming ? <span className="caret" /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
