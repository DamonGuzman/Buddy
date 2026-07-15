import { useCallback, useEffect, useRef, useState } from 'react';
import { clicky } from '../clicky';
import { removeApprovalById } from '../computer-use-ui';
import type { ApprovalRequest } from '../../../shared/types';

export type ApprovalVerdict = 'once' | 'always' | 'deny';

export interface ComputerUseApprovalState {
  /** Full pending snapshot; the first request is the card currently shown. */
  approvals: ApprovalRequest[];
  resolving: ApprovalVerdict | null;
  actingInPlace: boolean;
  error: string | null;
  grantsRevision: number;
  resolve: (verdict: ApprovalVerdict) => Promise<void>;
  showBrowser: () => Promise<void>;
  finishInBrowser: () => Promise<void>;
}

/** Own the pending raise-hand queue delivered to the always-alive panel renderer. */
export function useComputerUseApproval(): ComputerUseApprovalState {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const [resolving, setResolving] = useState<ApprovalVerdict | null>(null);
  const [actingInPlace, setActingInPlace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grantsRevision, setGrantsRevision] = useState(0);

  const replaceApprovals = useCallback((requests: ApprovalRequest[]): void => {
    const previousHead = approvalsRef.current[0]?.approvalId;
    const nextHead = requests[0]?.approvalId;
    approvalsRef.current = requests;
    setApprovals(requests);
    if (previousHead !== nextHead) {
      setResolving(null);
      setActingInPlace(false);
      setError(null);
    }
  }, []);

  const removeApproval = useCallback((approvalId: string): void => {
    const removedHead = approvalsRef.current[0]?.approvalId === approvalId;
    const next = removeApprovalById(approvalsRef.current, approvalId);
    approvalsRef.current = next;
    setApprovals(next);
    if (removedHead) setActingInPlace(false);
  }, []);

  useEffect(() => {
    let active = true;
    let receivedPush = false;
    const off = clicky.onApprovals((requests) => {
      receivedPush = true;
      replaceApprovals(requests);
    });
    void clicky
      .listApprovals()
      .then((requests) => {
        if (active && !receivedPush) replaceApprovals(requests);
      })
      .catch(() => {
        if (active && !receivedPush) {
          setError("buddy couldn't load pending approvals. reopen settings to try again.");
        }
      });
    return () => {
      active = false;
      off();
    };
  }, [replaceApprovals]);

  const resolve = useCallback(
    async (verdict: ApprovalVerdict): Promise<void> => {
      const request = approvalsRef.current[0];
      if (request === undefined) return;
      setResolving(verdict);
      setError(null);
      try {
        await clicky.resolveApproval(request.agentId, request.approvalId, verdict);
        removeApproval(request.approvalId);
        if (verdict === 'always') setGrantsRevision((revision) => revision + 1);
      } catch {
        if (approvalsRef.current[0]?.approvalId === request.approvalId) {
          setError("buddy couldn't record your choice. nothing happened — please try again.");
        }
      } finally {
        setResolving(null);
      }
    },
    [removeApproval],
  );

  const showBrowser = useCallback(async (): Promise<void> => {
    const request = approvalsRef.current[0];
    if (request === undefined) return;
    setError(null);
    try {
      await clicky.showApprovalWindow(request.agentId, request.approvalId);
      if (approvalsRef.current[0]?.approvalId === request.approvalId) {
        setActingInPlace(true);
      }
    } catch {
      if (approvalsRef.current[0]?.approvalId === request.approvalId) {
        setError("buddy couldn't open its browser. the action is still waiting.");
      }
    }
  }, []);

  const finishInBrowser = useCallback(async (): Promise<void> => {
    const request = approvalsRef.current[0];
    if (request === undefined) return;
    setError(null);
    try {
      await clicky.hideApprovalWindow(request.agentId, request.approvalId);
      // "done" discards this proposal and resumes from a fresh observation.
      removeApproval(request.approvalId);
    } catch {
      if (approvalsRef.current[0]?.approvalId === request.approvalId) {
        setError("buddy couldn't take its browser back. leave it open and try again.");
      }
    }
  }, [removeApproval]);

  return {
    approvals,
    resolving,
    actingInPlace,
    error,
    grantsRevision,
    resolve,
    showBrowser,
    finishInBrowser,
  };
}
