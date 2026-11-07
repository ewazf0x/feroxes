import { argon2, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secret vault (architecture §9.6): AES-256-GCM with a versioned master key. Provider keys and
 * OAuth tokens are stored as { v, iv, tag, data } and never logged or sent to a model.
 * The key id and the record's purpose are bound in as associated data, so a ciphertext can't be
 * moved to another record.
 */
export interface SealedSecret {
  v: number; // key version
  iv: string; // base64, 12 bytes
  tag: string; // base64, 16 bytes
  data: string; // base64
}

export class Vault {
  private readonly keys: Map<number, Buffer>;
  private readonly current: number;

  constructor(keys: Record<number, string>, currentVersion: number) {
    this.keys = new Map(Object.entries(keys).map(([v, b64]) => [Number(v), decodeKey(b64)]));
    if (!this.keys.has(currentVersion)) throw new Error(`master key version ${currentVersion} is missing`);
    this.current = currentVersion;
  }

  static fromEnv(env: NodeJS.ProcessEnv): Vault {
    const key = env.FEROXES_MASTER_KEY;
    if (!key) throw new Error('FEROXES_MASTER_KEY is not set. Generate one with: feroxes keygen');
    const keys: Record<number, string> = { 1: key };
    // During rotation, the previous key stays available for decryption.
    if (env.FEROXES_MASTER_KEY_PREVIOUS) keys[0] = env.FEROXES_MASTER_KEY_PREVIOUS;
    return new Vault(keys, 1);
  }

  static generateKey(): string {
    return randomBytes(32).toString('base64');
  }

  seal(plaintext: string, purpose: string): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.current)!, iv);
    cipher.setAAD(Buffer.from(`feroxes:v${this.current}:${purpose}`));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { v: this.current, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  open(sealed: SealedSecret, purpose: string): string {
    const key = this.keys.get(sealed.v);
    if (!key) throw new Error(`no master key for version ${sealed.v}`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(`feroxes:v${sealed.v}:${purpose}`));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  }

  /** Re-encrypts with the current key (used by key rotation). */
  reseal(sealed: SealedSecret, purpose: string): SealedSecret {
    return sealed.v === this.current ? sealed : this.seal(this.open(sealed, purpose), purpose);
  }
}

function decodeKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('master key must be 32 bytes, base64-encoded');
  return key;
}

// ---------- owner password (argon2id, built into Node ≥ 24.7) ----------

const ARGON = { parallelism: 1, tagLength: 32, memory: 64 * 1024, passes: 3 } as const;

function argon2Async(message: string, nonce: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => argon2('argon2id', { message, nonce, ...ARGON }, (err, hash) => (err ? reject(err) : resolve(hash))));
}

/** PHC-style string: $argon2id$v=19$m=65536,t=3,p=1$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Use at least 12 characters.');
  const salt = randomBytes(16);
  const hash = await argon2Async(password, salt);
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parts = phc.split('$');
  if (parts.length !== 6 || parts[1] !== 'argon2id') return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  const actual = await argon2Async(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
