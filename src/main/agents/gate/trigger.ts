import { tryNormalizeDomain } from './signature';

/**
 * Ground-truth DOM facts collected by a ComputerDriver. Textual fields are
 * page-controlled data and must never be treated as instructions.
 */
export interface ElementFacts {
  tag: string;
  inputType?: string;
  text: string;
  inForm: boolean;
  formAction?: string;
  href?: string;
  url: string;
  frame: 'top' | 'same-origin' | 'cross-origin-unresolved';
  /** Optional fields make credential detection stronger without weakening drivers that cannot supply them. */
  name?: string;
  id?: string;
  ariaLabel?: string;
  autocomplete?: string;
  role?: string;
  contentEditable?: boolean;
  /** Driver-computed nearest actionable ancestor state. */
  actionable?: boolean;
  /** Native disabled state; the only mechanically inert button exception. */
  disabled?: boolean;
}

interface JustifiedAction {
  justification: string;
}

export type TriggerAction =
  | (JustifiedAction & { kind: 'navigate'; url: string })
  | (JustifiedAction & {
      kind: 'click';
      x: number;
      y: number;
      label: string;
      button?: 'left' | 'right' | 'middle';
      count?: 1 | 2;
    })
  | (JustifiedAction & { kind: 'type'; text: string })
  | (JustifiedAction & { kind: 'press_keys'; keys: string[] })
  | (JustifiedAction & { kind: 'scroll'; x: number; y: number; dy: number })
  | { kind: 'screenshot' };

export type TriggerVerdict =
  { kind: 'pass' } | { kind: 'review'; reasons: string[] } | { kind: 'hard-deny'; reason: string };

export interface TriggerInput {
  action: TriggerAction;
  facts: ElementFacts | null;
  /** Registrable domains observed during this task. Raw hosts/URLs are accepted and normalized. */
  seenDomains?: ReadonlySet<string> | readonly string[];
}

const CONSEQUENCE_TEXT =
  /\b(?:send|sent|pay|payment|purchase|buy|checkout|confirm|confirmation|delete|remove|destroy|post|submit|order|publish|transfer|grant|authorize|approve|allow|accept|reject|invite|share|revoke|cancel|archive|unsubscribe|logout|log\s+out|sign\s+out|close\s+account|disable|enable|install|download|upload|merge|deploy)(?:s|ed|ing)?\b/i;
const CREDENTIAL_TEXT =
  /\b(?:password|passwd|pwd|passcode|pin|one[\s_-]*time(?:[\s_-]+code)?|otp|verification[\s_-]+code|api[\s_-]*key|access[\s_-]*token|auth(?:entication)?[\s_-]*token|secret|private[\s_-]*key|recovery[\s_-]*code|card[\s_-]*number|cc[\s_-]*number|cvv|cvc)\b/i;
const OAUTH_ACTION_TEXT =
  /\b(?:accept|allow|approve|authorize|connect|consent|continue|grant|give)\b.*\b(?:access|permission|permissions)?\b/i;
const FORM_FIELD_TAGS = new Set(['input', 'textarea', 'select']);

/**
 * Mechanical pre-review policy. This function deliberately ignores the
 * acting agent's justification: only the proposed action and DOM facts may
 * affect the trigger decision.
 */
export function classifyTrigger({ action, facts, seenDomains = [] }: TriggerInput): TriggerVerdict {
  if (action.kind === 'screenshot' || action.kind === 'scroll') return { kind: 'pass' };

  if (action.kind === 'navigate') {
    return classifyNavigation(action.url, facts?.url, seenDomains);
  }

  const unsafePageReason = facts ? prohibitedPageReason(facts.url) : null;
  if (unsafePageReason) return { kind: 'hard-deny', reason: unsafePageReason };

  if (action.kind === 'click' && action.button !== undefined && action.button !== 'left') {
    return { kind: 'hard-deny', reason: 'buddies can only use left click' };
  }

  if (facts === null) {
    return { kind: 'review', reasons: ['element facts unavailable'] };
  }

  if (action.kind === 'type' && isCredentialField(facts)) {
    return { kind: 'hard-deny', reason: 'buddies cannot enter credentials' };
  }

  if (facts.inputType?.trim().toLowerCase() === 'file') {
    return { kind: 'hard-deny', reason: 'buddies cannot use file upload controls' };
  }

  if (
    (action.kind === 'click' || (action.kind === 'press_keys' && containsEnter(action.keys))) &&
    isOauthConsentGrant(facts)
  ) {
    return { kind: 'hard-deny', reason: 'buddies cannot grant account access or permissions' };
  }

  const reasons: string[] = [];
  if (facts.frame === 'cross-origin-unresolved') reasons.push('target frame could not be resolved');

  if (action.kind === 'click' || activatesFocusedControl(action, facts)) {
    const tag = facts.tag.trim().toLowerCase();
    const inputType = facts.inputType?.trim().toLowerCase();
    if (facts.disabled === true)
      return reasons.length > 0 ? { kind: 'review', reasons } : { kind: 'pass' };

    const hrefVerdict = classifyDestination('link', facts.href, facts.url);
    if (hrefVerdict?.kind === 'hard-deny') return hrefVerdict;
    if (hrefVerdict?.kind === 'review') reasons.push(...hrefVerdict.reasons);
    const formVerdict = classifyDestination('form action', facts.formAction, facts.url);
    if (formVerdict?.kind === 'hard-deny') return formVerdict;
    if (formVerdict?.kind === 'review') reasons.push(...formVerdict.reasons);

    if (inputType === 'submit') reasons.push('target submits a form');
    if (tag === 'button') reasons.push('target is a button');
    if (facts.role?.trim().toLowerCase() === 'button') reasons.push('target has button role');
    if (facts.actionable === true && tag !== 'a' && tag !== 'button') {
      reasons.push('target is a custom actionable control');
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'label') {
      reasons.push('target is an interactive form control');
    }
    if (tag === 'a' && facts.href) reasons.push('target is a link');
    if (tag === 'a' && !facts.href) reasons.push('link target could not be resolved');
    if (
      tag !== 'a' &&
      tag !== 'button' &&
      !FORM_FIELD_TAGS.has(tag) &&
      tag !== 'label' &&
      facts.actionable !== false
    ) {
      reasons.push('target actionability could not be proven inert');
    }

    const trustedLabel = elementDescriptor(facts);
    if (CONSEQUENCE_TEXT.test(trustedLabel)) {
      reasons.push('target label describes a consequential action');
    }
  }

  if (
    action.kind === 'press_keys' &&
    containsEnter(action.keys) &&
    facts.inForm &&
    isFormField(facts)
  ) {
    reasons.push('enter may submit the focused form');
  }

  return reasons.length > 0 ? { kind: 'review', reasons: dedupe(reasons) } : { kind: 'pass' };
}

function classifyNavigation(
  targetUrl: string,
  currentUrl: string | undefined,
  seenDomains: ReadonlySet<string> | readonly string[],
): TriggerVerdict {
  let absoluteTarget: string;
  try {
    absoluteTarget = new URL(targetUrl).toString();
  } catch {
    return { kind: 'hard-deny', reason: 'navigation target is not a valid http(s) URL' };
  }
  const prohibitedReason = prohibitedPageReason(absoluteTarget);
  if (prohibitedReason) return { kind: 'hard-deny', reason: prohibitedReason };

  const targetDomain = tryNormalizeDomain(absoluteTarget);
  if (targetDomain === null) {
    return { kind: 'hard-deny', reason: 'navigation target is not a valid http(s) URL' };
  }

  const normalizedSeen = new Set<string>();
  for (const value of seenDomains) {
    const domain = tryNormalizeDomain(value);
    if (domain !== null) normalizedSeen.add(domain);
  }
  const currentDomain = currentUrl ? tryNormalizeDomain(currentUrl) : null;
  if (currentDomain !== null) normalizedSeen.add(currentDomain);

  const reasons = ['explicit navigation requires review'];
  if (!normalizedSeen.has(targetDomain))
    reasons.push(`navigation enters new domain ${targetDomain}`);
  return { kind: 'review', reasons };
}

function prohibitedPageReason(rawUrl: string): string | null {
  let protocol: string;
  try {
    protocol = new URL(rawUrl).protocol.toLowerCase();
  } catch {
    return 'buddies cannot act when the page URL is invalid';
  }
  if (protocol === 'chrome:' || protocol === 'file:') {
    return `buddies cannot act on ${protocol.slice(0, -1)} pages`;
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return 'buddies cannot act on non-http(s) pages';
  }
  return null;
}

function classifyDestination(
  description: string,
  rawDestination: string | undefined,
  pageUrl: string,
): Extract<TriggerVerdict, { kind: 'review' | 'hard-deny' }> | null {
  if (!rawDestination?.trim()) return null;
  let destination: URL;
  try {
    destination = new URL(rawDestination, pageUrl);
  } catch {
    return { kind: 'hard-deny', reason: `${description} destination is invalid` };
  }
  if (destination.protocol !== 'http:' && destination.protocol !== 'https:') {
    return { kind: 'hard-deny', reason: `${description} destination must use http(s)` };
  }
  const pageDomain = tryNormalizeDomain(pageUrl);
  const destinationDomain = tryNormalizeDomain(destination.toString());
  if (pageDomain === null || destinationDomain === null) {
    return { kind: 'hard-deny', reason: `${description} domain could not be verified` };
  }
  return pageDomain === destinationDomain
    ? null
    : { kind: 'review', reasons: [`${description} enters new domain ${destinationDomain}`] };
}

function isCredentialField(facts: ElementFacts): boolean {
  if (facts.inputType?.trim().toLowerCase() === 'password') return true;
  const autocomplete = facts.autocomplete?.trim().toLowerCase() ?? '';
  if (
    autocomplete
      .split(/\s+/)
      .some((token) =>
        ['current-password', 'new-password', 'one-time-code', 'webauthn'].includes(token),
      )
  ) {
    return true;
  }
  const descriptor = [facts.name, facts.id, facts.ariaLabel, facts.text]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2');
  return CREDENTIAL_TEXT.test(descriptor);
}

function isOauthConsentGrant(facts: ElementFacts): boolean {
  const actionText = elementDescriptor(facts);
  if (!OAUTH_ACTION_TEXT.test(actionText)) return false;

  const context = [facts.url, facts.href, facts.formAction].filter(Boolean).join(' ');
  return /(?:^|[/.?&=_-])(?:oauth2?|authorize|authorization|consent|permissions?)(?:[/.?&=_-]|$)/i.test(
    context,
  );
}

function isFormField(facts: ElementFacts): boolean {
  return FORM_FIELD_TAGS.has(facts.tag.trim().toLowerCase()) || facts.contentEditable === true;
}

function containsEnter(keys: readonly string[]): boolean {
  return keys.some((key) => ['enter', 'return', 'numpadenter'].includes(key.trim().toLowerCase()));
}

function activatesFocusedControl(action: TriggerAction, facts: ElementFacts): boolean {
  if (action.kind !== 'press_keys') return false;
  const tag = facts.tag.trim().toLowerCase();
  const role = facts.role?.trim().toLowerCase();
  const isActionable =
    tag === 'a' ||
    tag === 'button' ||
    tag === 'select' ||
    role === 'button' ||
    facts.actionable === true ||
    (tag === 'input' && facts.inputType?.trim().toLowerCase() !== 'text');
  if (!isActionable) return false;
  return action.keys.some((key) =>
    ['enter', 'return', 'numpadenter', 'space', 'spacebar', ' '].includes(key.toLowerCase()),
  );
}

function elementDescriptor(facts: ElementFacts): string {
  return [facts.text, facts.ariaLabel, facts.name, facts.id].filter(Boolean).join(' ');
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
