import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { InMemoryDocStore } from '@feroxes/brain';
import { loadEnv } from './config.ts';
import { createFeroxes } from './container.ts';
import { SecretStore, Vault, VaultError, loadVault } from './vault.ts';

test('loadVault creates one master key file (0600) and reuses it; env wins; :memory: writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-vault-'));
  try {
    const a = loadVault({}, dir);
    assert.equal(a.source, 'file');
    const keyFile = join(dir, 'master.key');
    if (process.platform !== 'win32') assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    const sealed = a.vault.seal('hello', 'p');
    assert.equal(loadVault({}, dir).vault.open(sealed, 'p'), 'hello', 'the same key is reused on the next start');
    assert.equal(loadVault({ FEROXES_MASTER_KEY: Vault.generateKey() }, dir).source, 'env');
    const eph = mkdtempSync(join(tmpdir(), 'fx-vault-eph-'));
    assert.equal(loadVault({}, eph, { ephemeral: true }).source, 'ephemeral');
    assert.throws(() => readFileSync(join(eph, 'master.key')), /ENOENT/);
    rmSync(eph, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SecretStore keeps only ciphertext, binds it to the name, and refuses a wrong master key', () => {
  const docs = new InMemoryDocStore();
  const store = new SecretStore(new Vault({ 1: Vault.generateKey() }, 1), docs);
  store.put('connector:github:acct1:access', 'ghp_supersecretvalue1234567890');
  assert.equal(store.get('connector:github:acct1:access'), 'ghp_supersecretvalue1234567890');
  assert.ok(!JSON.stringify(docs.list('vault')).includes('supersecret'), 'plaintext must never be stored');
  // A ciphertext moved to another name can't be opened.
  const moved = docs.get<{ id: string; sealed: unknown }>('vault', 'connector:github:acct1:access')!;
  docs.put('vault', { ...moved, id: 'connector:github:acct2:access' });
  assert.throws(() => store.get('connector:github:acct2:access'), VaultError);
  // Another master key can't open it either.
  const other = new SecretStore(new Vault({ 1: Vault.generateKey() }, 1), docs);
  assert.throws(() => other.get('connector:github:acct1:access'), /can't open/);
  store.put('connector:github:acct1:refresh', 'r');
  assert.equal(store.deletePrefix('connector:github:acct1:'), 2);
  assert.equal(store.get('connector:github:acct1:refresh'), undefined);
});

test('the device signing key is sealed in the database, never stored in plaintext', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-devkey-'));
  try {
    const env = loadEnv({ FEROXES_DATA_DIR: join(dir, 'data'), FEROXES_WORKSPACE_DIR: join(dir, 'ws') });
    const fx = await createFeroxes(env);
    const pkcs8 = fx.hub.exportSigningKey();
    const publicKey = fx.hub.publicKey();
    await fx.shutdown();
    const db = new DatabaseSync(join(dir, 'data', 'feroxes.db'));
    const rows = db.prepare('SELECT kind, data FROM docs').all() as { kind: string; data: string }[];
    db.close();
    assert.ok(rows.some((r) => r.kind === 'vault'), 'a sealed vault record exists');
    assert.ok(!rows.some((r) => r.data.includes(pkcs8)), 'the private key is not in the database in plaintext');
    const again = await createFeroxes(env);
    assert.equal(again.hub.publicKey(), publicKey, 'paired devices keep working after a restart (same key)');
    await again.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
