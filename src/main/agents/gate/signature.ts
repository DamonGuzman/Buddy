import { parse } from 'tldts';
import type { ApprovalGrant } from '../../../shared/types';
import type { ElementFacts, TriggerAction } from './trigger';

export type ApprovalActionKind = ApprovalGrant['actionKind'];

export interface ActionSignature {
  domain: string;
  actionKind: ApprovalActionKind;
  target: string;
}

const ACTION_SCOPE_VERB: Record<ApprovalActionKind, string> = {
  'form-submit': 'submit',
  button: 'click',
  'keyboard-submit': 'submit with enter',
  navigation: 'navigate to',
};

const MAX_TARGET_LENGTH = 160;
const MAX_DISPLAY_LENGTH = 240;
const SECRET_TEXT = /\b(?:sk-[A-Za-z0-9_-]{4,}|(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+)\b/gi;
const BEARER_TEXT = /\bBearer\s+\S+/gi;
const ASSIGNED_SECRET_TEXT =
  /\b((?:api[\s_-]*key|access[\s_-]*token|auth(?:entication)?[\s_-]*token|password|secret)\s*[:=]\s*)\S+/gi;
const EMAIL_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/**
 * Return a registrable, ASCII domain using the public suffix list. Private
 * suffixes are enabled so a grant for one tenant on github.io/vercel.app does
 * not silently grant every other tenant on that service.
 */
export function normalizeDomain(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('domain is required');

  let parsed: URL;
  try {
    parsed = new URL(hasScheme(value) ? value : `https://${value}`);
  } catch {
    throw new Error('domain must be a valid hostname or http(s) URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('domain must use http or https');
  }
  if (parsed.username || parsed.password) throw new Error('domain must not contain credentials');

  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!hostname) throw new Error('domain hostname is required');

  const parsedDomain = parse(hostname, {
    allowPrivateDomains: true,
    detectIp: true,
    validateHostname: true,
  });
  if (parsedDomain.hostname === null) throw new Error('domain hostname is invalid');
  // A registrable domain is unavailable for IPs and single-label/special-use
  // names. Retaining the fully validated canonical host is the narrowest safe
  // scope in those cases.
  return (parsedDomain.domain ?? parsedDomain.hostname).toLowerCase();
}

export function tryNormalizeDomain(raw: string): string | null {
  try {
    return normalizeDomain(raw);
  } catch {
    return null;
  }
}

/**
 * Normalize a visible control label for durable matching. Counts, generated
 * identifiers and credential-shaped fragments cannot widen a grant.
 */
export function normalizeTargetDescriptor(raw: string): string {
  const redacted = redactSignatureText(raw)
    .normalize('NFKC')
    .split('')
    .map((character) => (isControlOrBidi(character.charCodeAt(0)) ? ' ' : character))
    .join('')
    .toLocaleLowerCase('en-US')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b[a-z][a-z0-9]{1,9}-\d+\b/g, ' ')
    .replace(/\b(?:id\s*[:#-]?\s*)?[0-9a-f]{10,}\b/gi, ' ')
    .replace(/(?:^|\s)#\d+\b/g, ' ')
    .replace(/[([]\s*\d+\s*[)\]]/g, ' ')
    .replace(/\s+\d+\s*$/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (redacted || 'unlabeled target').slice(0, MAX_TARGET_LENGTH).trim();
}

/** Defensive scrub before a target label can enter persistent approval memory. */
export function redactSignatureText(raw: string): string {
  return raw
    .replace(BEARER_TEXT, 'Bearer [redacted]')
    .replace(ASSIGNED_SECRET_TEXT, '$1[redacted]')
    .replace(SECRET_TEXT, '[redacted]')
    .replace(EMAIL_TEXT, '[email]');
}

/**
 * Make untrusted text safe for a compact approval-card label. This is a
 * presentation boundary only: authorization continues to use exact driver
 * facts and normalized signatures, never this display value.
 */
export function scrubDisplayText(raw: string, maxLength = MAX_DISPLAY_LENGTH): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_DISPLAY_LENGTH) {
    throw new Error(`display text length must be between 1 and ${MAX_DISPLAY_LENGTH}`);
  }
  return raw
    .normalize('NFKC')
    .split('')
    .map((character) => (isControlOrBidi(character.codePointAt(0) ?? 0) ? ' ' : character))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

/**
 * Build a grant-compatible signature. Non-consequential actions (typing,
 * scrolling, screenshots, and non-submit key chords) cannot receive grants
 * and return null.
 */
export function buildActionSignature(
  action: TriggerAction,
  facts: ElementFacts | null,
): ActionSignature | null {
  if (action.kind === 'navigate') {
    const domain = tryNormalizeDomain(action.url);
    if (domain === null) return null;
    return { domain, actionKind: 'navigation', target: domain };
  }

  if (action.kind !== 'click' && action.kind !== 'press_keys') return null;
  if (action.kind === 'press_keys' && !containsEnter(action.keys)) return null;
  if (facts === null) return null;
  if (action.kind === 'press_keys' && !facts.inForm) return null;
  const domain = tryNormalizeDomain(facts.url);
  if (domain === null) return null;

  if (action.kind === 'click') {
    const tag = facts.tag.trim().toLowerCase();
    const inputType = facts.inputType?.trim().toLowerCase();
    const actionKind: ApprovalActionKind =
      inputType === 'submit' || (tag === 'button' && facts.inForm) ? 'form-submit' : 'button';
    const rawTarget = elementTarget(facts);
    if (!rawTarget.trim()) return null;
    return {
      domain,
      actionKind,
      target: normalizeTargetDescriptor(rawTarget),
    };
  }

  if (action.kind === 'press_keys') {
    const rawTarget = elementTarget(facts);
    if (!rawTarget.trim()) return null;
    return {
      domain,
      actionKind: 'keyboard-submit',
      target: normalizeTargetDescriptor(rawTarget),
    };
  }

  return null;
}

export function matchesApprovalGrant(grant: ApprovalGrant, signature: ActionSignature): boolean {
  const grantDomain = tryNormalizeDomain(grant.domain);
  return (
    grantDomain !== null &&
    grantDomain === normalizeDomain(signature.domain) &&
    grant.actionKind === signature.actionKind &&
    normalizeTargetDescriptor(grant.target) === normalizeTargetDescriptor(signature.target)
  );
}

/** Stable map key; JSON avoids delimiter-collision bugs with page-controlled labels. */
export function signatureKey(signature: ActionSignature): string {
  return JSON.stringify([
    normalizeDomain(signature.domain),
    signature.actionKind,
    normalizeTargetDescriptor(signature.target),
  ]);
}

/** Exact user-facing standing-permission scope, built only from normalized trusted facts. */
export function formatGrantScope(signature: ActionSignature): string {
  const domain = normalizeDomain(signature.domain);
  const target = normalizeTargetDescriptor(signature.target);
  return `${ACTION_SCOPE_VERB[signature.actionKind]} “${target}” on ${domain}`;
}

/** A denial key for actions that are intentionally not grant-compatible. */
export function actionTargetKey(action: TriggerAction, facts: ElementFacts | null): string {
  const grantSignature = buildActionSignature(action, facts);
  if (grantSignature !== null) return signatureKey(grantSignature);

  const domain = facts ? tryNormalizeDomain(facts.url) : null;
  const target = facts !== null ? elementTarget(facts) : action.kind;
  return JSON.stringify([domain ?? 'unresolved', action.kind, normalizeTargetDescriptor(target)]);
}

function elementTarget(facts: ElementFacts): string {
  return (
    [facts.text, facts.ariaLabel, facts.name, facts.id].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    ) ?? ''
  );
}

function containsEnter(keys: readonly string[]): boolean {
  return keys.some((key) => ['enter', 'return', 'numpadenter'].includes(key.trim().toLowerCase()));
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function isControlOrBidi(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}
