import { describe, expect, it } from 'vitest';
import type { ApprovalGrant } from '../src/shared/types';
import {
  actionTargetKey,
  buildActionSignature,
  formatGrantScope,
  matchesApprovalGrant,
  normalizeDomain,
  normalizeTargetDescriptor,
  redactSignatureText,
  signatureKey,
  tryNormalizeDomain,
} from '../src/main/agents/gate/signature';
import type { ElementFacts, TriggerAction } from '../src/main/agents/gate/trigger';

const baseFacts: ElementFacts = {
  tag: 'button',
  text: 'Create issue (3)',
  inForm: true,
  url: 'https://acme.linear.app/issues/new',
  frame: 'top',
};

describe('approval domain normalization', () => {
  it.each([
    ['https://WWW.Example.CO.UK:443/a?b=1', 'example.co.uk'],
    ['tenant.vercel.app', 'tenant.vercel.app'],
    ['foo.github.io', 'foo.github.io'],
    ['https://B\u00dcCHER.example./', 'xn--bcher-kva.example'],
    ['https://sub.linear.app', 'linear.app'],
    ['127.0.0.1:8123', '127.0.0.1'],
    ['[::1]:8123', '::1'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeDomain(raw)).toBe(expected);
  });

  it('rejects non-web schemes, credentials, and malformed hosts', () => {
    expect(() => normalizeDomain('file:///tmp/x')).toThrow('http or https');
    expect(() => normalizeDomain('https://user:secret@example.com')).toThrow(
      'must not contain credentials',
    );
    expect(tryNormalizeDomain('not a host')).toBeNull();
  });
});

describe('approval action signatures', () => {
  it('strips volatile counts and identifiers and redacts secret-shaped fragments', () => {
    expect(normalizeTargetDescriptor('  Create issue (3) #9812  ')).toBe('create issue');
    expect(normalizeTargetDescriptor('Delete 6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('delete');
    expect(normalizeTargetDescriptor('Delete issue ENG-123')).toBe('delete issue');
    expect(redactSignatureText('send to Alice@example.com using sk-secret123')).toBe(
      'send to [email] using [redacted]',
    );
  });

  it('builds normalized submit, button, keyboard, and navigation signatures', () => {
    const click: TriggerAction = {
      kind: 'click',
      x: 10,
      y: 20,
      label: 'agent claim is ignored',
      justification: 'create the requested issue',
    };
    expect(buildActionSignature(click, baseFacts)).toEqual({
      domain: 'linear.app',
      actionKind: 'form-submit',
      target: 'create issue',
    });
    expect(buildActionSignature(click, { ...baseFacts, tag: 'a', inForm: false })).toEqual({
      domain: 'linear.app',
      actionKind: 'button',
      target: 'create issue',
    });
    expect(
      buildActionSignature(
        { kind: 'press_keys', keys: ['Enter'], justification: 'submit' },
        { ...baseFacts, tag: 'textarea' },
      ),
    ).toEqual({
      domain: 'linear.app',
      actionKind: 'keyboard-submit',
      target: 'create issue',
    });
    expect(
      buildActionSignature(
        { kind: 'navigate', url: 'https://docs.example.co.uk/a', justification: 'open docs' },
        null,
      ),
    ).toEqual({
      domain: 'example.co.uk',
      actionKind: 'navigation',
      target: 'example.co.uk',
    });
  });

  it('does not create consequence grants for typing, scrolling, or ordinary key chords', () => {
    expect(
      buildActionSignature(
        { kind: 'type', text: 'hello', justification: 'fill title' },
        { ...baseFacts, url: 'not a valid url' },
      ),
    ).toBeNull();
    expect(
      buildActionSignature(
        { kind: 'press_keys', keys: ['Escape'], justification: 'dismiss' },
        { ...baseFacts, url: 'not a valid url' },
      ),
    ).toBeNull();
    expect(
      buildActionSignature(
        { kind: 'scroll', x: 1, y: 2, dy: 300, justification: 'see more' },
        { ...baseFacts, url: 'not a valid url' },
      ),
    ).toBeNull();
    expect(
      buildActionSignature(
        { kind: 'navigate', url: 'not a valid url', justification: 'go there' },
        null,
      ),
    ).toBeNull();
    expect(() =>
      actionTargetKey({ kind: 'navigate', url: 'file:///tmp/x', justification: 'go there' }, null),
    ).not.toThrow();
  });

  it('never lets the acting agent invent a label for an ungrounded standing grant', () => {
    expect(
      buildActionSignature(
        {
          kind: 'click',
          x: 1,
          y: 2,
          label: 'create issue',
          justification: 'agent-authored claim',
        },
        { ...baseFacts, text: '', ariaLabel: '', name: '', id: '' },
      ),
    ).toBeNull();

    const first = actionTargetKey(
      { kind: 'click', x: 1, y: 2, label: 'safe', justification: 'claim' },
      null,
    );
    const second = actionTargetKey(
      { kind: 'click', x: 1, y: 2, label: 'different', justification: 'claim' },
      null,
    );
    expect(first).toBe(second);
  });

  it('matches normalized grants exactly and excludes payloads from keys', () => {
    const signature = {
      domain: 'https://app.linear.app',
      actionKind: 'form-submit' as const,
      target: 'Create issue (9)',
    };
    const grant: ApprovalGrant = {
      id: 'g1',
      domain: 'linear.app',
      actionKind: 'form-submit',
      target: 'create issue',
      createdAt: 1,
      lastUsedAt: 1,
      timesUsed: 0,
    };
    expect(matchesApprovalGrant(grant, signature)).toBe(true);
    expect(matchesApprovalGrant({ ...grant, actionKind: 'button' }, signature)).toBe(false);
    expect(signatureKey(signature)).toBe(
      signatureKey({ ...signature, target: 'create issue (2)' }),
    );
    expect(formatGrantScope(signature)).toBe('submit “create issue” on linear.app');
    expect(
      formatGrantScope({
        ...signature,
        actionKind: 'button',
        target: 'Send sk-secret123 to alice@example.com',
      }),
    ).toBe('click “send redacted to email” on linear.app');
  });

  it('creates stable denial keys even for actions that cannot receive a standing grant', () => {
    const first = actionTargetKey(
      { kind: 'type', text: 'payload one', justification: 'fill it' },
      { ...baseFacts, tag: 'input', text: 'Issue title', inForm: true },
    );
    const second = actionTargetKey(
      { kind: 'type', text: 'different payload', justification: 'fill it' },
      { ...baseFacts, tag: 'input', text: 'Issue title', inForm: true },
    );
    expect(first).toBe(second);
  });
});
