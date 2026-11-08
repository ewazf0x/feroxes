#!/usr/bin/env node
// Preview-only bundler: turns the compiled dist/*.js ES modules + CSS into ONE self-contained
// classic-script HTML, so it can be opened via file:// for screenshots without a server.
// This is NOT the shipping build (Tauri serves the real ES modules); it's only for visual checks.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ui = resolve(import.meta.dirname, '../apps/desktop/ui');
const dist = resolve(ui, 'dist');

function transform(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export (?:const|let|var|function|async function|class) (\w+)/gm)) names.add(m[1]);
  let out = src
    .replace("new URLSearchParams(location.search).has('demo')", 'true') // preview is always demo mode
    .replace(/^import\s+\{([^}]*)\}\s+from\s+'\.\/([\w.-]+)\.js';?/gm, (_m, spec, mod) => {
      const binds = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/(\w+)\s+as\s+(\w+)/, '$1: $2')).join(', ');
      return `const { ${binds} } = __require('${mod}');`;
    })
    .replace(/^import\s+'\.\/([\w.-]+)\.js';?/gm, (_m, mod) => `__require('${mod}');`)
    .replace(/import\('\.\/([\w.-]+)\.js'\)/g, (_m, mod) => `Promise.resolve(__require('${mod}'))`)
    .replace(/^export\s+(const|let|var|function|async function|class)\s/gm, '$1 ')
    .replace(/^export\s+type\s+.*$/gm, '')
    .replace(/^export\s*\{\s*\};?\s*$/gm, '')
    .replace(/^export\s*\{([^}]+)\}\s*;?\s*$/gm, (_m, listStr) =>
      listStr.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [a, b] = s.split(/\s+as\s+/); return `__exports.${b || a} = ${a};`; }).join('\n'));
  if (names.size) out += `\n${[...names].map((n) => `__exports.${n} = typeof ${n} !== 'undefined' ? ${n} : undefined;`).join('\n')}\n`;
  return out;
}

const modules = readdirSync(dist).filter((f) => f.endsWith('.js'));
const factories = modules.map((f) => {
  const key = f.replace(/\.js$/, '');
  return `  '${key}': function(__exports, __require) {\n${transform(readFileSync(resolve(dist, f), 'utf8'))}\n}`;
}).join(',\n');

const runtime = `
(function(){
  var __factories = {\n${factories}\n};
  var __cache = {};
  function __require(k){
    if (__cache[k]) return __cache[k].exports;
    var mod = __cache[k] = { exports: {} };
    __factories[k](mod.exports, __require);
    return mod.exports;
  }
  __require('main');
})();`;

const css = readFileSync(resolve(ui, 'public/tokens.css'), 'utf8') + '\n' + readFileSync(resolve(ui, 'public/styles.css'), 'utf8');
const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Feroxes preview</title><style>${css}</style></head><body><div id="app"></div><script>${runtime}</script></body></html>`;
writeFileSync('/tmp/preview.html', html);
console.log('wrote /tmp/preview.html', html.length, 'bytes,', modules.length, 'modules');

// Also emit a Playwright snippet (HTML embedded as a JS string) into the MCP's allowed dir,
// so the browser can render it without fs access, a server, or file:// — for screenshots only.
import { mkdirSync } from 'node:fs';
const shots = '/projects/sandbox/.kiro/artifacts/screenshots';
mkdirSync(shots, { recursive: true });
const snippet = `async (page) => {\n  const html = ${JSON.stringify(html)};\n  const errs = [];\n  page.on('pageerror', (e) => errs.push(String(e)));\n  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });\n  await page.setContent(html, { waitUntil: 'load' });\n  await page.waitForTimeout(500);\n  const info = await page.evaluate(() => ({ nav: document.querySelectorAll('.nav-item').length, title: (document.querySelector('.page-title') || {}).textContent, cards: document.querySelectorAll('.card').length }));\n  return JSON.stringify({ info, errs });\n}`;
writeFileSync(`${shots}/preview-run.js`, snippet);
console.log('wrote', `${shots}/preview-run.js`);
