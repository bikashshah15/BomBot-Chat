import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PROFILE_FILES = [
  new URL('../../config/profiles/local.env', import.meta.url),
  new URL('../../config/profiles/openai.env', import.meta.url),
];

const ALLOWED_DIFFERENCES = new Set([
  'PROFILE',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_REASONING_EFFORT',
]);

function parseProfile(source) {
  const entries = [];

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) entries.push([match[1], match[2]]);
  }

  return new Map(entries);
}

test('local and OpenAI profiles have safe, intentional parity', async () => {
  const sources = await Promise.all(PROFILE_FILES.map((file) => readFile(file, 'utf8')));
  const [local, openai] = sources.map(parseProfile);

  assert.deepEqual([...local.keys()].sort(), [...openai.keys()].sort());

  const differingKeys = [...local.keys()]
    .filter((key) => local.get(key) !== openai.get(key))
    .sort();
  assert.deepEqual(differingKeys, [...ALLOWED_DIFFERENCES].sort());

  for (const profile of [local, openai]) {
    for (const [key, value] of profile) {
      assert.doesNotMatch(key, /KEY|SECRET|TOKEN|PASSWORD/i);
      assert.doesNotMatch(value, /^sk-/);
    }
  }
});
