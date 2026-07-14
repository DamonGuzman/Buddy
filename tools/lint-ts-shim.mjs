// The project builds with TypeScript 7 (native compiler), which typescript-eslint cannot load.
// This postinstall shim links a TypeScript 5.9 copy (installed under the `tseslint-ts` alias)
// into node_modules/@typescript-eslint/node_modules/typescript so every @typescript-eslint
// package resolves it before the root TS 7 install. Delete when typescript-eslint supports TS 7.
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules', 'tseslint-ts');

if (!existsSync(source)) {
  console.warn('[lint-ts-shim] tseslint-ts alias package not installed; skipping');
  process.exit(0);
}

// Every package in the lint toolchain that does require('typescript').
const hosts = ['@typescript-eslint', 'ts-api-utils'];
for (const host of hosts) {
  if (!existsSync(resolve(root, 'node_modules', host))) {
    console.warn(`[lint-ts-shim] ${host} not installed; skipping`);
    continue;
  }
  const targetDir = resolve(root, 'node_modules', host, 'node_modules');
  const target = resolve(targetDir, 'typescript');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  // 'junction' works without elevation on Windows and degrades to a dir symlink elsewhere.
  symlinkSync(source, target, 'junction');
}
console.log('[lint-ts-shim] linked TypeScript 5.9 for the lint toolchain');
