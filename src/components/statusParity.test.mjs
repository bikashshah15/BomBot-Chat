import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.dirname(componentDirectory);

function tsxFilesUnder(directory) {
  return readdirSync(directory, { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.tsx'))
    .map((entry) => path.join(directory, entry));
}

test('component and context sources contain no event-specific display hooks', () => {
  const forbiddenTokens = [
    ['on', 'Tool', 'Start'].join(''),
    ['on', 'Tool', 'End'].join(''),
    ['tool', '_start'].join(''),
    ['tool', '_end'].join(''),
  ];
  const files = [
    ...tsxFilesUnder(componentDirectory),
    ...tsxFilesUnder(path.join(sourceDirectory, 'contexts')),
  ];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const token of forbiddenTokens) {
      assert.equal(source.includes(token), false, `${path.relative(sourceDirectory, file)} contains ${token}`);
    }
  }
});

test('renderable progress sources contain only condition-neutral wording', () => {
  const files = [
    path.join(sourceDirectory, 'hooks', 'progressStatus.ts'),
    path.join(componentDirectory, 'StatusIndicator.tsx'),
  ];
  const forbidden = /osv|database|vulnerab|lookup|package|tool|querying|checking|remaining|estimated|eta|\d+\s+of\s+\d+/i;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, forbidden, path.relative(sourceDirectory, file));
  }
});

test('status indicator omits the former rotating labels', () => {
  const source = readFileSync(path.join(componentDirectory, 'StatusIndicator.tsx'), 'utf8');
  for (const formerLabel of [
    'Querying package database',
    'Checking for vulnerabilities',
    'Analyzing your request',
    'Thinking...',
  ]) {
    assert.equal(source.includes(formerLabel), false);
  }
});
