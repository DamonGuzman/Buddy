import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMacSigningIdentity } from '../build/mac-sign.mjs';

const identity = '639CFE59234EB2C1EDEE876A5C2EAE8BA3DBD699';

describe('macOS exact-identity signing hook', () => {
  it('preserves the exact fingerprint resolved by electron-builder', () => {
    expect(resolveMacSigningIdentity({ identity }, {})).toBe(identity);
  });

  it('accepts a matching explicit release identity pin', () => {
    expect(
      resolveMacSigningIdentity(
        { identity: identity.toLowerCase() },
        { BUDDY_MAC_SIGNING_IDENTITY_SHA1: identity },
      ),
    ).toBe(identity);
  });

  it('fails closed when the explicit identity pin does not match discovery', () => {
    expect(() =>
      resolveMacSigningIdentity(
        { identity },
        { BUDDY_MAC_SIGNING_IDENTITY_SHA1: '6EE1F2B30129A95D0A9F0E61058CBA44443C3D9B' },
      ),
    ).toThrow(/does not match/);
  });

  it('rejects display names so duplicate certificates cannot become ambiguous', () => {
    expect(() =>
      resolveMacSigningIdentity(
        { identity: 'Developer ID Application: Happy Hearth, Inc. (6Z62PSX9UW)' },
        {},
      ),
    ).toThrow(/non-fingerprint/);
  });

  it('retains ad-hoc signing only behind the existing explicit QA escape hatch', () => {
    expect(resolveMacSigningIdentity({}, { BUDDY_ALLOW_ADHOC: '1' })).toBeNull();
    expect(() => resolveMacSigningIdentity({}, {})).toThrow(/did not resolve/);
  });

  it("is configured as electron-builder's project-owned macOS signer", () => {
    const config = readFileSync(join(import.meta.dirname, '..', 'electron-builder.yml'), 'utf8');
    expect(config).toContain('sign: build/mac-sign.mjs');
  });
});
