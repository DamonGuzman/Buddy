import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
]);
const EXCLUDED_FILE_NAMES = new Set(['package-lock.json', 'tsconfig.node.tsbuildinfo']);
const EXTENSIONLESS_TEXT_FILES = new Set(['.gitignore', '.prettierignore', 'LICENSE']);
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.css',
  '.cs',
  '.html',
  '.js',
  '.json',
  '.md',
  '.m',
  '.mjs',
  '.mts',
  '.plist',
  '.ps1',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

interface RepositoryInventory {
  paths: string[];
  textFiles: string[];
}

function repositoryInventory(directory: string): RepositoryInventory {
  const inventory: RepositoryInventory = { paths: [], textFiles: [] };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const repoPath = relative(REPO_ROOT, path);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name) && repoPath !== 'eval/results') {
        inventory.paths.push(repoPath);
        const nested = repositoryInventory(path);
        inventory.paths.push(...nested.paths);
        inventory.textFiles.push(...nested.textFiles);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    inventory.paths.push(repoPath);
    if (
      !EXCLUDED_FILE_NAMES.has(entry.name) &&
      (TEXT_EXTENSIONS.has(extname(entry.name)) || EXTENSIONLESS_TEXT_FILES.has(entry.name))
    ) {
      inventory.textFiles.push(path);
    }
  }
  return inventory;
}

describe('helper buddy terminology', () => {
  it('keeps the reserved future role absent from code, contracts, docs, tests, and tooling', () => {
    const left = 'sub';
    const right = 'agent';
    const reservedForms = [
      left + right,
      `${left}-${right}`,
      `${left}_${right}`,
      `${left} ${right}`,
    ];
    const inventory = repositoryInventory(REPO_ROOT);
    const violations: string[] = [];

    for (const repoPath of inventory.paths) {
      const loweredPath = repoPath.toLowerCase();
      if (reservedForms.some((reserved) => loweredPath.includes(reserved))) {
        violations.push(`${repoPath}: contains reserved future terminology`);
      }
    }

    for (const file of inventory.textFiles) {
      const repoPath = relative(REPO_ROOT, file);
      const content = readFileSync(file, 'utf8').toLowerCase();
      for (const reserved of reservedForms) {
        if (content.includes(reserved)) {
          violations.push(`${repoPath}: contains reserved future terminology`);
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('covers automation, packaging, evaluation, and root configuration surfaces', () => {
    const paths = new Set(
      repositoryInventory(REPO_ROOT).textFiles.map((file) => relative(REPO_ROOT, file)),
    );

    expect([...paths]).toEqual(
      expect.arrayContaining([
        '.github/workflows/ci.yml',
        'build/after-pack.mjs',
        'build/macos-native.m',
        'eval/run.mjs',
        'electron-builder.yml',
        'tsconfig.base.json',
        'vitest.config.ts',
      ]),
    );
  });
});
