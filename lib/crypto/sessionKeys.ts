import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from 'node:fs/promises';
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedSessionContent {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

class SessionKeyError extends Error {
  constructor(message: 'Session key is unavailable' | 'Session key store is unavailable' | 'Session content encryption failed' | 'Session content decryption failed') {
    super(message);
    this.name = 'SessionKeyError';
  }
}

function validSessionId(sessionId: string): boolean {
  return sessionId.trim().length > 0;
}

function unavailableKey(): never {
  throw new SessionKeyError('Session key is unavailable');
}

function unavailableStore(): never {
  throw new SessionKeyError('Session key store is unavailable');
}

function encryptWithKey(key: Buffer, plaintext: string): EncryptedSessionContent {
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_BYTES });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext,
      nonce,
      authTag: cipher.getAuthTag(),
    };
  } catch {
    throw new SessionKeyError('Session content encryption failed');
  }
}

function decryptWithKey(key: Buffer, encrypted: EncryptedSessionContent): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, encrypted.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(encrypted.authTag);
    return Buffer.concat([
      decipher.update(encrypted.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SessionKeyError('Session content decryption failed');
  }
}

/**
 * Holds per-session data-encryption keys outside the database whose content they
 * protect. Database backups may contain ciphertext and its public envelope
 * fields, but never these keys.
 */
export class SessionKeyVault {
  readonly #keys = new Map<string, Buffer>();

  get size(): number {
    return this.#keys.size;
  }

  create(sessionId: string): void {
    if (!validSessionId(sessionId)) unavailableKey();
    if (!this.#keys.has(sessionId)) this.#keys.set(sessionId, randomBytes(KEY_BYTES));
  }

  has(sessionId: string): boolean {
    return validSessionId(sessionId) && this.#keys.has(sessionId);
  }

  encrypt(sessionId: string, plaintext: string): EncryptedSessionContent {
    const key = this.#keys.get(sessionId);
    if (!key) unavailableKey();
    return encryptWithKey(key, plaintext);
  }

  decrypt(sessionId: string, encrypted: EncryptedSessionContent): string {
    const key = this.#keys.get(sessionId);
    if (!key) unavailableKey();

    return decryptWithKey(key, encrypted);
  }

  destroy(sessionId: string): boolean {
    const key = this.#keys.get(sessionId);
    if (!key) return false;

    key.fill(0);
    return this.#keys.delete(sessionId);
  }
}

function ownerOnly(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function ownedByRuntimeUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

export class FileSessionKeyVault {
  readonly #directory: string;

  constructor(directory: string) {
    if (!path.isAbsolute(directory)) unavailableStore();
    this.#directory = directory;
  }

  #keyPath(sessionId: string): string {
    if (!validSessionId(sessionId)) unavailableKey();
    const identifier = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    return path.join(this.#directory, `${identifier}.key`);
  }

  async #ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const status = await lstat(this.#directory);
      if (!status.isDirectory() || !ownerOnly(status.mode) || !ownedByRuntimeUser(status.uid)) {
        unavailableStore();
      }
    } catch (error) {
      if (error instanceof SessionKeyError) throw error;
      unavailableStore();
    }
  }

  async #readKey(sessionId: string): Promise<Buffer> {
    const keyPath = this.#keyPath(sessionId);
    let handle;
    try {
      handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const status = await handle.stat();
      if (!status.isFile() || status.size !== KEY_BYTES || !ownerOnly(status.mode) || !ownedByRuntimeUser(status.uid)) {
        unavailableStore();
      }
      return await handle.readFile();
    } catch (error) {
      if (error instanceof SessionKeyError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        unavailableKey();
      }
      unavailableStore();
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async create(sessionId: string): Promise<void> {
    const keyPath = this.#keyPath(sessionId);
    await this.#ensureDirectory();
    const temporaryPath = path.join(this.#directory, `.pending-${randomUUID()}`);
    const key = randomBytes(KEY_BYTES);
    let handle;

    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(key);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporaryPath, keyPath);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
          throw error;
        }
      }
      const persistedKey = await this.#readKey(sessionId);
      persistedKey.fill(0);
    } catch (error) {
      if (error instanceof SessionKeyError) throw error;
      unavailableStore();
    } finally {
      key.fill(0);
      await handle?.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
    }
  }

  async has(sessionId: string): Promise<boolean> {
    try {
      const key = await this.#readKey(sessionId);
      key.fill(0);
      return true;
    } catch (error) {
      if (error instanceof SessionKeyError && error.message === 'Session key is unavailable') {
        return false;
      }
      throw error;
    }
  }

  async encrypt(sessionId: string, plaintext: string): Promise<EncryptedSessionContent> {
    const key = await this.#readKey(sessionId);
    try {
      return encryptWithKey(key, plaintext);
    } finally {
      key.fill(0);
    }
  }

  async decrypt(sessionId: string, encrypted: EncryptedSessionContent): Promise<string> {
    const key = await this.#readKey(sessionId);
    try {
      return decryptWithKey(key, encrypted);
    } finally {
      key.fill(0);
    }
  }

  async destroy(sessionId: string): Promise<boolean> {
    const keyPath = this.#keyPath(sessionId);
    try {
      await unlink(keyPath);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      unavailableStore();
    }
  }
}
