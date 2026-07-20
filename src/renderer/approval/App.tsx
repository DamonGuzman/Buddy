import { useEffect } from 'react';
import { ComputerUseApprovalCard } from '../panel/components/ComputerUseApprovalCard';
import { clicky } from './clicky';
import { useComputerUseApproval } from './use-approval';

function useApprovalWindowSizing(approvalId: string | null): void {
  useEffect(() => {
    if (approvalId === null) return;
    const header = document.querySelector<HTMLElement>('[data-approval-header]');
    const evidence = document.querySelector<HTMLElement>('[data-approval-evidence-content]');
    const actions = document.querySelector<HTMLElement>('[data-approval-actions]');
    if (!header || !evidence || !actions) return;

    let frame: number | null = null;
    let lastHeight = -1;
    const measure = (): void => {
      frame = null;
      const height = Math.ceil(
        header.getBoundingClientRect().height +
          evidence.scrollHeight +
          actions.getBoundingClientRect().height +
          2,
      );
      if (height === lastHeight) return;
      lastHeight = height;
      clicky.setContentHeight(height);
    };
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(header);
    observer.observe(evidence);
    observer.observe(actions);
    window.addEventListener('resize', schedule);
    void document.fonts.ready.then(schedule);
    schedule();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [approvalId]);
}

export function ApprovalApp(): React.JSX.Element | null {
  const computerUse = useComputerUseApproval();
  const currentApproval = computerUse.approvals[0] ?? null;
  useApprovalWindowSizing(currentApproval?.approvalId ?? null);
  if (currentApproval === null) return null;

  return (
    <main className="h-full w-full bg-transparent text-foreground">
      <ComputerUseApprovalCard
        key={currentApproval.approvalId}
        request={currentApproval}
        pendingCount={computerUse.approvals.length}
        resolving={computerUse.resolving}
        actingInPlace={computerUse.actingInPlace}
        error={computerUse.error}
        onResolve={(helperBuddyId, approvalId, verdict) =>
          void computerUse.resolve(helperBuddyId, approvalId, verdict)
        }
        onShowBrowser={(helperBuddyId, approvalId) =>
          void computerUse.showBrowser(helperBuddyId, approvalId)
        }
        onFinishInBrowser={(helperBuddyId, approvalId) =>
          void computerUse.finishInBrowser(helperBuddyId, approvalId)
        }
      />
    </main>
  );
}
