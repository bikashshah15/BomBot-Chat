import assert from 'node:assert/strict';
import test from 'node:test';

import { modelProviderToggleView } from './modelProviderToggle.ts';

test('toggle disabled renders nothing', () => {
  assert.equal(modelProviderToggleView({
    toggleEnabled: false,
    providers: [{ id: 'primary', label: 'ignored', available: true }],
    activeProviderLabel: 'ignored',
  }), null);
});

test('unavailable alternate is disabled with a neutral note', () => {
  const view = modelProviderToggleView({
    toggleEnabled: true,
    providers: [
      { id: 'primary', label: 'Local — local-model', available: true },
      { id: 'alternate', label: 'Alternate', available: false },
    ],
    activeProviderLabel: 'Local — local-model',
  });
  assert.deepEqual(view?.options[1], {
    id: 'alternate', label: 'OpenAI', disabled: true, note: 'OpenAI unavailable',
  });
});

test('current model label is passed through verbatim', () => {
  const label = 'OpenAI — exact/server supplied label';
  assert.equal(modelProviderToggleView({
    toggleEnabled: true,
    providers: [],
    activeProviderLabel: label,
  })?.currentLabel, label);
});
