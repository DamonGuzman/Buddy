import * as nodeFs from 'node:fs';

/**
 * Exact host-filesystem semantics for the execution subsystem.
 *
 * Electron patches `node:fs` so ASAR archives behave like virtual directories. That is useful for
 * loading application resources, but it corrupts snapshot, publication, rollback, and cleanup
 * semantics when a user-selected folder contains an Electron app. Keep the entire transaction
 * boundary on Electron's unpatched built-in instead of mixing virtual and real path behavior.
 */
function resolveHostFilesystem(): typeof nodeFs {
  if (!process.versions.electron) return nodeFs;
  const original = process.getBuiltinModule('original-fs') as typeof nodeFs | undefined;
  if (!original) throw new Error('Electron original-fs is unavailable');
  return original;
}

export const hostFs = resolveHostFilesystem();
export const hostFsPromises = hostFs.promises;
