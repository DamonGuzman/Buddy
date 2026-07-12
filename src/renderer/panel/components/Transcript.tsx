import { useEffect, useRef } from 'react';
import { Triangle } from './Triangle';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
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
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-9 text-center">
        <span className="animate-float drop-shadow-[0_6px_14px_rgba(76,141,255,0.35)]">
          <Triangle size={44} />
        </span>
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          hold <Kbd className="mx-0.5 border border-b-2">{hotkeyLabel}</Kbd> and talk —
          i&rsquo;ll look at your screen and point things out
        </p>
        <p className="text-[11.5px] text-muted-foreground/70">
          or type a question below if you&rsquo;re somewhere quiet
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={scrollRef} onViewportScroll={onScroll}>
      <div className="flex flex-col gap-2.5 px-4 pt-3.5 pb-1.5">
        {entries.map((entry) => (
          <TranscriptRow key={entry.id} entry={entry} />
        ))}
      </div>
    </ScrollArea>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }): React.JSX.Element {
  if (entry.role === 'system') {
    return (
      <div className="flex justify-center px-2 py-0.5">
        <span
          className={cn(
            'max-w-[88%] rounded-md border border-dashed px-2.5 py-1 text-center text-xs leading-relaxed text-muted-foreground select-text',
            entry.streaming && 'animate-pulse-soft',
          )}
        >
          {entry.text}
        </span>
      </div>
    );
  }

  if (entry.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            'max-w-[76%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-[13px] leading-normal whitespace-pre-wrap text-primary-foreground select-text [overflow-wrap:anywhere]',
            entry.streaming && 'animate-pulse-soft',
          )}
        >
          {entry.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-end justify-start gap-2">
      <span className="mb-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-clicky/15">
        <Triangle size={14} />
      </span>
      <div
        className={cn(
          'max-w-[76%] rounded-lg rounded-bl-sm border bg-card px-3 py-2 text-[13px] leading-normal whitespace-pre-wrap text-card-foreground select-text [overflow-wrap:anywhere]',
          entry.streaming && 'animate-pulse-soft',
        )}
      >
        {entry.text}
        {entry.streaming ? (
          <span className="animate-caret-blink ml-1 inline-block h-3 w-[7px] rounded-[2px] bg-clicky align-[-2px]" />
        ) : null}
      </div>
    </div>
  );
}
