#!/usr/bin/env node
// Stage everything `tauri build` bundles into apps/desktop/src-tauri:
//   - the UI at apps/desktop/ui/www (Tauri frontendDist), and
//   - a self-contained, symlink-free copy of the Core at src-tauri/resources/core.
//
// The Core is COMPILED to JavaScript (not shipped as .ts): Node refuses to strip TypeScript types
// for files under node_modules, so the bundled @feroxes/* packages must be real .js. The Node
// runtime (src-tauri/resources/runtime) is added per-platform by CI; locally the app falls back to
// `node` on PATH. Run: node scripts/build-desktop.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTsc } from './build-ui.mjs';

const root = resolve(import.meta.dirname, '..');
const srcTauri = resolve(root, 'apps/desktop/src-tauri');
const resources = resolve(srcTauri, 'resources');
const coreOut = resolve(resources, 'core');
const runtimeOut = resolve(resources, 'runtime');
const dist = resolve(root, 'build/core-dist');
const copy = (from, to) => cpSync(from, to, { recursive: true, dereference: true });

// Rewrite a package.json for the compiled tree: .ts entry points become .js, and type:module is
// kept so Node loads the emitted ES modules correctly.
function stagePackageJson(fromPkg, toPkg) {
  const pkg = JSON.parse(readFileSync(fromPkg, 'utf8'));
  const toJs = (v) => (typeof v === 'string' ? v.replace(/\.ts$/, '.js') : v);
  const mapStrings = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toJs(v)])) : toJs(o));
  if (pkg.exports !== undefined) pkg.exports = mapStrings(pkg.exports);
  if (pkg.bin !== undefined) pkg.bin = mapStrings(pkg.bin);
  if (pkg.main !== undefined) pkg.main = toJs(pkg.main);
  pkg.type ||= 'module';
  mkdirSync(resolve(toPkg, '..'), { recursive: true });
  writeFileSync(toPkg, `${JSON.stringify(pkg, null, 2)}\n`);
}

// 1. Build + assemble the UI (also the Tauri frontendDist at apps/desktop/ui/www).
execFileSync(process.execPath, [resolve(root, 'scripts/build-ui.mjs')], { stdio: 'inherit', cwd: root });

// 2. Compile the Core (packages + apps/core) to JavaScript, preserving the workspace layout.
rmSync(dist, { recursive: true, force: true });
runTsc(['-p', resolve(root, 'tsconfig.dist.json')]);

// 3. Assemble the self-contained Core: the core app plus every @feroxes/* package as real .js
//    directories under node_modules, plus the single third-party runtime dep (zod).
rmSync(coreOut, { recursive: true, force: true });
mkdirSync(coreOut, { recursive: true });
stagePackageJson(resolve(root, 'apps/core/package.json'), resolve(coreOut, 'package.json'));
copy(resolve(dist, 'apps/core/src'), resolve(coreOut, 'src'));

for (const name of readdirSync(resolve(root, 'packages'))) {
  const fromPkg = resolve(root, 'packages', name, 'package.json');
  if (!existsSync(fromPkg)) continue;
  const scoped = JSON.parse(readFileSync(fromPkg, 'utf8')).name; // e.g. @feroxes/brain
  const dest = resolve(coreOut, 'node_modules', ...scoped.split('/'));
  stagePackageJson(fromPkg, resolve(dest, 'package.json'));
  copy(resolve(dist, 'packages', name, 'src'), resolve(dest, 'src'));
}

const zod = resolve(root, 'node_modules/zod');
if (!existsSync(zod)) throw new Error('node_modules/zod not found — run `pnpm install` (or link-local with offline deps) first.');
copy(zod, resolve(coreOut, 'node_modules/zod'));

// 4. Make sure the runtime dir exists so the Tauri resource mapping always resolves. CI drops the
//    platform Node binary (node / node.exe) here for a self-contained installer.
mkdirSync(runtimeOut, { recursive: true });
const note = resolve(runtimeOut, 'README.txt');
if (!existsSync(note)) writeFileSync(note, 'CI places the platform Node binary here (node or node.exe).\nIf this dir has no binary, the installed app uses `node` from PATH.\n');

console.log('Staged desktop resources at', resources);
