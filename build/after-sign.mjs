/** electron-builder hook: do not silently publish a macOS build that loses TCC grants. */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const verification = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { encoding: 'utf8' },
  );
  if (verification.status !== 0) {
    throw new Error(
      formatFailure(`code-signature verification failed for ${appPath}`, verification),
    );
  }

  const inspection = spawnSync(
    '/usr/bin/codesign',
    ['--display', '--verbose=4', '--requirements', '-', appPath],
    { encoding: 'utf8' },
  );
  if (inspection.status !== 0) {
    throw new Error(
      formatFailure(`could not inspect the code signature for ${appPath}`, inspection),
    );
  }

  const detail = [inspection.stdout, inspection.stderr].filter(Boolean).join('\n');
  const adHoc = /^Signature=adhoc$/m.test(detail) || /^# designated => cdhash /m.test(detail);
  if (!adHoc) {
    if (!hasHardenedRuntime(detail)) {
      throw new Error(`the hardened runtime is not enabled for ${appPath}`);
    }
    const entitlements = spawnSync(
      '/usr/bin/codesign',
      ['--display', '--entitlements', ':-', appPath],
      { encoding: 'utf8' },
    );
    if (entitlements.status !== 0) {
      throw new Error(formatFailure(`could not inspect entitlements for ${appPath}`, entitlements));
    }
    const entitlementDetail = [entitlements.stdout, entitlements.stderr].filter(Boolean).join('\n');
    for (const required of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.device.audio-input',
    ]) {
      if (!entitlementDetail.includes(`<key>${required}</key>`)) {
        throw new Error(`required entitlement ${required} is missing from ${appPath}`);
      }
    }
    const authority = detail.match(/^Authority=(.+)$/m)?.[1] ?? 'stable identity';
    console.log(`[after-sign] verified stable macOS identity: ${authority}`);
    return;
  }

  const explanation =
    'Buddy is only ad-hoc signed. macOS binds microphone, Accessibility, Input Monitoring, ' +
    'and Screen Recording grants to the exact code identity, so replacing this build would make ' +
    'existing allowed-looking toggles stale. Configure a valid Apple Development or Developer ID ' +
    'Application certificate (CSC_NAME or CSC_LINK). For disposable local QA only, explicitly set ' +
    'BUDDY_ALLOW_ADHOC=1 and expect to re-grant permissions after every replacement.';

  if (process.env.BUDDY_ALLOW_ADHOC === '1') {
    console.warn(`[after-sign] ${explanation}`);
    return;
  }
  throw new Error(explanation);
}

/** codesign prefixes the flags field with CodeDirectory metadata on current macOS. */
export function hasHardenedRuntime(detail) {
  return /(?:^|\s)flags=[^\r\n]*\bruntime\b/m.test(detail);
}

function formatFailure(message, result) {
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return `${message}${detail ? `:\n${detail}` : ''}`;
}
