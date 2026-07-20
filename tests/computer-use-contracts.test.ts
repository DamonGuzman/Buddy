import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ApprovalApi,
  InvokeArgs,
  InvokeResult,
  MainToApprovalEvents,
  PanelApi,
} from '../src/shared/ipc';
import type {
  HelperBuddyStatus,
  HelperBuddyStep,
  ApprovalGrant,
  ApprovalRequest,
  EnrolledSite,
} from '../src/shared/types';

const electron = vi.hoisted(() => {
  const api = {
    panel: null as PanelApi | null,
    approval: null as ApprovalApi | null,
  };
  return {
    api,
    exposeInMainWorld: vi.fn((_name: string, exposed: PanelApi | ApprovalApi) => {
      if ('onRequests' in exposed) api.approval = exposed;
      else api.panel = exposed;
    }),
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
    send: electron.send,
  },
}));

await import('../src/preload/panel');
await import('../src/preload/approval');

function expectType<T>(_value: T): void {}

describe('computer-use shared contracts', () => {
  beforeEach(() => {
    electron.invoke.mockReset();
    electron.on.mockReset();
    electron.removeListener.mockReset();
    electron.send.mockReset();
  });

  it('keeps the new lifecycle, step, approval, and grant shapes renderer-safe', () => {
    expectType<HelperBuddyStatus>('waiting_approval');
    expectType<HelperBuddyStep['kind']>('browse');
    expectType<HelperBuddyStep['kind']>('action');
    expectType<HelperBuddyStep['kind']>('review');

    const request: ApprovalRequest = {
      helperBuddyId: 'helper-buddy-1',
      approvalId: 'approval-1',
      kind: 'browser-action',
      userRequest: 'create the checkout issue in linear',
      allowAlways: true,
      grantScope: 'submit “create issue” on linear.app',
      allowTakeover: false,
      browserDomain: 'linear.app',
      actionText: 'submit the issue',
      concern: 'this creates a record',
      screenshotPng: 'data:image/png;base64,AA==',
      payloadDigest: ['title: fix checkout'],
    };
    const capabilityRequest: ApprovalRequest = {
      ...request,
      approvalId: 'approval-2',
      kind: 'browser-capability',
      allowAlways: false,
      grantScope: null,
      browserDomain: null,
      actionText: 'allow this helper to use its browser',
    };
    const liveRequest: ApprovalRequest = {
      ...request,
      approvalId: 'approval-3',
      kind: 'live-action',
      allowAlways: false,
      grantScope: null,
      browserDomain: null,
      actionText: 'click submit on the live desktop',
    };
    const grant: ApprovalGrant = {
      id: 'grant-1',
      domain: 'linear.app',
      actionKind: 'form-submit',
      target: 'create issue',
      createdAt: 1,
      lastUsedAt: 2,
      timesUsed: 3,
    };
    const site: EnrolledSite = { domain: 'linear.app', cookieCount: 2 };

    expectType<MainToApprovalEvents['approval:requests']>([
      request,
      capabilityRequest,
      liveRequest,
    ]);
    expectType<InvokeArgs<'approval:resolve'>>(['helper-buddy-1', 'approval-1', 'always']);
    expectType<InvokeResult<'approvals:list'>>([request]);
    expectType<InvokeResult<'grants:list'>>([grant]);
    expectType<InvokeResult<'buddy-browser:list-enrolled-sites'>>([site]);
    expect(request).not.toHaveProperty('task');
    expect(request.browserDomain).toBe('linear.app');
    expect(capabilityRequest.browserDomain).toBeNull();
    expect(liveRequest.browserDomain).toBeNull();
    expect(request.grantScope).not.toContain('fix checkout');
    expect(grant).not.toHaveProperty('payload');
  });

  it('exposes full approval-queue subscriptions without exposing Electron', () => {
    const api = electron.api.approval;
    expect(api).not.toBeNull();
    if (!api) return;

    const callback = vi.fn();
    const unsubscribe = api.onRequests(callback);

    expect(electron.on).toHaveBeenCalledOnce();
    expect(electron.on.mock.calls[0]?.[0]).toBe('approval:requests');
    expect(typeof unsubscribe).toBe('function');
    expect(api).not.toHaveProperty('ipcRenderer');
  });

  it('maps every approval and enrollment API to its typed invoke channel', async () => {
    const api = electron.api.approval;
    expect(api).not.toBeNull();
    if (!api) return;

    electron.invoke.mockResolvedValue(undefined);
    await api.resolveApproval('helper-buddy-1', 'approval-1', 'once');
    await api.showApprovalWindow('helper-buddy-1', 'approval-1');
    await api.hideApprovalWindow('helper-buddy-1', 'approval-1');
    await api.listApprovals();

    expect(electron.invoke.mock.calls).toEqual([
      ['approval:resolve', 'helper-buddy-1', 'approval-1', 'once'],
      ['approval:show-window', 'helper-buddy-1', 'approval-1'],
      ['approval:hide-window', 'helper-buddy-1', 'approval-1'],
      ['approvals:list'],
    ]);
  });

  it('reports the approval card height through the standalone preload', () => {
    const api = electron.api.approval;
    expect(api).not.toBeNull();
    if (!api) return;

    api.setContentHeight(512);

    expect(electron.send).toHaveBeenCalledWith('approval:content-height', 512);
  });

  it('keeps grant and enrollment management on the Settings preload', async () => {
    const api = electron.api.panel;
    expect(api).not.toBeNull();
    if (!api) return;

    electron.invoke.mockResolvedValue(undefined);
    await api.listGrants();
    await api.revokeGrant('grant-1');
    await api.openBuddyBrowserEnrollment('https://linear.app');
    await api.listEnrolledSites();
    await api.signOutBuddyBrowserSite('linear.app');
    await api.clearBuddyBrowser();

    expect(electron.invoke.mock.calls).toEqual([
      ['grants:list'],
      ['grants:revoke', 'grant-1'],
      ['buddy-browser:open-enroll', 'https://linear.app'],
      ['buddy-browser:list-enrolled-sites'],
      ['buddy-browser:sign-out-site', 'linear.app'],
      ['buddy-browser:clear'],
    ]);
  });
});
