/** Pure release-credential validation, split out so CI can test it without secrets. */

const complete = (env, names) => names.every((name) => Boolean(env[name]?.trim()));
const present = (env, names) => names.some((name) => Boolean(env[name]?.trim()));

const API_KEY_FIELDS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const APPLE_ID_FIELDS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

export function validateMacReleaseReadiness(env, codeSigningIdentities) {
  const failures = [];
  if (env.BUDDY_ALLOW_ADHOC === '1') {
    failures.push('BUDDY_ALLOW_ADHOC must not be enabled for a production release');
  }

  const hasCertificateInput = Boolean(env.CSC_LINK?.trim() || env.CSC_NAME?.trim());
  const hasInstalledDeveloperId = /Developer ID Application:/m.test(codeSigningIdentities);
  if (!hasCertificateInput && !hasInstalledDeveloperId) {
    failures.push(
      'no Developer ID Application certificate is available (set CSC_LINK/CSC_NAME or install one)',
    );
  }

  const hasApiKey = complete(env, API_KEY_FIELDS);
  const hasAppleId = complete(env, APPLE_ID_FIELDS);
  const hasKeychainProfile = Boolean(env.APPLE_KEYCHAIN_PROFILE?.trim());
  if (!hasApiKey && !hasAppleId && !hasKeychainProfile) {
    const partial = [];
    if (present(env, API_KEY_FIELDS)) partial.push('App Store Connect API key');
    if (present(env, APPLE_ID_FIELDS)) partial.push('Apple ID');
    failures.push(
      partial.length > 0
        ? `incomplete notarization credentials: ${partial.join(' and ')}`
        : 'no notarization credentials are configured',
    );
  }

  if (failures.length > 0) {
    throw new Error(`macOS release preflight failed:\n- ${failures.join('\n- ')}`);
  }
}
