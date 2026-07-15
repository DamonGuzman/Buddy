import { describe, expect, it } from 'vitest';
import {
  classifyTrigger,
  type ElementFacts,
  type TriggerAction,
} from '../src/main/agents/gate/trigger';

function facts(overrides: Partial<ElementFacts> = {}): ElementFacts {
  return {
    tag: 'a',
    text: 'learn more',
    inForm: false,
    url: 'https://app.linear.app/acme/issues',
    frame: 'top',
    ...overrides,
  };
}

function action(overrides: Partial<Extract<TriggerAction, { kind: 'click' }>> = {}): TriggerAction {
  return {
    kind: 'click',
    x: 10,
    y: 20,
    label: 'learn more',
    justification: 'open the requested issue details',
    ...overrides,
  };
}

describe('agent action trigger', () => {
  it('passes read-only observations, scrolling, and mechanically inert grounded clicks', () => {
    expect(classifyTrigger({ action: { kind: 'screenshot' }, facts: null })).toEqual({
      kind: 'pass',
    });
    expect(
      classifyTrigger({
        action: { kind: 'scroll', x: 0, y: 0, dy: 500, justification: 'see more results' },
        facts: null,
      }),
    ).toEqual({ kind: 'pass' });
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({ tag: 'div', text: 'Decoration', actionable: false }),
      }),
    ).toEqual({ kind: 'pass' });
  });

  it('hard-denies actions on chrome/file pages and malformed navigation targets', () => {
    expect(
      classifyTrigger({ action: action(), facts: facts({ url: 'file:///etc/passwd' }) }),
    ).toEqual({ kind: 'hard-deny', reason: 'buddies cannot act on file pages' });
    expect(
      classifyTrigger({
        action: { kind: 'navigate', url: 'chrome://settings', justification: 'change settings' },
        facts: null,
      }),
    ).toEqual({ kind: 'hard-deny', reason: 'buddies cannot act on chrome pages' });
    expect(
      classifyTrigger({
        action: { kind: 'navigate', url: 'not a host', justification: 'go there' },
        facts: null,
      }),
    ).toEqual({ kind: 'hard-deny', reason: 'navigation target is not a valid http(s) URL' });
    expect(classifyTrigger({ action: action(), facts: facts({ url: 'about:blank' }) })).toEqual({
      kind: 'hard-deny',
      reason: 'buddies cannot act on non-http(s) pages',
    });
  });

  it.each([
    { inputType: 'password' },
    { autocomplete: 'section-login current-password' },
    { ariaLabel: 'API key' },
    { name: 'apiKeyField' },
    { name: 'one_time_code' },
  ] satisfies Partial<ElementFacts>[])('hard-denies credential field typing: %o', (field) => {
    expect(
      classifyTrigger({
        action: { kind: 'type', text: 'secret', justification: 'sign in' },
        facts: facts({ tag: 'input', text: '', ...field }),
      }),
    ).toEqual({ kind: 'hard-deny', reason: 'buddies cannot enter credentials' });
  });

  it('hard-denies OAuth consent grants but only reviews similarly named ordinary actions', () => {
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({
          tag: 'button',
          text: 'Allow access',
          inForm: true,
          url: 'https://accounts.example.com/oauth/authorize?client_id=x',
        }),
      }),
    ).toEqual({
      kind: 'hard-deny',
      reason: 'buddies cannot grant account access or permissions',
    });

    const ordinary = classifyTrigger({
      action: action(),
      facts: facts({ tag: 'button', text: 'Authorize refund', inForm: true }),
    });
    expect(ordinary.kind).toBe('review');
  });

  it('reviews form submits, consequential labels, and unresolved frames', () => {
    const verdict = classifyTrigger({
      action: action(),
      facts: facts({
        tag: 'input',
        inputType: 'submit',
        text: 'Publish posts',
        frame: 'cross-origin-unresolved',
      }),
    });
    expect(verdict).toEqual({
      kind: 'review',
      reasons: [
        'target frame could not be resolved',
        'target submits a form',
        'target is an interactive form control',
        'target label describes a consequential action',
      ],
    });
  });

  it('hard-denies file upload controls so hidden input cannot open a native chooser', () => {
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({ tag: 'input', inputType: 'file', text: 'Choose file' }),
      }),
    ).toEqual({ kind: 'hard-deny', reason: 'buddies cannot use file upload controls' });
  });

  it('reviews every actionable control and custom/unresolved click target', () => {
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({ tag: 'button', text: 'Next' }),
      }),
    ).toEqual({ kind: 'review', reasons: ['target is a button'] });
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({ tag: 'div', text: 'Next', role: 'button' }),
      }),
    ).toEqual({
      kind: 'review',
      reasons: ['target has button role', 'target actionability could not be proven inert'],
    });
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({ tag: 'div', text: 'Next', actionable: true }),
      }),
    ).toEqual({
      kind: 'review',
      reasons: [
        'target is a custom actionable control',
        'target actionability could not be proven inert',
      ],
    });
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({ tag: 'div', text: 'Decoration', actionable: false }),
      }),
    ).toEqual({ kind: 'pass' });
  });

  it('reviews cross-domain links and form-action overrides and denies non-web destinations', () => {
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({ href: 'https://attacker.example/continue' }),
      }),
    ).toEqual({
      kind: 'review',
      reasons: ['link enters new domain attacker.example', 'target is a link'],
    });
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({
          tag: 'button',
          text: 'Next',
          formAction: 'https://attacker.example/submit',
        }),
      }),
    ).toEqual({
      kind: 'review',
      reasons: ['form action enters new domain attacker.example', 'target is a button'],
    });
    expect(
      classifyTrigger({
        action: action(),
        facts: facts({ href: 'javascript:alert(1)' }),
      }),
    ).toEqual({ kind: 'hard-deny', reason: 'link destination must use http(s)' });

    expect(
      classifyTrigger({
        action: { kind: 'press_keys', keys: ['Enter'], justification: 'open it' },
        facts: facts({ href: 'https://attacker.example/continue' }),
      }),
    ).toEqual({
      kind: 'review',
      reasons: ['link enters new domain attacker.example', 'target is a link'],
    });

    expect(
      classifyTrigger({
        action: action({ label: 'view documentation' }),
        facts: facts({ text: 'View documentation', href: '/delete-account?confirm=true' }),
      }),
    ).toEqual({ kind: 'review', reasons: ['target is a link'] });
  });

  it('hard-denies right and middle clicks', () => {
    expect(classifyTrigger({ action: action({ button: 'right' }), facts: facts() })).toEqual({
      kind: 'hard-deny',
      reason: 'buddies can only use left click',
    });
    expect(classifyTrigger({ action: action({ button: 'middle' }), facts: facts() })).toEqual({
      kind: 'hard-deny',
      reason: 'buddies can only use left click',
    });
  });

  it('reviews enter only when it can submit a focused form field', () => {
    const press: TriggerAction = {
      kind: 'press_keys',
      keys: ['CTRL', 'Enter'],
      justification: 'submit the issue',
    };
    expect(
      classifyTrigger({ action: press, facts: facts({ tag: 'textarea', inForm: true }) }),
    ).toEqual({ kind: 'review', reasons: ['enter may submit the focused form'] });
    expect(classifyTrigger({ action: press, facts: facts({ tag: 'div', inForm: false }) })).toEqual(
      {
        kind: 'pass',
      },
    );
  });

  it('reviews ungrounded acting calls and never trusts a claimed safe label over DOM facts', () => {
    expect(classifyTrigger({ action: action(), facts: null })).toEqual({
      kind: 'review',
      reasons: ['element facts unavailable'],
    });
    expect(
      classifyTrigger({
        action: action({ label: 'next' }),
        facts: facts({ tag: 'button', text: 'Delete everything', inForm: false }),
      }),
    ).toEqual({
      kind: 'review',
      reasons: ['target is a button', 'target label describes a consequential action'],
    });
  });

  it('reviews every explicit navigation, including seen domains and same-domain side-effect paths', () => {
    const navigate: TriggerAction = {
      kind: 'navigate',
      url: 'https://other.linear.app/new',
      justification: 'open the issue form',
    };
    expect(
      classifyTrigger({ action: navigate, facts: facts(), seenDomains: ['https://linear.app'] }),
    ).toEqual({ kind: 'review', reasons: ['explicit navigation requires review'] });

    for (const url of [
      'https://app.linear.app/delete?id=123&confirm=true',
      'https://app.linear.app/oauth/callback?code=attacker-value',
      'https://app.linear.app/api/action?publish=true',
    ]) {
      expect(
        classifyTrigger({
          action: { ...navigate, url },
          facts: facts(),
          seenDomains: ['linear.app'],
        }),
      ).toEqual({ kind: 'review', reasons: ['explicit navigation requires review'] });
    }

    const newDomain = classifyTrigger({
      action: { ...navigate, url: 'https://example.co.uk' },
      facts: facts(),
      seenDomains: ['linear.app'],
    });
    expect(newDomain).toEqual({
      kind: 'review',
      reasons: [
        'explicit navigation requires review',
        'navigation enters new domain example.co.uk',
      ],
    });
  });
});
