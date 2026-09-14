import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileSessionKeyVault, SessionKeyVault } from './sessionKeys.ts';

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

test('filesystem keys survive vault replacement, remain owner-only, and disappear on destruction', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bombot-session-keys-'));
  const keyDirectory = path.join(temporaryRoot, 'keys');
  const sessionId = 'synthetic-restart-session';
  const plaintext = 'synthetic content across a restart';

  try {
    const beforeRestart = new FileSessionKeyVault(keyDirectory);
    await beforeRestart.create(sessionId);
    const encrypted = await beforeRestart.encrypt(sessionId, plaintext);

    const afterRestart = new FileSessionKeyVault(keyDirectory);
    assert.equal(await afterRestart.decrypt(sessionId, encrypted), plaintext);
    assert.equal((await stat(keyDirectory)).mode & 0o777, 0o700);

    const keyFiles = await readdir(keyDirectory);
    assert.equal(keyFiles.length, 1);
    assert.equal(keyFiles[0].includes(sessionId), false);
    const keyStatus = await stat(path.join(keyDirectory, keyFiles[0]));
    assert.equal(keyStatus.mode & 0o777, 0o600);
    assert.equal(keyStatus.size, 32);

    assert.equal(await afterRestart.destroy(sessionId), true);
    assert.equal(await beforeRestart.has(sessionId), false);
    await assert.rejects(
      beforeRestart.decrypt(sessionId, encrypted),
      error => error.name === 'SessionKeyError'
        && error.message === 'Session key is unavailable',
    );
  } finally {
    await chmod(keyDirectory, 0o700).catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('filesystem store rejects access through a directory readable by other users', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bombot-session-keys-'));
  const keyDirectory = path.join(temporaryRoot, 'keys');
  const vault = new FileSessionKeyVault(keyDirectory);

  try {
    await vault.create('synthetic-permission-session');
    await chmod(keyDirectory, 0o755);
    await assert.rejects(
      vault.create('private-session-identifier'),
      error => {
        assert.equal(error.name, 'SessionKeyError');
        assert.equal(error.message, 'Session key store is unavailable');
        assert.equal(error.message.includes(keyDirectory), false);
        assert.equal(error.message.includes('private-session-identifier'), false);
        return true;
      },
    );
  } finally {
    await chmod(keyDirectory, 0o700).catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
