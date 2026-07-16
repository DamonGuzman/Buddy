import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { finished } from 'node:stream/promises';
import type { FilesystemChange } from '../../shared/types';
import { hostFs, hostFsPromises } from './host-fs';

const { constants, createReadStream } = hostFs;
const {
  chmod,
  chown,
  copyFile,
  lstat,
  lchown,
  mkdir,
  opendir,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
} = hostFsPromises;

export type ManifestEntry =
  | { type: 'directory'; mode: number; uid: number; gid: number }
  | { type: 'file'; mode: number; uid: number; gid: number; size: number; hash: string }
  | { type: 'symlink'; mode: number; uid: number; gid: number; target: string };

export type TreeManifest = Record<string, ManifestEntry>;

export interface InternalChange {
  path: string;
  before: ManifestEntry | null;
  after: ManifestEntry | null;
}

const ROOT_KEY = '.';

export async function buildManifest(root: string): Promise<TreeManifest> {
  const output: TreeManifest = {};
  await walk(root, ROOT_KEY, output);
  return output;
}

/**
 * Hash only explicitly staged roots and their ancestor directories. Missing roots are represented
 * by absence, which lets callers track new files without scanning the surrounding project.
 */
export async function buildSparseManifest(
  root: string,
  relativeRoots: readonly string[],
): Promise<TreeManifest> {
  const output: TreeManifest = { [ROOT_KEY]: await inspectEntry(root) };
  const roots = minimalRoots(relativeRoots);
  for (const relativeRoot of roots) {
    for (const ancestor of ancestors(relativeRoot)) {
      if (output[ancestor]) continue;
      const entry = await inspectEntryIfPresent(resolveInside(root, ancestor));
      if (entry) output[ancestor] = entry;
    }
    const absolute = resolveInside(root, relativeRoot);
    if (!(await exists(absolute))) continue;
    await walk(absolute, relativeRoot, output);
  }
  return output;
}

/** One exact entry without recursing into a directory. */
export async function inspectManifestEntry(path: string): Promise<ManifestEntry | null> {
  return inspectEntryIfPresent(path);
}

async function walk(absolutePath: string, key: string, output: TreeManifest): Promise<void> {
  const entry = await inspectEntry(absolutePath, key);
  output[key] = entry;
  if (entry.type !== 'directory') return;
  const dir = await opendir(absolutePath);
  const names: string[] = [];
  for await (const entry of dir) names.push(entry.name);
  names.sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const childKey = key === ROOT_KEY ? name : `${key}/${name}`;
    await walk(join(absolutePath, name), childKey, output);
  }
}

async function inspectEntry(absolutePath: string, key = absolutePath): Promise<ManifestEntry> {
  const info = await lstat(absolutePath);
  const mode = info.mode & 0o7777;
  if (info.isSymbolicLink()) {
    return {
      type: 'symlink',
      mode,
      uid: info.uid,
      gid: info.gid,
      target: await readlink(absolutePath),
    };
  }
  if (info.isFile()) {
    return {
      type: 'file',
      mode,
      uid: info.uid,
      gid: info.gid,
      size: info.size,
      hash: await hashFile(absolutePath),
    };
  }
  if (info.isDirectory()) return { type: 'directory', mode, uid: info.uid, gid: info.gid };
  throw new Error(`unsupported filesystem object at ${key}`);
}

async function inspectEntryIfPresent(path: string): Promise<ManifestEntry | null> {
  try {
    return await inspectEntry(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function minimalRoots(values: readonly string[]): string[] {
  const sorted = [...new Set(values)].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  return sorted.filter(
    (candidate, index) =>
      !sorted.some(
        (parent, parentIndex) =>
          parentIndex !== index &&
          depth(parent) < depth(candidate) &&
          candidate.startsWith(`${parent}/`),
      ),
  );
}

function ancestors(path: string): string[] {
  const parts = path.split('/');
  const output: string[] = [];
  for (let index = 1; index < parts.length; index += 1)
    output.push(parts.slice(0, index).join('/'));
  return output;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk: Buffer) => hash.update(chunk));
  await finished(stream);
  return hash.digest('hex');
}

export function entriesEqual(a: ManifestEntry | undefined, b: ManifestEntry | undefined): boolean {
  if (
    a === undefined ||
    b === undefined ||
    a.type !== b.type ||
    a.mode !== b.mode ||
    a.uid !== b.uid ||
    a.gid !== b.gid
  )
    return a === b;
  if (a.type === 'file' && b.type === 'file') return a.size === b.size && a.hash === b.hash;
  if (a.type === 'symlink' && b.type === 'symlink') return a.target === b.target;
  return a.type === 'directory' && b.type === 'directory';
}

export function manifestsEqual(a: TreeManifest, b: TreeManifest): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!entriesEqual(a[key], b[key])) return false;
  return true;
}

export function diffManifests(before: TreeManifest, after: TreeManifest): InternalChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete(ROOT_KEY);
  return [...keys]
    .filter((key) => !entriesEqual(before[key], after[key]))
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
}

export function rendererChanges(changes: InternalChange[]): FilesystemChange[] {
  return changes
    .filter((change) => {
      if (change.before === null) return change.after?.type !== 'directory';
      if (change.after === null) return change.before.type !== 'directory';
      return change.before.type !== 'directory' || change.after.type !== 'directory';
    })
    .map(({ path, before, after }) => ({
      path,
      kind: before === null ? 'created' : after === null ? 'deleted' : 'modified',
      ...(before?.type === 'file' ? { beforeBytes: before.size } : {}),
      ...(after?.type === 'file' ? { afterBytes: after.size } : {}),
    }));
}

/**
 * Reconcile targetRoot to desiredManifest using bytes from sourceRoot. Every path is sourced from
 * a manifest key produced by our own walker; resolveInside is still applied before each mutation.
 */
export async function applyManifest(
  sourceRoot: string,
  targetRoot: string,
  currentManifest: TreeManifest,
  desiredManifest: TreeManifest,
  transactionId: string,
): Promise<void> {
  const changed = diffManifests(currentManifest, desiredManifest);
  const removals = changed
    .filter(
      ({ before, after }) => before !== null && (after === null || before.type !== after.type),
    )
    .sort((a, b) => depth(b.path) - depth(a.path));
  for (const change of removals)
    await rm(resolveInside(targetRoot, change.path), { recursive: true });

  const directories = Object.entries(desiredManifest)
    .filter(
      (entry): entry is [string, Extract<ManifestEntry, { type: 'directory' }>] =>
        entry[1].type === 'directory',
    )
    .sort(([a], [b]) => depth(a) - depth(b));
  for (const [key, entry] of directories) {
    const target = key === ROOT_KEY ? targetRoot : resolveInside(targetRoot, key);
    await mkdir(target, { recursive: true, mode: entry.mode });
  }

  const writes = changed.filter(({ after }) => after !== null && after.type !== 'directory');
  for (const { path, after } of writes) {
    if (!after || after.type === 'directory') continue;
    const target = resolveInside(targetRoot, path);
    const source = resolveInside(sourceRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    if (after.type === 'symlink') {
      await symlink(after.target, target);
      await lchown(target, after.uid, after.gid);
      continue;
    }
    const temporary = join(dirname(target), `.${basename(target)}.buddy-${transactionId}.tmp`);
    await rm(temporary, { force: true });
    await copyFile(source, temporary, constants.COPYFILE_FICLONE);
    await chown(temporary, after.uid, after.gid);
    await chmod(temporary, after.mode);
    const sourceInfo = await lstat(source);
    await utimes(temporary, sourceInfo.atime, sourceInfo.mtime);
    await rename(temporary, target);
  }

  // Directory modes are applied last so restrictive modes do not block child publication.
  for (const [key, entry] of directories.sort(([a], [b]) => depth(b) - depth(a))) {
    const target = key === ROOT_KEY ? targetRoot : resolveInside(targetRoot, key);
    await chown(target, entry.uid, entry.gid);
    await chmod(target, entry.mode);
  }
}

export function resolveInside(root: string, relativePath: string): string {
  if (relativePath === ROOT_KEY || relativePath === '') return root;
  if (relativePath.includes('\0')) throw new Error('path contains a null byte');
  const candidate = resolve(root, relativePath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!candidate.startsWith(prefix))
    throw new Error(`path escapes the selected folder: ${relativePath}`);
  return candidate;
}

export function relativeInside(root: string, absolutePath: string): string {
  const value = relative(root, absolutePath);
  resolveInside(root, value);
  return value || ROOT_KEY;
}

function depth(path: string): number {
  return path === ROOT_KEY ? 0 : path.split('/').length;
}
