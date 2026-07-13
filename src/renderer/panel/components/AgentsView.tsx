import { useEffect, useState } from 'react';
import { Check, CircleStop, Loader2, Search, X } from 'lucide-react';
import { clicky } from '../clicky';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { AgentSummary } from '../../../shared/types';

interface AgentsViewProps {
  agents: AgentSummary[];
  connected: boolean;
  onOpenSettings: () => void;
}

export function AgentsView({ agents, connected, onOpenSettings }: AgentsViewProps): React.JSX.Element {
  const running = agents.filter((agent) => agent.status === 'running' || agent.status === 'queued');
  useEffect(() => {
    for (const agent of agents) if (agent.unseen) void clicky.markAgentSeen(agent.id);
  }, [agents]);

  if (!connected) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full border-dashed bg-card/60 text-center shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <Search className="size-6 text-muted-foreground" />
            <div className="space-y-1.5">
              <p className="text-sm font-medium">agent mode needs your chatgpt sign-in</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                it runs on your chatgpt plan, not your api key. connect it, then say “buddy, agent…”
              </p>
            </div>
            <Button size="sm" className="mt-1 rounded-full" onClick={onOpenSettings}>open settings</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <div className="flex-1">
          <p className="text-sm font-medium">background agents</p>
          <p className="text-[11px] text-muted-foreground">read-only research while you keep going</p>
        </div>
        {running.length > 0 ? (
          <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-[11px]" onClick={() => void clicky.cancelAllAgents()}>
            <CircleStop className="size-3.5" /> stop all
          </Button>
        ) : null}
      </div>
      {agents.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-xs leading-relaxed text-muted-foreground">
          no agents yet — say “buddy, agent” followed by a research task and one will head off in the background.
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-4">
            {agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentSummary }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = agent.status === 'running' || agent.status === 'queued';
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const end = agent.finishedAt ?? now;
  const seconds = Math.max(0, Math.floor((end - agent.createdAt) / 1_000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <Card className="gap-3 py-3 shadow-none">
      <CardHeader className="gap-2 px-3.5">
        <div className="flex items-start gap-2">
          <StatusIcon agent={agent} />
          <CardTitle className="min-w-0 flex-1 text-sm leading-snug font-medium">{agent.task}</CardTitle>
          <StatusBadge status={agent.status} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {active
            ? `step ${agent.step ?? 1}${agent.maxSteps === null ? '' : `/${agent.maxSteps}`}`
            : agent.status.replace('_', ' ')} · {elapsed}
          {agent.sources?.length ? ` · ${agent.sources.length} sources` : ''}
        </p>
      </CardHeader>
      <CardContent className="space-y-2.5 px-3.5">
        {active && agent.steps.length > 0 ? (
          <div className="max-h-24 space-y-1 overflow-y-auto rounded-md bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground">
            {agent.steps.slice(-5).map((step, index) => <p key={`${step.at}-${index}`}>{step.label}</p>)}
          </div>
        ) : null}
        {agent.summary ? <p className="whitespace-pre-wrap text-xs leading-relaxed">{agent.summary}</p> : null}
        {agent.error ? <p className="text-xs leading-relaxed text-destructive">{agent.error}</p> : null}
        {(agent.output || agent.sources?.length) ? (
          <div className="space-y-2">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'hide findings' : 'show full findings'}
            </Button>
            {expanded ? (
              <div className="space-y-2 rounded-md border bg-muted/20 p-2.5 text-[11px] leading-relaxed">
                {agent.output ? <p className="whitespace-pre-wrap">{agent.output}</p> : null}
                {agent.sources?.length ? (
                  <div className="space-y-1 border-t pt-2 text-muted-foreground">
                    <p className="font-medium text-foreground">sources</p>
                    {agent.sources.map((source) => <p key={source} className="break-all">{source}</p>)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {active ? (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" aria-label={`stop agent: ${agent.task}`} className="h-7 text-[11px] text-muted-foreground" onClick={() => void clicky.cancelAgent(agent.id)}>
              <CircleStop className="size-3.5" /> stop
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusIcon({ agent }: { agent: AgentSummary }): React.JSX.Element {
  if (agent.status === 'running' || agent.status === 'queued') return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-clicky" />;
  if (agent.status === 'done') return <Check className="mt-0.5 size-4 shrink-0 text-emerald-400" />;
  return <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

function StatusBadge({ status }: { status: AgentSummary['status'] }): React.JSX.Element {
  const classes = status === 'done'
    ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
    : status === 'failed' || status === 'timed_out'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : status === 'running'
        ? 'border-clicky/40 bg-clicky/10 text-clicky'
        : 'text-muted-foreground';
  return <Badge variant="outline" className={`shrink-0 rounded-full px-2 text-[10px] font-normal ${classes}`}>{status === 'running' ? 'working' : status.replace('_', ' ')}</Badge>;
}
