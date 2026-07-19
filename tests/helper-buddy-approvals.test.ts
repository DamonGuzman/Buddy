import { describe, expect, it, vi } from 'vitest';
import { HelperBuddyApprovalCoordinator } from '../src/main/agents/approvals';
import type { ApprovalRequest } from '../src/shared/types';

function request(patch: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    helperBuddyId: 'helper-buddy-1',
    approvalId: 'approval-1',
    kind: 'browser-action',
    userRequest: 'create the requested linear issue',
    allowAlways: true,
    grantScope: 'submit “create issue” on linear.app',
    allowTakeover: false,
    browserDomain: 'linear.app',
    actionText: 'submit the issue',
    concern: 'this creates a public record',
    screenshotPng: 'data:image/png;base64,iVBORw0KGgo=',
    payloadDigest: ['title: checkout regression'],
    ...patch,
  };
}

describe('HelperBuddyApprovalCoordinator transactions', () => {
  it('rejects noncanonical helper buddy ids before publishing an approval', () => {
    const onChanged = vi.fn();
    const coordinator = new HelperBuddyApprovalCoordinator({ onChanged });

    expect(() =>
      coordinator.request(
        request({ helperBuddyId: ' helper-buddy-1' }),
        new AbortController().signal,
      ),
    ).toThrow('canonical');
    expect(onChanged).not.toHaveBeenCalled();
    expect(coordinator.list()).toEqual([]);
  });

  it('rejects an untrusted runtime verdict outside the exact closed set', async () => {
    const coordinator = new HelperBuddyApprovalCoordinator({ onChanged: vi.fn() });
    void coordinator.request(request(), new AbortController().signal);

    await expect(coordinator.resolve('approval-1', 'approve-everything' as never)).rejects.toThrow(
      'approval verdict is invalid',
    );
    expect(coordinator.hasPending('approval-1')).toBe(true);
  });

  it('fails closed when always is enabled without a safe human-readable scope', async () => {
    const coordinator = new HelperBuddyApprovalCoordinator({ onChanged: vi.fn() });
    const pending = coordinator.request(
      request({ grantScope: null }),
      new AbortController().signal,
    );

    await expect(coordinator.resolve('approval-1', 'always')).rejects.toThrow(
      'does not allow a standing permission',
    );
    expect(coordinator.hasPending('approval-1')).toBe(true);
    const ui = coordinator.resolve('approval-1', 'once');
    const delivered = await pending;
    expect(delivered.verdict).toBe('once');
    expect(coordinator.hasPending('approval-1')).toBe(true);
    delivered.acknowledge();
    await expect(ui).resolves.toBeUndefined();
    expect(coordinator.hasPending('approval-1')).toBe(false);
  });

  it('keeps the card and UI invocation pending until downstream handling is acknowledged', async () => {
    const coordinator = new HelperBuddyApprovalCoordinator({ onChanged: vi.fn() });
    const pending = coordinator.request(request(), new AbortController().signal);
    const ui = coordinator.resolve('approval-1', 'always');
    const delivered = await pending;

    let uiSettled = false;
    void ui.finally(() => {
      uiSettled = true;
    });
    await Promise.resolve();
    expect(delivered.verdict).toBe('always');
    expect(uiSettled).toBe(false);
    expect(coordinator.list()).toHaveLength(1);

    delivered.acknowledge();
    await expect(ui).resolves.toBeUndefined();
    expect(coordinator.list()).toEqual([]);
  });

  it('retains a failed resolution for an explicit retry and surfaces the failure to UI', async () => {
    const coordinator = new HelperBuddyApprovalCoordinator({ onChanged: vi.fn() });
    const firstDelivery = coordinator.request(request(), new AbortController().signal);
    const firstUi = coordinator.resolve('approval-1', 'always');
    const first = await firstDelivery;

    first.reject(new Error('approval grant could not be persisted'));
    await expect(firstUi).rejects.toThrow('approval grant could not be persisted');
    expect(coordinator.get('approval-1')).toEqual(request());

    const retryDelivery = coordinator.request(request(), new AbortController().signal);
    const retryUi = coordinator.resolve('approval-1', 'deny');
    const retry = await retryDelivery;
    expect(retry.verdict).toBe('deny');
    retry.acknowledge();
    await expect(retryUi).resolves.toBeUndefined();
    expect(coordinator.list()).toEqual([]);
  });

  it('atomically replaces stale evidence without an empty approval snapshot', async () => {
    const snapshots: ApprovalRequest[][] = [];
    const coordinator = new HelperBuddyApprovalCoordinator({
      onChanged: (requests) => snapshots.push(requests),
    });
    const firstDelivery = coordinator.request(request(), new AbortController().signal);
    const firstUi = coordinator.resolve('approval-1', 'once');
    const first = await firstDelivery;

    const replacement = request({
      approvalId: 'approval-2',
      concern: 'the page changed; review the new target',
    });
    const secondDelivery = first.replace(replacement);
    await expect(firstUi).resolves.toBeUndefined();

    expect(coordinator.list()).toEqual([replacement]);
    expect(snapshots.at(-1)).toEqual([replacement]);
    expect(snapshots).not.toContainEqual([]);

    const secondUi = coordinator.resolve('approval-2', 'deny');
    const second = await secondDelivery;
    second.acknowledge();
    await expect(secondUi).resolves.toBeUndefined();
  });

  it('cancels every transaction even when cancellation snapshots fail to publish', async () => {
    let rejectSnapshots = false;
    const coordinator = new HelperBuddyApprovalCoordinator({
      onChanged: () => {
        if (rejectSnapshots) throw new Error('renderer disconnected');
      },
    });
    const first = coordinator.request(request(), new AbortController().signal);
    const second = coordinator.request(
      request({ helperBuddyId: 'helper-buddy-2', approvalId: 'approval-2' }),
      new AbortController().signal,
    );
    rejectSnapshots = true;

    expect(() => coordinator.cancelAll()).toThrow(AggregateError);
    await expect(first).resolves.toMatchObject({ verdict: 'deny' });
    await expect(second).resolves.toMatchObject({ verdict: 'deny' });
    expect(coordinator.list()).toEqual([]);
  });

  it('reports signal-cancellation publication failures after settling the transaction', async () => {
    const cancellationErrors: Error[] = [];
    let rejectSnapshots = false;
    const coordinator = new HelperBuddyApprovalCoordinator({
      onChanged: () => {
        if (rejectSnapshots) throw new Error('renderer disconnected');
      },
      onCancellationError: (error) => cancellationErrors.push(error),
    });
    const controller = new AbortController();
    const pending = coordinator.request(request(), controller.signal);
    rejectSnapshots = true;

    controller.abort();

    await expect(pending).resolves.toMatchObject({ verdict: 'deny' });
    expect(coordinator.list()).toEqual([]);
    expect(cancellationErrors).toEqual([
      expect.objectContaining({ message: 'renderer disconnected' }),
    ]);
  });
});
