import { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

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

  const sendHint = disabled ? disabledReason : busy ? 'buddy is thinking…' : 'send';

  return (
    <div
      className="relative flex gap-2 border-t px-4 pt-3 pb-3.5"
      title={disabled ? disabledReason : undefined}
    >
      {busy && (
        <span className="animate-hint-in pointer-events-none absolute -top-[22px] left-4 rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          buddy is thinking…
        </span>
      )}
      <Input
        type="text"
        value={text}
        placeholder="ask buddy anything…"
        disabled={disabled}
        className="h-9 rounded-full px-3.5 text-[13px]"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper: disabled buttons swallow pointer events, the hint must survive */}
          <span title={sendHint}>
            <Button
              type="button"
              size="icon"
              className="size-9 rounded-full"
              disabled={disabled || busy || text.trim().length === 0}
              onClick={send}
            >
              <ArrowUp className="size-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{sendHint}</TooltipContent>
      </Tooltip>
    </div>
  );
}
