import { ArrowLeft, Bot, Settings } from 'lucide-react';
import { Triangle } from './Triangle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  listening: 'border-clicky/40 bg-clicky/10 text-clicky',
  thinking: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  speaking: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
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
  view: 'chat' | 'agents' | 'settings';
  agentCount: number;
  onView: (view: 'chat' | 'agents' | 'settings') => void;
}

export function Header(props: HeaderProps): React.JSX.Element {
  const { assistantState, session, devFlags = [], view, agentCount, onView } = props;
  const sessionState = session?.state ?? 'disconnected';
  const sessionTitle =
    sessionState === 'error' && session?.error
      ? `session: ${session.error}`
      : SESSION_TITLE[sessionState];

  return (
    <header className="flex items-center gap-2 border-b px-4 pt-3.5 pb-3 [-webkit-app-region:drag]">
      <div className="flex items-center gap-2">
        <Triangle size={22} />
        <h1 className="text-[17px] leading-none font-semibold tracking-tight">buddy</h1>
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
            className="rounded-full border-amber-400/40 bg-amber-400/10 px-2 text-[10px] tracking-wide text-amber-300"
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
                className="rounded-full border-violet-400/40 bg-violet-400/10 px-2 text-[10px] tracking-wide text-violet-300"
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
        {view === 'chat' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="agents"
                className="relative size-7 text-muted-foreground"
                onClick={() => onView('agents')}
              >
                <Bot className="size-4" />
                {agentCount > 0 ? (
                  <span className="absolute -top-1 -right-1 grid min-w-4 place-items-center rounded-full bg-clicky px-1 text-[9px] leading-4 text-primary-foreground">
                    {agentCount}
                  </span>
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">agents</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={view !== 'chat' ? 'back to chat' : 'settings'}
              className={cn(
                'size-7 text-muted-foreground',
                view !== 'chat' && 'bg-accent text-accent-foreground',
              )}
              onClick={() => onView(view === 'chat' ? 'settings' : 'chat')}
            >
              {view !== 'chat' ? <ArrowLeft className="size-4" /> : <Settings className="size-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {view !== 'chat' ? 'back to chat' : 'settings'}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
