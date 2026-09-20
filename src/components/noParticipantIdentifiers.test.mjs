import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = path.join(repoRoot, 'src');

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
    else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(entryPath);
  }
  return files;
}

test('client sources collect no participant identifier and purge the legacy email key (no Postgres)', async () => {
  await assert.rejects(
    access(path.join(srcRoot, 'components/EmailCollectionDialog.tsx')),
    { code: 'ENOENT' },
  );

  const forbidden = [
    ['legacy email state', /\buserEmail\b/],
    ['legacy email setter', /\bsetUserEmail\b/],
    ['participant identifier', /\bparticipantId\b/],
    ['email input', /type\s*=\s*["']email["']/],
  ];
  const legacyKeyOccurrences = [];

  for (const file of await sourceFiles(srcRoot)) {
    const source = await readFile(file, 'utf8');
    for (const [label, pattern] of forbidden) {
      assert.doesNotMatch(source, pattern, `${label} remains in ${path.relative(repoRoot, file)}`);
    }
    for (const line of source.split('\n')) {
      if (line.includes('bombot-user-email')) {
        legacyKeyOccurrences.push({ file, line: line.trim() });
      }
    }
  }

  assert.deepEqual(legacyKeyOccurrences.map(({ file, line }) => ({
    file: path.relative(repoRoot, file),
    line,
  })), [{
    file: 'src/contexts/ChatContext.tsx',
    line: "localStorage.removeItem('bombot-user-email');",
  }]);
});
