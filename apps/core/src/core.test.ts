import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCatalog } from './catalog.ts';
import { loadEnv } from './config.ts';
import { Vault, hashPassword, verifyPassword } from './vault.ts';

test('vault: seal/open round trip, purpose binding, tamper detection, key rotation', () => {
  const k1 = Vault.generateKey();
  const vault = new Vault({ 1: k1 }, 1);
  const sealed = vault.seal('sk-ant-secret', 'provider:anthropic');
  assert.equal(vault.open(sealed, 'provider:anthropic'), 'sk-ant-secret');
  assert.ok(!JSON.stringify(sealed).includes('secret'));
  assert.throws(() => vault.open(sealed, 'provider:openai'), 'a ciphertext cannot be moved to another record');
  const tampered = { ...sealed, data: Buffer.from('x' + Buffer.from(sealed.data, 'base64').toString('latin1').slice(1), 'latin1').toString('base64') };
  assert.throws(() => vault.open(tampered, 'provider:anthropic'));

  const k2 = Vault.generateKey();
  const rotated = new Vault({ 1: k1, 2: k2 }, 2);
  const resealed = rotated.reseal(sealed, 'provider:anthropic');
  assert.equal(resealed.v, 2);
  assert.equal(rotated.open(resealed, 'provider:anthropic'), 'sk-ant-secret');
  assert.throws(() => new Vault({ 1: 'c2hvcnQ=' }, 1), /32 bytes/);
});

test('owner password: argon2id hash verifies, wrong password fails, short passwords refused', async () => {
  const phc = await hashPassword('correct horse battery staple');
  assert.match(phc, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.equal(await verifyPassword('correct horse battery staple', phc), true);
  assert.equal(await verifyPassword('wrong password here', phc), false);
  await assert.rejects(hashPassword('short'), /12 characters/);
});

test('kiro is the main brain: first in the reasoning tiers, API models fall back, utility stays cheap', () => {
  const c = resolveCatalog(loadEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', KIRO_API_KEY: 'kiro-key' }));
  assert.ok(c.providers.some((p) => p.id === 'kiro' && p.kind === 'kiro'));
  assert.equal(c.tiers.frontier?.[0], 'kiro/frontier', 'Kiro tried first at frontier');
  assert.equal(c.tiers.balanced?.[0], 'kiro/balanced', 'Kiro tried first at balanced');
  assert.ok(c.tiers.frontier?.includes('anthropic/claude-opus-5.5'), 'API models remain as fallback');
  assert.ok(!c.tiers.fast?.some((m) => m.startsWith('kiro/')), 'fast utility tier stays on cheap APIs by default');
  assert.equal(c.routes.find((r) => r.id === 'chat.turn')?.tier, 'balanced', 'conversation is floored to the Kiro tier');
  assert.ok(c.prices.some((p) => p.modelId === 'kiro/balanced' && p.inputPerMTok === 0), 'Kiro billed as credits, $0 in the token ledger');
  // Scope "all" also puts Kiro in the fast tier.
  const all = resolveCatalog(loadEnv({ ANTHROPIC_API_KEY: 'a', KIRO_API_KEY: 'k', FEROXES_KIRO_SCOPE: 'all' }));
  assert.equal(all.tiers.fast?.[0], 'kiro/fast');
  // Turned off when no key and login not allowed.
  assert.ok(!resolveCatalog(loadEnv({ ANTHROPIC_API_KEY: 'a' })).providers.some((p) => p.id === 'kiro'));
  // An existing kiro-cli login can enable it without a key.
  assert.ok(resolveCatalog(loadEnv({ ANTHROPIC_API_KEY: 'a', FEROXES_KIRO_USE_LOGIN: 'true' })).providers.some((p) => p.id === 'kiro'));
});

test('catalog: only providers with keys are enabled; free-tier Gemini may not receive private data', () => {
  const env = loadEnv({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'o' });
  const c = resolveCatalog(env);
  assert.deepEqual(c.providers.map((p) => p.id), ['anthropic', 'google', 'openrouter']);
  assert.equal(c.providers.find((p) => p.id === 'google')?.maxSensitivity, 'normal');
  assert.deepEqual(c.tiers.balanced, ['anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash', 'openrouter/anthropic/claude-sonnet-5.5']);
  assert.ok(!c.models.some((m) => m.providerId === 'openai'));
  const paid = resolveCatalog(loadEnv({ GEMINI_API_KEY: 'g', GEMINI_TIER: 'paid' }));
  assert.equal(paid.providers[0]?.maxSensitivity, 'private');
  assert.throws(() => loadEnv({ FEROXES_TIMEZONE: 'Mars/Olympus' }), /time zone/);
});
