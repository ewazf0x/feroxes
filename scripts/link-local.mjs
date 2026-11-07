#!/usr/bin/env node
// Offline workspace linker.
//
// `pnpm install` normally links workspace packages into node_modules/@feroxes/*.
// In sandboxes without registry access, this script does the same with symlinks,
// and can link third-party packages from an existing node_modules directory:
//
//   FEROXES_OFFLINE_DEPS=/path/to/node_modules node scripts/link-local.mjs
//
// It only creates symlinks inside ./node_modules (which is gitignored).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const nodeModules = join(root, 'node_modules');

function link(target, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath) || isSymlink(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(relative(dirname(linkPath), target), linkPath, 'dir');
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

let count = 0;
for (const group of ['packages', 'apps']) {
  const dir = join(root, group);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const pkgJson = join(dir, name, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    link(join(dir, name), join(nodeModules, ...pkg.name.split('/')));
    count++;
  }
}
console.log(`linked ${count} workspace packages`);

const offline = process.env.FEROXES_OFFLINE_DEPS;
if (offline) {
  for (const dep of ['@types/node', 'undici-types', 'zod']) {
    const src = join(offline, dep);
    if (!existsSync(src)) { console.warn(`missing offline dependency: ${dep}`); continue; }
    link(src, join(nodeModules, ...dep.split('/')));
    console.log(`linked offline dependency ${dep}`);
  }
}
