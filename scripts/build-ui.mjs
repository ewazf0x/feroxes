#!/usr/bin/env node
// Builds the desktop UI with no bundler, then assembles a single static root (ui/www) that both
// the desktop app (Tauri frontendDist) and the Core's static server can serve as-is:
//
//   www/index.html          loads ./tokens.css, ./styles.css, ./dist/main.js
//   www/tokens.css          generated from src/tokens.ts
//   www/styles.css          copied from public/
//   www/dist/*.js           tsc output (browser ES modules)
//
// Works offline (tsc is the only tool). Run: node scripts/build-ui.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const ui = resolve(root, 'apps/desktop/ui');
const www = resolve(ui, 'www');

// Run tsc without depending on PATH: prefer the locally installed TypeScript (via Node, so it works
// cross-platform and inside Tauri's beforeBuildCommand), and fall back to a global `tsc`.
export function runTsc(args, cwd = root) {
  const local = resolve(root, 'node_modules/typescript/bin/tsc');
  if (existsSync(local)) execFileSync(process.execPath, [local, ...args], { stdio: 'inherit', cwd });
  else execFileSync('tsc', args, { stdio: 'inherit', cwd });
}

export async function buildUi() {
  // tokens.ts has no imports, so import it directly for the CSS (the loader strips types at runtime).
  const { tokensCss } = await import(pathToFileURL(resolve(ui, 'src/tokens.ts')).href);
  mkdirSync(resolve(ui, 'public'), { recursive: true });
  writeFileSync(resolve(ui, 'public/tokens.css'), tokensCss());

  // Compile src/*.ts -> dist/*.js (browser ES modules). The HTML loads ./dist/main.js.
  runTsc(['-p', resolve(ui, 'tsconfig.json')]);

  // Assemble the static root. index.html and the two stylesheets sit at the root so the app's
  // relative links (./tokens.css, ./styles.css, ./dist/main.js) resolve under one directory.
  rmSync(www, { recursive: true, force: true });
  mkdirSync(www, { recursive: true });
  cpSync(resolve(ui, 'index.html'), resolve(www, 'index.html'));
  cpSync(resolve(ui, 'public/tokens.css'), resolve(www, 'tokens.css'));
  cpSync(resolve(ui, 'public/styles.css'), resolve(www, 'styles.css'));
  cpSync(resolve(ui, 'dist'), resolve(www, 'dist'), { recursive: true });
  console.log('UI built and assembled at', www);
}

// Run the build only when invoked directly (so build-desktop.mjs can import runTsc without it).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildUi();
