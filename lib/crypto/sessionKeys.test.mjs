import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionKeyVault } from './sessionKeys.ts';

function copyEnvelope(encrypted) {
  return {
    ciphertext: Buffer.from(encrypted.ciphertext),
    nonce: Buffer.from(encrypted.nonce),
    authTag: Buffer.from(encrypted.authTag),
  };
}

test('one data-encryption key is created and reused per session', () => {
  const vault = new SessionKeyVault();

  vault.create('session-one');
  vault.create('session-one');

  assert.equal(vault.size, 1);
  assert.equal(vault.has('session-one'), true);
  assert.equal(vault.decrypt('session-one', vault.encrypt('session-one', 'first row')), 'first row');
  assert.equal(vault.decrypt('session-one', vault.encrypt('session-one', 'second row')), 'second row');
});

test('different sessions cannot decrypt each other content', () => {
  const vault = new SessionKeyVault();
  vault.create('session-one');
  vault.create('session-two');
  const encrypted = vault.encrypt('session-one', 'session-one content');

  assert.throws(
    () => vault.decrypt('session-two', encrypted),
    error => error.name === 'SessionKeyError'
      && error.message === 'Session content decryption failed',
  );
});

test('AES-GCM uses a fresh nonce for repeated plaintext', () => {
  const vault = new SessionKeyVault();
  vault.create('session-one');

  const first = vault.encrypt('session-one', 'repeated content');
  const second = vault.encrypt('session-one', 'repeated content');

  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
});

test('content copied into a database-backup-shaped envelope is unrecoverable after key destruction', () => {
  const vault = new SessionKeyVault();
  vault.create('session-one');
  const backupEnvelope = copyEnvelope(vault.encrypt('session-one', 'content present in an old backup'));

  assert.equal(vault.destroy('session-one'), true);
  assert.equal(vault.has('session-one'), false);
  vault.create('session-one');
  assert.throws(
    () => vault.decrypt('session-one', backupEnvelope),
    error => error.name === 'SessionKeyError'
      && error.message === 'Session content decryption failed',
  );
});

test('destroying one session key leaves other sessions recoverable', () => {
  const vault = new SessionKeyVault();
  vault.create('session-one');
  vault.create('session-two');
  const survivingContent = vault.encrypt('session-two', 'surviving session content');

  vault.destroy('session-one');

  assert.equal(vault.decrypt('session-two', survivingContent), 'surviving session content');
  assert.equal(vault.size, 1);
});

test('errors do not expose session IDs, plaintext, ciphertext, or derived secret material', () => {
  const vault = new SessionKeyVault();
  const sessionId = 'private-session-identifier';
  const plaintext = 'private participant message';
  vault.create(sessionId);
  const encrypted = vault.encrypt(sessionId, plaintext);
  const corrupted = copyEnvelope(encrypted);
  corrupted.authTag[0] ^= 0xff;

  assert.throws(
    () => vault.decrypt(sessionId, corrupted),
    error => {
      const emitted = `${error.name}: ${error.message}`;
      assert.equal(emitted.includes(sessionId), false);
      assert.equal(emitted.includes(plaintext), false);
      assert.equal(emitted.includes(encrypted.ciphertext.toString('hex')), false);
      assert.equal(emitted, 'SessionKeyError: Session content decryption failed');
      return true;
    },
  );
});
