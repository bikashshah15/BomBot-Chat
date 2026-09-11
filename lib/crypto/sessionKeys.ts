import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

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
  constructor(message: 'Session key is unavailable' | 'Session content encryption failed' | 'Session content decryption failed') {
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

  decrypt(sessionId: string, encrypted: EncryptedSessionContent): string {
    const key = this.#keys.get(sessionId);
    if (!key) unavailableKey();

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

  destroy(sessionId: string): boolean {
    const key = this.#keys.get(sessionId);
    if (!key) return false;

    key.fill(0);
    return this.#keys.delete(sessionId);
  }
}
