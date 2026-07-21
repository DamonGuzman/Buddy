import { useState } from 'react';
import { clicky } from '../clicky';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PermissionAction, PermissionHealth, PermissionKey } from '../../../shared/types';

const ROWS: Array<{ key: PermissionKey; label: string; purpose: string }> = [
  { key: 'microphone', label: 'microphone', purpose: 'hear push-to-talk' },
  { key: 'accessibility', label: 'accessibility', purpose: 'detect the hotkey' },
  { key: 'inputMonitoring', label: 'input monitoring', purpose: 'read global key presses' },
  { key: 'screen', label: 'screen recording', purpose: 'see what you ask about' },
];

interface PermissionCardProps {
  health: PermissionHealth;
  onHealth: (health: PermissionHealth) => void;
}

export function PermissionCard({ health, onHealth }: PermissionCardProps): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const run = async (key: string, action: PermissionAction): Promise<void> => {
    if (busy) return;
    setBusy(key);
    setFeedback(null);
    try {
      const result = await clicky.permissionAction(action);
      onHealth(result.health);
      setFeedback({ ok: result.ok, message: result.message });
      if (action.type === 'reset-grants' && result.ok) setConfirmReset(false);
    } catch (err) {
      setFeedback({
        ok: false,
        message:
          `Buddy couldn't run that repair (${err instanceof Error ? err.message : String(err)}). ` +
          'Open System Settings → Privacy & Security manually, or restart Buddy.',
      });
    } finally {
      setBusy(null);
    }
  };

  const ready = health.nextPermission === null && health.hotkeyAlive;

  return (
    <Card className="gap-3 rounded-lg py-3.5 shadow-none" data-permission-card>
      <CardHeader className="flex-row items-center gap-2 px-3.5">
        <CardTitle className="flex-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
          permissions
        </CardTitle>
        <Badge
          variant="outline"
          className={
            ready
              ? 'rounded-full bg-emerald-400/10 font-medium text-emerald-300'
              : 'rounded-full bg-amber-400/10 font-medium text-amber-300'
          }
        >
          {ready ? 'all working ✓' : health.restartRecommended ? 'restart needed' : 'action needed'}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 px-3.5">
        {ROWS.map((row) => {
          const state = health.grants[row.key];
          const granted = state === 'granted';
          return (
            <div
              key={row.key}
              className="flex min-h-9 items-center gap-2 pb-2 last:pb-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-xs text-foreground">{row.label}</span>
                <span className="text-[10px] text-muted-foreground/70">{row.purpose}</span>
              </div>
              {granted ? (
                <span className="text-[11px] text-emerald-300">allowed ✓</span>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={busy !== null}
                  onClick={() => void run(`open-${row.key}`, { type: 'open', permission: row.key })}
                >
                  {busy === `open-${row.key}`
                    ? 'opening…'
                    : state === 'not-determined'
                      ? 'allow'
                      : 'fix'}
                </Button>
              )}
            </div>
          );
        })}

        <div className="rounded-md bg-muted/45 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {health.hotkeyAlive ? (
            'push-to-talk is live.'
          ) : health.restartRecommended ? (
            <>
              the toggles look allowed, but this process still cannot grab the keys. try the live
              retry, then restart. if Settings already showed Buddy as allowed, remove the old entry
              and add the current app again.
            </>
          ) : (
            'push-to-talk is offline until accessibility and input monitoring are allowed. typing still works.'
          )}
        </div>

        {!health.hotkeyAlive ? (
          <p className="text-[10.5px] leading-relaxed text-muted-foreground/75">
            already looks on in System Settings? macOS may be showing an older Buddy build. use
            <span className="text-foreground"> reset stale grants</span> for a guided clean start,
            or show the current app for manual remove/re-add.
          </p>
        ) : null}

        {feedback ? (
          <p
            role="status"
            className={`text-[11px] leading-relaxed ${feedback.ok ? 'text-emerald-300' : 'text-amber-300'}`}
          >
            {feedback.message}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={busy !== null}
            onClick={() => void run('recheck', { type: 'recheck' })}
          >
            {busy === 'recheck' ? 'checking…' : 'check again'}
          </Button>
          {!health.hotkeyAlive &&
          health.grants.accessibility === 'granted' &&
          health.grants.inputMonitoring === 'granted' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={busy !== null}
              onClick={() => void run('retry', { type: 'retry-hotkey' })}
            >
              {busy === 'retry' ? 'retrying…' : 'retry hotkey'}
            </Button>
          ) : null}
          {health.restartRecommended ? (
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={busy !== null}
              onClick={() => void run('restart', { type: 'restart' })}
            >
              restart Buddy
            </Button>
          ) : null}
          {!health.hotkeyAlive ? (
            <>
              <Button
                type="button"
                variant={confirmReset ? 'destructive' : 'outline'}
                size="sm"
                className="h-7 text-xs"
                disabled={busy !== null}
                onClick={() => {
                  if (!confirmReset) {
                    setConfirmReset(true);
                    setFeedback({
                      ok: false,
                      message:
                        'This clears only Buddy’s saved privacy choices so macOS can ask again. Click confirm reset to continue.',
                    });
                    return;
                  }
                  void run('reset', { type: 'reset-grants' });
                }}
              >
                {busy === 'reset'
                  ? 'resetting…'
                  : confirmReset
                    ? 'confirm reset'
                    : 'reset stale grants'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                disabled={busy !== null}
                onClick={() => void run('reveal', { type: 'reveal-app' })}
              >
                show current app
              </Button>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
