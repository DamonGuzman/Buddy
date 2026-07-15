import { Triangle } from './Triangle';
import { STATUS_TINT } from './status-tint';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { AssistantState, SessionStatus } from '../../../shared/types';

const STATE_LABEL: Record<AssistantState, string> = {
  idle: 'resting',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  error: 'uh oh',
};

/** Subtle per-state tint on the assistant-state badge (dark zinc base). */
const STATE_BADGE: Record<AssistantState, string> = {
  idle: 'border-border text-muted-foreground',
  listening: STATUS_TINT.accent,
  thinking: STATUS_TINT.warning,
  speaking: STATUS_TINT.positive,
  error: STATUS_TINT.danger,
};

const STATE_DOT: Record<AssistantState, string> = {
  idle: 'bg-muted-foreground/60',
  listening: 'bg-clicky animate-dot-pulse',
  thinking: 'bg-amber-400 animate-dot-pulse',
  speaking: 'bg-emerald-400 animate-dot-bounce',
  error: 'bg-destructive',
};

const SESSION_TITLE: Record<SessionStatus['state'], string> = {
  disconnected: 'session: disconnected',
  connecting: 'session: connecting…',
  ready: 'session: ready',
  error: 'session: error',
};

const SESSION_DOT: Record<SessionStatus['state'], string> = {
  disconnected: 'bg-muted-foreground/50',
  connecting: 'bg-amber-400 animate-dot-pulse',
  ready: 'bg-emerald-400',
  error: 'bg-destructive',
};

interface HeaderProps {
  assistantState: AssistantState;
  session: SessionStatus | null;
  /** M11: CLICKY_* dev/QA flags set for this run (besides CLICKY_DEBUG). */
  devFlags?: string[];
}

/** M21: settings-window header — title, live status, session dot. The old
 *  panel's view switcher and agents button retired with the panel. */
export function Header(props: HeaderProps): React.JSX.Element {
  const { assistantState, session, devFlags = [] } = props;
  const sessionState = session?.state ?? 'disconnected';
  const sessionTitle =
    sessionState === 'error' && session?.error
      ? `session: ${session.error}`
      : SESSION_TITLE[sessionState];

  return (
    <header className="flex items-center gap-2 border-b px-4 pt-3.5 pb-3 [-webkit-app-region:drag]">
      <div className="flex items-center gap-2">
        <Triangle size={22} />
        <h1 className="text-[17px] leading-none font-semibold tracking-tight">buddy settings</h1>
      </div>

      <Badge
        variant="outline"
        className={cn('ml-1 gap-1.5 rounded-full px-2.5 font-normal', STATE_BADGE[assistantState])}
      >
        <span className={cn('size-1.5 rounded-full', STATE_DOT[assistantState])} />
        {STATE_LABEL[assistantState]}
      </Badge>

      <div className="ml-auto flex items-center gap-2 [-webkit-app-region:no-drag]">
        {session?.usingMockServer ? (
          <Badge
            variant="outline"
            className={cn('rounded-full px-2 text-[10px] tracking-wide', STATUS_TINT.warning)}
          >
            mock
          </Badge>
        ) : null}
        {/* M11: generic dev-flags chip — any CLICKY_* flag besides CLICKY_DEBUG.
            Mapped onto the shadcn Badge; full flag names live in the tooltip. */}
        {devFlags.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn('rounded-full px-2 text-[10px] tracking-wide', STATUS_TINT.dev)}
              >
                dev:{devFlags.length}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {devFlags.map((f) => `CLICKY_${f.toUpperCase()}`).join(', ')}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={sessionTitle}
              className={cn('size-2 shrink-0 rounded-full', SESSION_DOT[sessionState])}
            />
          </TooltipTrigger>
          <TooltipContent side="bottom">{sessionTitle}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
