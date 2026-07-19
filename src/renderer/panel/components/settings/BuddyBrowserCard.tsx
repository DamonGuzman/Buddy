import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, ShieldCheck, Trash2 } from 'lucide-react';
import { clicky } from '../../clicky';
import { approvalGrantLabel, approvalGrantUsage, sortApprovalGrants } from '../../computer-use-ui';
import { SettingsCard } from './SettingsCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ApprovalGrant, EnrolledSite } from '../../../../shared/types';

interface BuddyBrowserCardProps {
  grantsRevision: number;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; grants: ApprovalGrant[]; sites: EnrolledSite[] }
  | { kind: 'error'; message: string };

/** Settings for the deliberately separate, persistent browser profile used by helper buddies. */
export function BuddyBrowserCard({ grantsRevision }: BuddyBrowserCardProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [enrollmentUrl, setEnrollmentUrl] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const [grants, sites] = await Promise.all([clicky.listGrants(), clicky.listEnrolledSites()]);
      setState({ kind: 'ready', grants: sortApprovalGrants(grants), sites });
    } catch {
      setState({
        kind: 'error',
        message: "buddy couldn't read its browser permissions. restart buddy and try again.",
      });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [grantsRevision, load]);

  useEffect(() => {
    const refreshWhenShown = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', refreshWhenShown);
    document.addEventListener('visibilitychange', refreshWhenShown);
    return () => {
      window.removeEventListener('focus', refreshWhenShown);
      document.removeEventListener('visibilitychange', refreshWhenShown);
    };
  }, [load]);

  const run = async (
    key: string,
    action: () => Promise<void>,
    success: string,
  ): Promise<boolean> => {
    if (busy !== null) return false;
    setBusy(key);
    setMessage(null);
    try {
      await action();
      await load();
      setMessage(success);
      return true;
    } catch {
      setMessage("buddy couldn't finish that change. nothing was cleared — please try again.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const openEnrollment = async (): Promise<void> => {
    if (busy !== null) return;
    const url = enrollmentUrl.trim();
    if (url === '') {
      setMessage('enter the site you want buddy to open.');
      return;
    }
    setBusy('enroll');
    setMessage(null);
    try {
      await clicky.openBuddyBrowserEnrollment(url);
      setMessage(
        "buddy's browser is open. sign in to the sites you want helper buddies to use, then close it.",
      );
    } catch {
      setMessage("buddy couldn't open its browser. please try again.");
    } finally {
      setBusy(null);
    }
  };

  const grants = state.kind === 'ready' ? state.grants : [];
  const sites = state.kind === 'ready' ? state.sites : [];

  return (
    <SettingsCard title="buddy's browser">
      <p className="text-[11px] leading-relaxed text-muted-foreground/85">
        helper buddies use their own browser profile, separate from your everyday browser. only sign
        in to accounts you want buddy to act in.
      </p>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void openEnrollment();
        }}
      >
        <Label
          htmlFor="buddy-browser-url"
          className="text-[11px] font-normal text-muted-foreground"
        >
          site to open
        </Label>
        <div className="flex gap-2">
          <Input
            id="buddy-browser-url"
            type="url"
            inputMode="url"
            placeholder="https://linear.app"
            value={enrollmentUrl}
            disabled={busy !== null}
            onChange={(event) => setEnrollmentUrl(event.target.value)}
            className="h-8 min-w-0 text-xs"
          />
          <Button type="submit" size="sm" disabled={busy !== null || enrollmentUrl.trim() === ''}>
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {busy === 'enroll' ? 'opening…' : 'open'}
          </Button>
        </div>
      </form>

      <div className="border-t pt-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/90">
          <ShieldCheck className="size-3.5 text-emerald-400" aria-hidden="true" />
          signed-in sites
        </div>
        {state.kind === 'loading' ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">checking…</p>
        ) : state.kind === 'error' ? (
          <p role="alert" className="mt-1.5 text-[11px] leading-relaxed text-destructive">
            {state.message}
          </p>
        ) : sites.length === 0 ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/75">
            no sites enrolled yet
          </p>
        ) : (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {sites.map((site) => (
              <div
                key={site.domain}
                className="flex items-center gap-2 rounded-md border px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[11px]">{site.domain}</span>
                <Badge variant="outline" className="rounded-full text-[9px] font-normal">
                  {site.cookieCount} {site.cookieCount === 1 ? 'session' : 'sessions'}
                </Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[10px] text-muted-foreground"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      `site:${site.domain}`,
                      () => clicky.signOutBuddyBrowserSite(site.domain),
                      `signed out of ${site.domain}`,
                    )
                  }
                >
                  {busy === `site:${site.domain}` ? 'signing out…' : 'sign out'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t pt-2.5">
        <div className="text-[11px] font-medium text-foreground/90">always-allowed actions</div>
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/70">
          these remember consequences only. every action is still checked against your request.
        </p>
        {state.kind === 'ready' && grants.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground/75">no standing permissions</p>
        ) : (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {grants.map((grant) => (
              <div key={grant.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px]">{approvalGrantLabel(grant)}</div>
                  <div className="text-[9px] text-muted-foreground/70">
                    {approvalGrantUsage(grant)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[10px] text-muted-foreground"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      `grant:${grant.id}`,
                      () => clicky.revokeGrant(grant.id),
                      `revoked permission for ${approvalGrantLabel(grant)}`,
                    )
                  }
                >
                  {busy === `grant:${grant.id}` ? 'revoking…' : 'revoke'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t pt-2.5">
        {confirmClear ? (
          <div className="rounded-lg border border-destructive/35 bg-destructive/10 p-2.5">
            <div className="text-[11px] font-medium text-destructive">clear buddy's browser?</div>
            <p className="mt-1 text-[10px] leading-relaxed text-foreground/80">
              this signs buddy out everywhere and removes all browser data. it cannot be undone.
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-7 text-[11px]"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    'clear',
                    () => clicky.clearBuddyBrowser(),
                    "cleared buddy's browser",
                  ).then((cleared) => {
                    if (cleared) setConfirmClear(false);
                  })
                }
              >
                {busy === 'clear' ? 'clearing…' : 'yes, clear everything'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-[11px]"
                disabled={busy !== null}
                onClick={() => setConfirmClear(false)}
              >
                cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px] text-destructive"
            disabled={busy !== null}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            clear buddy's browser
          </Button>
        )}
      </div>

      {message ? (
        <p role="status" className="text-[10px] leading-relaxed text-muted-foreground">
          {message}
        </p>
      ) : null}
    </SettingsCard>
  );
}
