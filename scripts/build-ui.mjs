#!/usr/bin/env node
// Builds the desktop UI with no bundler: generate tokens.css from tokens.ts, then tsc → dist.
// Works offline (tsc is the only tool). Run: node scripts/build-ui.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const ui = resolve(root, 'apps/desktop/ui');

// tokens.ts has no imports, so import it directly for the CSS (strip types via the loader at runtime).
const { tokensCss } = await import(pathToFileURL(resolve(ui, 'src/tokens.ts')).href);
mkdirSync(resolve(ui, 'public'), { recursive: true });
writeFileSync(resolve(ui, 'public/tokens.css'), tokensCss());

execFileSync('tsc', ['-p', resolve(ui, 'tsconfig.json')], { stdio: 'inherit', cwd: root });

// dist/ holds the compiled JS; the HTML loads ./dist/main.js and the generated ./tokens.css,
// so the whole UI is served as static files by Tauri (or the Core's static server for previews).
console.log('UI built:', resolve(ui, 'dist'), 'and public/tokens.css');
void dirname;
