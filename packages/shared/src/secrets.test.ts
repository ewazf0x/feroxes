import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJsonLogger, redact } from './logger.ts';
import { scrubSecrets } from './secrets.ts';

// Fake credentials with the documented shapes. None of these are real.
const FAKES = {
  openai: 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
  anthropic: 'sk-ant-api03-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1',
  github: 'ghp_' + 'a'.repeat(36),
  gitlab: 'glpat-' + 'b'.repeat(20),
  slack: 'xoxb-' + '1234567890-abcdefghijkl',
  google: 'ya29.' + 'c'.repeat(40),
  googleRefresh: '1//0' + 'd'.repeat(40),
  telegram: '123456789:AA' + 'e'.repeat(33),
  discord: 'M' + 'f'.repeat(25) + '.' + 'g'.repeat(6) + '.' + 'h'.repeat(30),
  meta: 'EAA' + 'i'.repeat(40),
  notion: 'ntn_' + 'j'.repeat(40),
  elevenlabs: 'sk_' + 'k1'.repeat(24),
};

test('scrubSecrets masks every documented token shape, in text, URLs and headers', () => {
  for (const [name, token] of Object.entries(FAKES)) {
    const out = scrubSecrets(`failed calling ${name} with ${token} (retry)`);
    assert.ok(!out.includes(token), `${name} token leaked: ${out}`);
    assert.match(out, /\[redacted\]/);
  }
  assert.equal(scrubSecrets('GET https://api.telegram.org/bot123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/sendMessage failed'), 'GET https://api.telegram.org/bot[redacted]/sendMessage failed');
  assert.equal(scrubSecrets('https://x.example/cb?state=abc&code=4/0AbCdEf123&x=1'), 'https://x.example/cb?state=abc&code=[redacted]&x=1');
  assert.equal(scrubSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'), 'Authorization: Bearer [redacted]');
});

test('scrubSecrets leaves ordinary ids, hashes and prose alone, and removes exact known values', () => {
  const ordinary = 'run 0190f3a2-7b1c-7d4e-9f00-112233445566 hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 is fine';
  assert.equal(scrubSecrets(ordinary), ordinary);
  assert.equal(scrubSecrets('the session key is s3cr3t-value-123', ['s3cr3t-value-123']), 'the session key is [redacted]');
});

test('logger redacts secret-named keys, child bindings and secrets inside messages', () => {
  const lines: string[] = [];
  const log = createJsonLogger({ write: (l) => lines.push(l), bindings: { token: 'abc' } }).child({ botToken: FAKES.telegram });
  log.info(`calling with ${FAKES.github}`, { client_secret: 'shh', nested: { refresh_token: 'r', note: `uses ${FAKES.slack}` }, code_verifier: 'v' });
  const raw = lines.join('\n');
  for (const leaked of [FAKES.github, FAKES.slack, FAKES.telegram, '"shh"', '"r"', '"v"', '"abc"']) assert.ok(!raw.includes(leaked), `leaked ${leaked}: ${raw}`);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.client_secret, '[redacted]');
  assert.equal(entry.botToken, '[redacted]');
  assert.equal(entry.token, '[redacted]');
});

test('redact never passes deep structures through unchecked', () => {
  let deep: Record<string, unknown> = { apiKey: 'x' };
  for (let i = 0; i < 10; i++) deep = { inner: deep };
  assert.ok(!JSON.stringify(redact(deep)).includes('"apiKey":"x"'));
});
