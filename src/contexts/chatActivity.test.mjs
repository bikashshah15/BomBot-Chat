import assert from 'node:assert/strict';
import test from 'node:test';

const {
  loadingTimestamps,
  shouldCommitActivity,
} = await import('../hooks/progressStatus.ts');

test('activity commits initially and at the one-second boundary', () => {
  assert.equal(shouldCommitActivity(null, 0), true);
  assert.equal(shouldCommitActivity(0, 999), false);
  assert.equal(shouldCommitActivity(0, 1_000), true);
});

test('a burst of 500 frames within one second produces one activity commit', () => {
  let lastCommittedAt = null;
  let commitCount = 0;

  for (let frame = 0; frame < 500; frame += 1) {
    const now = frame * 2;
    if (!shouldCommitActivity(lastCommittedAt, now)) continue;
    lastCommittedAt = now;
    commitCount += 1;
  }

  assert.equal(commitCount, 1);
  assert.equal(lastCommittedAt, 0);
});

test('loading timestamps start response timing and leave upload timing empty', () => {
  assert.deepEqual(loadingTimestamps('response', 12_345), {
    responseStartedAt: 12_345,
    lastActivityAt: 12_345,
  });
  assert.deepEqual(loadingTimestamps('upload', 12_345), {
    responseStartedAt: null,
    lastActivityAt: null,
  });
});
