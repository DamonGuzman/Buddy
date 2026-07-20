import { useCallback, useEffect, useRef, useState } from 'react';
import { clicky } from './clicky';
import {
  isExactApproval,
  removeApprovalById,
  type ApprovalVerdict,
} from '../panel/computer-use-ui';
import type { ApprovalRequest } from '../../shared/types';

export interface ComputerUseApprovalState {
  approvals: ApprovalRequest[];
  resolving: ApprovalVerdict | null;
  actingInPlace: boolean;
  error: string | null;
  resolve: (helperBuddyId: string, approvalId: string, verdict: ApprovalVerdict) => Promise<void>;
  showBrowser: (helperBuddyId: string, approvalId: string) => Promise<void>;
  finishInBrowser: (helperBuddyId: string, approvalId: string) => Promise<void>;
}

/** Own the pending raise-hand queue inside the dedicated approval renderer. */
export function useComputerUseApproval(): ComputerUseApprovalState {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const resolvingApprovalRef = useRef<string | null>(null);
  const [resolving, setResolving] = useState<ApprovalVerdict | null>(null);
  const [actingInPlace, setActingInPlace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replaceApprovals = useCallback((requests: ApprovalRequest[]): void => {
    const previousHead = approvalsRef.current[0]?.approvalId;
    const nextHead = requests[0]?.approvalId;
    approvalsRef.current = requests;
    setApprovals(requests);
    if (previousHead !== nextHead) {
      resolvingApprovalRef.current = null;
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
    const off = clicky.onRequests((requests) => {
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
          setError("buddy couldn't load pending approvals. the requested action remains paused.");
        }
      });
    return () => {
      active = false;
      off();
    };
  }, [replaceApprovals]);

  const resolve = useCallback(
    async (helperBuddyId: string, approvalId: string, verdict: ApprovalVerdict): Promise<void> => {
      const request = approvalsRef.current[0];
      if (!isExactApproval(request, helperBuddyId, approvalId)) {
        setError('that approval is no longer current. review the new request before choosing.');
        return;
      }
      if (resolvingApprovalRef.current !== null) return;
      resolvingApprovalRef.current = approvalId;
      setResolving(verdict);
      setError(null);
      try {
        await clicky.resolveApproval(request.helperBuddyId, request.approvalId, verdict);
        removeApproval(request.approvalId);
      } catch {
        if (approvalsRef.current[0]?.approvalId === request.approvalId) {
          setError("buddy couldn't record your choice. nothing happened — please try again.");
        }
      } finally {
        if (resolvingApprovalRef.current === approvalId) {
          resolvingApprovalRef.current = null;
          if (approvalsRef.current[0]?.approvalId === approvalId) setResolving(null);
        }
      }
    },
    [removeApproval],
  );

  const showBrowser = useCallback(
    async (helperBuddyId: string, approvalId: string): Promise<void> => {
      const request = approvalsRef.current[0];
      if (!isExactApproval(request, helperBuddyId, approvalId)) {
        setError('that approval is no longer current. review the new request before continuing.');
        return;
      }
      setError(null);
      try {
        await clicky.showApprovalWindow(request.helperBuddyId, request.approvalId);
        if (approvalsRef.current[0]?.approvalId === request.approvalId) setActingInPlace(true);
      } catch {
        if (approvalsRef.current[0]?.approvalId === request.approvalId) {
          setError("buddy couldn't open its browser. the action is still waiting.");
        }
      }
    },
    [],
  );

  const finishInBrowser = useCallback(
    async (helperBuddyId: string, approvalId: string): Promise<void> => {
      const request = approvalsRef.current[0];
      if (!isExactApproval(request, helperBuddyId, approvalId)) {
        setError('that approval is no longer current. review the new request before continuing.');
        return;
      }
      setError(null);
      try {
        await clicky.hideApprovalWindow(request.helperBuddyId, request.approvalId);
        removeApproval(request.approvalId);
      } catch {
        if (approvalsRef.current[0]?.approvalId === request.approvalId) {
          setError("buddy couldn't take its browser back. leave it open and try again.");
        }
      }
    },
    [removeApproval],
  );

  return { approvals, resolving, actingInPlace, error, resolve, showBrowser, finishInBrowser };
}
