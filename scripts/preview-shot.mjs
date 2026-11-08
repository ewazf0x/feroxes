#!/usr/bin/env node
// Preview-only: writes Playwright snippets (for the Playwright MCP) that render the demo UI, go to
// a screen, set a theme and optionally open an integration drawer; and a sweep snippet that visits
// every screen in both themes and reports layout problems (horizontal overflow, clipped text,
// overlapping cards) and console errors. Run scripts/bundle-preview.mjs first.
//   node scripts/preview-shot.mjs <name> <screen> <dark|light> [drawer-id]
//   node scripts/preview-shot.mjs sweep
import { readFileSync, writeFileSync } from 'node:fs';

const shots = '/projects/sandbox/.kiro/artifacts/screenshots';
const run = readFileSync(`${shots}/preview-run.js`, 'utf8');
const html = JSON.parse(run.match(/const html = (".*?");\n/s)[1]);
const [name, screen = 'today', theme = 'dark', drawer] = process.argv.slice(2);

const nav = `async function go(page, id) {
  await page.evaluate((id) => { const a = [...document.querySelectorAll('.nav-item')].find((n) => (n.getAttribute('href') || '') === '#' + id); a && a.click(); }, id);
  await page.waitForTimeout(450);
}
async function theme(page, t) { await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), t); await page.waitForTimeout(80); }`;

const checks = `() => {
  const vw = document.documentElement.clientWidth;
  const overflowX = document.documentElement.scrollWidth > vw + 1;
  const clipped = [...document.querySelectorAll('.card strong, .card .faint, .page-title, .nav-item span, .pill, .btn')].filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'hidden' && getComputedStyle(e).textOverflow !== 'ellipsis').length;
  const outside = [...document.querySelectorAll('.card, .btn, .pill')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); }).length;
  const cards = [...document.querySelectorAll('.card-grid > .card')].map((e) => e.getBoundingClientRect());
  let overlaps = 0;
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) { const a = cards[i], b = cards[j]; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++; }
  return { title: (document.querySelector('.page-title') || {}).textContent || '', cards: document.querySelectorAll('.card').length, overflowX, clipped, outside, overlaps };
}`;

let body;
if (name === 'sweep') {
  body = `const out = [];
  for (const t of ['dark', 'light']) {
    await theme(page, t);
    for (const id of ['today', 'chat', 'mind', 'memory', 'goals', 'devices', 'integrations', 'usage', 'settings']) {
      for (const w of [1280, 900]) { await page.setViewportSize({ width: w, height: 820 }); await go(page, id); out.push({ theme: t, width: w, screen: id, ...(await page.evaluate(${checks})) }); }
    }
  }
  await page.setViewportSize({ width: 1280, height: 820 });
  return JSON.stringify({ errs, titles: [...new Set(out.map((r) => r.screen + '=' + r.title))], problems: out.filter((r) => r.overflowX || r.clipped || r.outside || r.overlaps), screens: out.length });`;
} else {
  body = `await page.setViewportSize({ width: 1280, height: 820 });
  await theme(page, ${JSON.stringify(theme)});
  await go(page, ${JSON.stringify(screen)});
  ${drawer ? `await page.evaluate((id) => { const t = [...document.querySelectorAll('.integ-tile')].find((b) => b.querySelector('.logo-' + id)); t && t.click(); }, ${JSON.stringify(drawer)}); await page.waitForTimeout(500);` : ''}
  return JSON.stringify({ errs, ...(await page.evaluate(${checks})) });`;
}

const snippet = `async (page) => {
  const html = ${JSON.stringify(html)};
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  ${nav.replace(/\n/g, '\n  ')}
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  ${body}
}`;
writeFileSync(`${shots}/shot-${name}.js`, snippet);
console.log(`wrote ${shots}/shot-${name}.js`);
