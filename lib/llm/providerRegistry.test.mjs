import assert from 'node:assert/strict';
import test from 'node:test';

import 'dotenv/config';

const {
  providerLabel,
  resolveProviderSettings,
} = await import('./providerRegistry.ts');

test('provider registry rejects unknown ids rather than defaulting', () => {
  assert.throws(() => resolveProviderSettings('unknown-provider'), /Unknown model provider/);
});

test('provider labels expose only profile and model metadata', () => {
  const label = providerLabel('primary');
  assert.doesNotMatch(label, /http/i);
  assert.doesNotMatch(label, /sk-/i);
  for (const [name, value] of Object.entries(process.env)) {
    if (name.endsWith('_API_KEY') && value) assert.equal(label.includes(value), false);
  }
});
