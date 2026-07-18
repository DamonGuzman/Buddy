import { useState } from 'react';
import { AlertTriangle, ExternalLink, Hand, ShieldCheck } from 'lucide-react';
import {
  ApprovalInteractionLatch,
  type ApprovalInteractionAction,
  approvalAllowedByPreview,
  approvalPresentation,
  approvalScreenshotSrc,
  standingGrantScope,
} from '../computer-use-ui';
import { Button } from '@/components/ui/button';
import type { ApprovalRequest } from '../../../shared/types';
import type { ApprovalVerdict } from '../hooks/use-computer-use';

interface ComputerUseApprovalCardProps {
  request: ApprovalRequest;
  pendingCount: number;
  resolving: ApprovalVerdict | null;
  actingInPlace: boolean;
  error: string | null;
  onResolve: (helperBuddyId: string, approvalId: string, verdict: ApprovalVerdict) => void;
  onShowBrowser: (helperBuddyId: string, approvalId: string) => void;
  onFinishInBrowser: (helperBuddyId: string, approvalId: string) => void;
}

export function ComputerUseApprovalCard({
  request,
  pendingCount,
  resolving,
  actingInPlace,
  error,
  onResolve,
  onShowBrowser,
  onFinishInBrowser,
}: ComputerUseApprovalCardProps): React.JSX.Element {
  const screenshot = approvalScreenshotSrc(request.screenshotPng);
  const presentation = approvalPresentation(request);
  const requiresPreview = request.kind !== 'browser-capability';
  const grantScope = standingGrantScope(request);
  const busy = resolving !== null;
  const [interaction] = useState(() => new ApprovalInteractionLatch());
  const [imageState, setImageState] = useState<{
    src: string | null;
    status: 'loading' | 'valid' | 'invalid';
  }>({ src: null, status: 'invalid' });
  const previewStatus =
    screenshot === null ? 'invalid' : imageState.src === screenshot ? imageState.status : 'loading';
  const approvalEnabled = approvalAllowedByPreview(request, previewStatus === 'valid');
  const armPointer =
    (action: ApprovalInteractionAction) =>
    (event: React.PointerEvent<HTMLButtonElement>): void => {
      if (!event.isPrimary || event.button !== 0) return;
      interaction.arm(request, action);
    };
  const armKeyboard =
    (action: ApprovalInteractionAction) =>
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
      interaction.arm(request, action);
    };
  const consumeInteraction = (action: ApprovalInteractionAction, run: () => void): void => {
    if (!interaction.consume(request, action)) return;
    run();
  };

  return (
    <section
      aria-labelledby="computer-use-approval-title"
      className="mx-4 mt-3 overflow-hidden rounded-xl border border-amber-400/45 bg-amber-400/8 shadow-lg shadow-black/20"
    >
      <div className="flex items-start gap-2.5 border-b border-amber-400/25 px-3.5 py-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-300">
          <Hand className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="computer-use-approval-title" className="text-sm font-semibold text-amber-100">
            {presentation.title}
          </h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {presentation.intro}
          </p>
          {pendingCount > 1 ? (
            <p className="mt-1 text-[10px] font-medium text-amber-200/80">
              1 of {pendingCount} checks waiting
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2.5 p-3.5">
        {screenshot && previewStatus !== 'invalid' ? (
          <div className="overflow-hidden rounded-lg border bg-black/35">
            <img
              key={screenshot}
              src={screenshot}
              alt="computer-use preview with the proposed target marked"
              className="max-h-40 w-full object-contain"
              onLoad={() => setImageState({ src: screenshot, status: 'valid' })}
              onError={() => setImageState({ src: screenshot, status: 'invalid' })}
            />
            {previewStatus === 'loading' ? (
              <div className="border-t px-3 py-1.5 text-center text-[10px] text-muted-foreground">
                verifying preview…
              </div>
            ) : null}
          </div>
        ) : requiresPreview ? (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            the browser preview is unavailable. deny this action unless you can verify it in place.
          </div>
        ) : null}

        <div className="rounded-lg border border-clicky/25 bg-clicky/8 px-3 py-2">
          <div className="text-[10px] font-medium tracking-wide text-clicky uppercase">
            your exact request
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/90">
            {request.userRequest}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            proposed action
          </div>
          <div className="mt-1 text-[13px] leading-snug text-foreground">{request.actionText}</div>
          {request.kind === 'browser-action' && request.browserDomain ? (
            <div className="mt-1 text-[11px] text-muted-foreground">
              destination site:{' '}
              <span className="font-mono text-foreground/85">{request.browserDomain}</span>
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-amber-400/25 bg-black/15 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-amber-200 uppercase">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            why buddy paused
          </div>
          <div className="mt-1 text-[11px] leading-relaxed text-foreground/90">
            {request.concern}
          </div>
        </div>

        {request.payloadDigest.length > 0 ? (
          <div>
            <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              information being submitted
            </div>
            <ul className="mt-1.5 flex flex-col gap-1 text-[11px] leading-relaxed text-foreground/85">
              {request.payloadDigest.map((line, index) => (
                <li key={`${index}-${line}`} className="rounded-md bg-white/4 px-2 py-1">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="text-[11px] leading-relaxed text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2 pt-0.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !approvalEnabled}
            onPointerDown={armPointer('once')}
            onKeyDown={armKeyboard('once')}
            onClick={() =>
              consumeInteraction('once', () =>
                onResolve(request.helperBuddyId, request.approvalId, 'once'),
              )
            }
          >
            {resolving === 'once' ? 'approving…' : presentation.approveLabel}
          </Button>
          {grantScope ? (
            <Button
              type="button"
              size="sm"
              className="h-auto min-h-8 whitespace-normal py-1.5 text-center leading-tight"
              disabled={busy || !approvalEnabled}
              onPointerDown={armPointer('always')}
              onKeyDown={armKeyboard('always')}
              onClick={() =>
                consumeInteraction('always', () =>
                  onResolve(request.helperBuddyId, request.approvalId, 'always'),
                )
              }
            >
              {resolving === 'always' ? 'saving…' : `always allow ${grantScope}`}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onPointerDown={armPointer('deny')}
            onKeyDown={armKeyboard('deny')}
            onClick={() =>
              consumeInteraction('deny', () =>
                onResolve(request.helperBuddyId, request.approvalId, 'deny'),
              )
            }
          >
            {resolving === 'deny' ? 'denying…' : 'deny'}
          </Button>
          {request.allowTakeover ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onPointerDown={armPointer('takeover')}
              onKeyDown={armKeyboard('takeover')}
              onClick={() =>
                consumeInteraction('takeover', () =>
                  actingInPlace
                    ? onFinishInBrowser(request.helperBuddyId, request.approvalId)
                    : onShowBrowser(request.helperBuddyId, request.approvalId),
                )
              }
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              {actingInPlace ? 'done in browser' : 'let me do it'}
            </Button>
          ) : null}
        </div>
        {grantScope ? (
          <p className="text-[10px] leading-relaxed text-muted-foreground/75">
            “always allow {grantScope}” remembers only that scope. buddy still checks every action
            against your exact request above.
          </p>
        ) : null}
      </div>
    </section>
  );
}
