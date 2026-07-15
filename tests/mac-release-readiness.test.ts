import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateMacReleaseReadiness } from '../build/mac-release-readiness.mjs';

const developerId = '1) ABCDEF1234 "Developer ID Application: Fastyr, Inc. (ABCDE12345)"';

describe('macOS production release preflight', () => {
  it('accepts an installed Developer ID plus App Store Connect API credentials', () => {
    expect(() =>
      validateMacReleaseReadiness(
        {
          APPLE_API_KEY: 'encoded-key',
          APPLE_API_KEY_ID: 'KEY123',
          APPLE_API_ISSUER: 'issuer-id',
        },
        developerId,
      ),
    ).not.toThrow();
  });

  it('accepts certificate input plus a notarytool keychain profile', () => {
    expect(() =>
      validateMacReleaseReadiness(
        { CSC_LINK: 'encoded-p12', APPLE_KEYCHAIN_PROFILE: 'buddy-notary' },
        '0 valid identities found',
      ),
    ).not.toThrow();
  });

  it('rejects missing or partial production credentials with actionable details', () => {
    expect(() =>
      validateMacReleaseReadiness(
        { APPLE_ID: 'release@example.com' },
        '0 valid identities found',
      ),
    ).toThrow(/no Developer ID Application certificate.*incomplete notarization credentials: Apple ID/s);
  });

  it('never permits the disposable ad-hoc escape hatch in a release', () => {
    expect(() =>
      validateMacReleaseReadiness(
        { BUDDY_ALLOW_ADHOC: '1', CSC_NAME: 'Developer ID', APPLE_KEYCHAIN_PROFILE: 'notary' },
        '',
      ),
    ).toThrow(/BUDDY_ALLOW_ADHOC must not be enabled/);
  });

  it('keeps the library-validation exception out of production entitlements', () => {
    const root = join(import.meta.dirname, '..', 'build');
    const production = readFileSync(join(root, 'entitlements.mac.plist'), 'utf8');
    const disposable = readFileSync(join(root, 'entitlements.mac.adhoc.plist'), 'utf8');
    expect(production).not.toContain('com.apple.security.cs.disable-library-validation');
    expect(disposable).toContain('com.apple.security.cs.disable-library-validation');
  });
});
