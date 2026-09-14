import { sessionKeyVault } from '../crypto/sessionKeyStore.ts';
import type { EncryptedSessionContent } from '../crypto/sessionKeys.ts';

export interface StoredContentEnvelope {
  plaintext: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  authTag: Buffer | null;
}

export class StoredContentShapeError extends Error {
  constructor() {
    super('Stored content encryption envelope is invalid');
    this.name = 'StoredContentShapeError';
  }
}

export async function encryptStoredContent(
  sessionId: string,
  plaintext: string,
): Promise<EncryptedSessionContent> {
  return sessionKeyVault.encrypt(sessionId, plaintext);
}

export async function decryptStoredContent(
  sessionId: string,
  stored: StoredContentEnvelope,
  nullable: boolean,
): Promise<string | null> {
  const envelopeFields = [stored.ciphertext, stored.nonce, stored.authTag];
  const presentEnvelopeFields = envelopeFields.filter(value => value !== null).length;

  if (stored.plaintext !== null) {
    if (presentEnvelopeFields !== 0) throw new StoredContentShapeError();
    return stored.plaintext;
  }

  if (presentEnvelopeFields === 0) {
    if (nullable) return null;
    throw new StoredContentShapeError();
  }

  if (presentEnvelopeFields !== envelopeFields.length) throw new StoredContentShapeError();

  return sessionKeyVault.decrypt(sessionId, {
    ciphertext: stored.ciphertext as Buffer,
    nonce: stored.nonce as Buffer,
    authTag: stored.authTag as Buffer,
  });
}
