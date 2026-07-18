import { describe, expect, it } from 'vitest';
import {
  ApprovalInteractionLatch,
  approvalAllowedByPreview,
  approvalGrantLabel,
  approvalGrantUsage,
  approvalPresentation,
  approvalScreenshotSrc,
  isExactApproval,
  removeApprovalById,
  sortApprovalGrants,
  standingGrantScope,
} from '../src/renderer/panel/computer-use-ui';
import type { ApprovalGrant, ApprovalRequest } from '../src/shared/types';

function grant(patch: Partial<ApprovalGrant>): ApprovalGrant {
  return {
    id: 'grant-1',
    domain: 'linear.app',
    actionKind: 'form-submit',
    target: 'create issue',
    createdAt: 100,
    lastUsedAt: 200,
    timesUsed: 1,
    ...patch,
  };
}

function approvalRequest(patch: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    helperBuddyId: 'helper-buddy',
    approvalId: 'approval',
    kind: 'browser-action',
    userRequest: 'submit the requested issue',
    allowAlways: true,
    grantScope: 'submit “create issue” on linear.app',
    allowTakeover: false,
    browserDomain: 'linear.app',
    actionText: 'submit create issue',
    concern: 'this publishes a record',
    screenshotPng: '',
    payloadDigest: [],
    ...patch,
  };
}

describe('computer-use approval presentation', () => {
  it('rejects a delayed interaction from replaced approval A instead of applying it to B', () => {
    const first = approvalRequest({ approvalId: 'approval-a', actionText: 'first action' });
    const replacement = approvalRequest({ approvalId: 'approval-b', actionText: 'second action' });
    const latch = new ApprovalInteractionLatch();

    latch.arm(first, 'once');

    expect(latch.consume(replacement, 'once')).toBe(false);
    expect(isExactApproval(replacement, first.helperBuddyId, first.approvalId)).toBe(false);
    expect(isExactApproval(replacement, replacement.helperBuddyId, replacement.approvalId)).toBe(
      true,
    );
  });

  it('consumes one explicit current interaction exactly once', () => {
    const request = approvalRequest({ approvalId: 'approval-current' });
    const latch = new ApprovalInteractionLatch();
    latch.arm(request, 'always');

    expect(latch.consume(request, 'always')).toBe(true);
    expect(latch.consume(request, 'always')).toBe(false);
  });

  it('accepts PNG data URLs and wraps raw base64 without accepting arbitrary URLs', () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const dataUrl = `data:image/png;base64,${png}`;
    expect(approvalScreenshotSrc(dataUrl)).toBe(dataUrl);
    expect(approvalScreenshotSrc(` ${png}\n`)).toBe(dataUrl);
    expect(approvalScreenshotSrc('https://attacker.example/track.png')).toBeNull();
    expect(approvalScreenshotSrc('javascript:alert(1)')).toBeNull();
    expect(approvalScreenshotSrc('')).toBeNull();
  });

  it('rejects blank, malformed, truncated, and non-PNG image bytes', () => {
    expect(approvalScreenshotSrc('   ')).toBeNull();
    expect(approvalScreenshotSrc('not base64')).toBeNull();
    expect(approvalScreenshotSrc('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
    expect(approvalScreenshotSrc('data:image/png;base64,SGVsbG8gd29ybGQ=')).toBeNull();
  });

  it('keeps action approval disabled until a valid preview decodes in the renderer', () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const base: ApprovalRequest = {
      helperBuddyId: 'helper-buddy',
      approvalId: 'preview-check',
      kind: 'browser-action',
      userRequest: 'submit the issue',
      allowAlways: true,
      grantScope: 'submit “create issue” on linear.app',
      allowTakeover: true,
      browserDomain: 'linear.app',
      actionText: 'submit create issue',
      concern: 'this publishes a record',
      screenshotPng: `data:image/png;base64,${png}`,
      payloadDigest: [],
    };

    expect(approvalAllowedByPreview(base, false)).toBe(false);
    expect(approvalAllowedByPreview(base, true)).toBe(true);
    expect(approvalAllowedByPreview({ ...base, screenshotPng: '' }, true)).toBe(false);
    expect(approvalAllowedByPreview({ ...base, screenshotPng: 'malformed' }, true)).toBe(false);
    expect(
      approvalAllowedByPreview(
        { ...base, kind: 'browser-capability', browserDomain: null, screenshotPng: '' },
        false,
      ),
    ).toBe(true);
  });

  it('orders grants by last use without mutating the IPC snapshot', () => {
    const original = [grant({ id: 'old', lastUsedAt: 10 }), grant({ id: 'new', lastUsedAt: 50 })];
    expect(sortApprovalGrants(original).map((item) => item.id)).toEqual(['new', 'old']);
    expect(original.map((item) => item.id)).toEqual(['old', 'new']);
  });

  it('uses plain-language labels and usage counts', () => {
    expect(approvalGrantLabel(grant({}))).toBe('create issue on linear.app');
    expect(approvalGrantUsage(grant({ timesUsed: 0 }))).toBe('not used yet');
    expect(approvalGrantUsage(grant({ timesUsed: 1 }))).toBe('used once');
    expect(approvalGrantUsage(grant({ timesUsed: 7 }))).toBe('used 7 times');
  });

  it('removes approvals by immutable approval id, not buddy id', () => {
    const requests: ApprovalRequest[] = [
      {
        helperBuddyId: 'same-helper-buddy',
        approvalId: 'approval-1',
        kind: 'browser-action',
        userRequest: 'file the two requested issues',
        allowAlways: true,
        grantScope: 'submit “create issue” on linear.app',
        allowTakeover: false,
        browserDomain: 'linear.app',
        actionText: 'submit issue one',
        concern: 'publishes data',
        screenshotPng: '',
        payloadDigest: [],
      },
      {
        helperBuddyId: 'same-helper-buddy',
        approvalId: 'approval-2',
        kind: 'browser-action',
        userRequest: 'file the two requested issues',
        allowAlways: true,
        grantScope: 'submit “create issue” on linear.app',
        allowTakeover: false,
        browserDomain: 'linear.app',
        actionText: 'submit issue two',
        concern: 'publishes data',
        screenshotPng: '',
        payloadDigest: [],
      },
    ];
    expect(removeApprovalById(requests, 'approval-1').map((request) => request.approvalId)).toEqual(
      ['approval-2'],
    );
    expect(requests).toHaveLength(2);
  });

  it('explains per-run browser access without implying a standing grant', () => {
    const request: ApprovalRequest = {
      helperBuddyId: 'helper-buddy',
      approvalId: 'capability',
      kind: 'browser-capability',
      userRequest: 'use the buddy browser to file my issue',
      allowAlways: false,
      grantScope: null,
      allowTakeover: false,
      browserDomain: null,
      actionText: 'use a private browser to file the issue',
      concern: 'browser access can use enrolled sessions',
      screenshotPng: '',
      payloadDigest: [],
    };
    expect(approvalPresentation(request)).toEqual({
      title: 'a helper buddy wants to use its browser',
      intro:
        'this grants browser use for this helper-buddy run only. check the task before continuing.',
      approveLabel: 'allow this run',
    });
  });

  it('fails closed when the gate does not provide a non-empty standing scope', () => {
    const base: ApprovalRequest = {
      helperBuddyId: 'helper-buddy',
      approvalId: 'action',
      kind: 'browser-action',
      userRequest: 'create the requested linear issue',
      allowAlways: true,
      grantScope: 'submit “create issue” on linear.app',
      allowTakeover: false,
      browserDomain: 'linear.app',
      actionText: 'submit the issue',
      concern: 'this publishes a record',
      screenshotPng: '',
      payloadDigest: [],
    };
    expect(standingGrantScope(base)).toBe('submit “create issue” on linear.app');
    expect(standingGrantScope({ ...base, grantScope: null })).toBeNull();
    expect(standingGrantScope({ ...base, grantScope: '   ' })).toBeNull();
    expect(standingGrantScope({ ...base, allowAlways: false })).toBeNull();
  });
});
