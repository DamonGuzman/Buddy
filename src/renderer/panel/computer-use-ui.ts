import type { ApprovalGrant, ApprovalRequest } from '../../shared/types';

/** Keep approval screenshots renderer-safe regardless of whether main sends raw base64 or a data URL. */
export function approvalScreenshotSrc(value: string): string | null {
  const screenshot = value.trim();
  if (screenshot === '') return null;
  const raw = screenshot.startsWith('data:image/png;base64,')
    ? screenshot.slice('data:image/png;base64,'.length).replace(/\s+/g, '')
    : screenshot.replace(/\s+/g, '');
  if (!/^iVBORw0KGgo[a-z0-9+/]*={0,2}$/i.test(raw) || raw.length % 4 !== 0) return null;
  if (!isStructurallyValidPng(raw)) return null;
  return `data:image/png;base64,${raw}`;
}

function isStructurallyValidPng(base64: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return false;
  }
  if (bytes.length < 45) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let first = true;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (first) {
      if (type !== 'IHDR' || length !== 13) return false;
      if (view.getUint32(offset + 8) === 0 || view.getUint32(offset + 12) === 0) return false;
      first = false;
    }
    if (type === 'IEND') return length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

/** Consequential actions require both structurally valid bytes and a successful renderer decode. */
export function approvalAllowedByPreview(
  request: ApprovalRequest,
  rendererDecoded: boolean,
): boolean {
  if (request.kind === 'browser-capability') return true;
  return rendererDecoded && approvalScreenshotSrc(request.screenshotPng) !== null;
}

/** Most recently exercised permissions are the most useful ones to review first. */
export function sortApprovalGrants(grants: ApprovalGrant[]): ApprovalGrant[] {
  return [...grants].sort(
    (a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

export function approvalGrantLabel(grant: ApprovalGrant): string {
  const target = grant.target.trim() || grant.actionKind.replaceAll('-', ' ');
  return `${target} on ${grant.domain}`;
}

export function approvalGrantUsage(grant: ApprovalGrant): string {
  if (grant.timesUsed <= 0) return 'not used yet';
  return grant.timesUsed === 1 ? 'used once' : `used ${grant.timesUsed} times`;
}

/** Remove only the exact immutable approval; another request from the same buddy must survive. */
export function removeApprovalById(
  requests: ApprovalRequest[],
  approvalId: string,
): ApprovalRequest[] {
  return requests.filter((request) => request.approvalId !== approvalId);
}

export interface ApprovalPresentation {
  title: string;
  intro: string;
  approveLabel: string;
}

export function approvalPresentation(request: ApprovalRequest): ApprovalPresentation {
  switch (request.kind) {
    case 'browser-capability':
      return {
        title: 'a helper wants to use its browser',
        intro:
          'this grants browser use for this helper run only. check the task before continuing.',
        approveLabel: 'allow this run',
      };
    case 'needs-user':
      return {
        title: 'a helper needs your help',
        intro: 'buddy paused at a sign-in or check that only you should handle.',
        approveLabel: 'approve once',
      };
    case 'live-action':
      return {
        title: 'a helper wants to use your computer',
        intro: 'nothing has happened yet. check the target and choose what buddy should do.',
        approveLabel: 'approve once',
      };
    case 'browser-action':
      return {
        title: 'a helper needs your ok',
        intro: 'nothing has happened yet. check the target and choose what buddy should do.',
        approveLabel: 'approve once',
      };
  }
}

/** Standing consent is available only when both the gate decision and exact safe scope agree. */
export function standingGrantScope(request: ApprovalRequest): string | null {
  if (!request.allowAlways) return null;
  const scope = request.grantScope?.trim() ?? '';
  return scope === '' ? null : scope;
}
