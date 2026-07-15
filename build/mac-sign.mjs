/**
 * electron-builder 26 resolves a macOS identity to its exact SHA-1 fingerprint,
 * then its default signing path discards that fingerprint and passes only the
 * certificate's display name to codesign. Duplicate certificate names make
 * that command ambiguous. Keep the already-resolved fingerprint intact.
 */

import { signAsync } from '@electron/osx-sign';

const SHA1 = /^[A-F0-9]{40}$/;

export function resolveMacSigningIdentity(options, env = process.env) {
  const discovered = options.identity?.trim().toUpperCase() ?? '';
  const pinned = env.BUDDY_MAC_SIGNING_IDENTITY_SHA1?.trim().toUpperCase() ?? '';

  if (pinned !== '' && !SHA1.test(pinned)) {
    throw new Error('BUDDY_MAC_SIGNING_IDENTITY_SHA1 must be an exact 40-character SHA-1 hash');
  }

  if (discovered === '') {
    if (env.BUDDY_ALLOW_ADHOC === '1') return null;
    throw new Error('electron-builder did not resolve an exact macOS signing identity');
  }
  if (!SHA1.test(discovered)) {
    throw new Error(`electron-builder returned a non-fingerprint macOS identity: ${discovered}`);
  }
  if (pinned !== '' && pinned !== discovered) {
    throw new Error(
      `resolved macOS signing identity ${discovered} does not match ` +
        `BUDDY_MAC_SIGNING_IDENTITY_SHA1 ${pinned}`,
    );
  }
  return discovered;
}

export default async function signMacApp(options) {
  const identity = resolveMacSigningIdentity(options);
  if (identity === null) {
    // afterPack already applied the explicit disposable ad-hoc signature.
    console.warn('[mac-sign] retaining explicitly allowed disposable ad-hoc signature');
    return;
  }
  await signAsync({ ...options, identity });
}
