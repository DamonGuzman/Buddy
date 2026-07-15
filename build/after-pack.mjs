/** electron-builder hook: give otherwise-unsigned macOS builds a valid provisional seal. */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const cleaned = spawnSync('/usr/bin/xattr', ['-cr', appPath], { encoding: 'utf8' });
  if (cleaned.status !== 0) {
    const detail = [cleaned.stdout, cleaned.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`clearing extended attributes from ${appPath} failed${detail ? `:\n${detail}` : ''}`);
  }
  const result = spawnSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--timestamp=none',
      '--options',
      'runtime',
      '--entitlements',
      join(import.meta.dirname, 'entitlements.mac.adhoc.plist'),
      appPath,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`ad-hoc signing ${appPath} failed${detail ? `:\n${detail}` : ''}`);
  }
  console.log(`[after-pack] ad-hoc signed ${appPath}`);
  console.log('[after-pack] the after-sign hook will require a stable final identity');
}
