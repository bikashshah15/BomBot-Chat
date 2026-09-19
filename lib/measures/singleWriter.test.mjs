import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const permittedWriter = 'lib/db/sessionMeasures.ts';
const guard = 'lib/measures/singleWriter.test.mjs';
const sourceRoots = ['lib', 'pages', 'src', 'scripts', 'tests', 'db'];
const sourceExtension = /\.(?:[cm]?js|jsx|ts|tsx|sql)$/u;
const writes = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(?:\s+TABLE)?)\s+(?:"?\w+"?\s*\.\s*)?"?session_measures"?(?=\s|\(|;|$)/giu;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    // Never follow symlinks or traverse unrelated/generated directories.
    if (entry.isSymbolicLink() || ['study', 'node_modules', 'dist', '.next'].includes(entry.name)) continue;
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (entry.isFile() && sourceExtension.test(entry.name)) files.push(relative);
  }
  return files;
}

test('session_measures has no public writer and at most the private lib/db insert/upsert', async () => {
  // Inspect the permitted module separately, rather than broadening an allowlist
  // until it passes. Its only named write must remain this exact insert/upsert.
  let writer;
  try { writer = await readFile(path.join(root, permittedWriter), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (writer !== undefined) {
    assert.deepEqual([...writer.matchAll(writes)].map(match => match[0]), ['INSERT INTO session_measures']);
    assert.match(writer, /ON CONFLICT \(session_id\) DO UPDATE SET result = EXCLUDED\.result/u);
  }

  const files = (await Promise.all(sourceRoots.map(sourceFiles))).flat();
  assert.equal(files.includes(permittedWriter), writer !== undefined);
  assert.ok(files.includes(guard));
  const unexpected = [];
  for (const file of files) {
    // Explicit exclusions: neither this guard's fixtures nor the protected
    // module are scanned as potential additional writers.
    if (file === guard || file === permittedWriter) continue;
    const content = await readFile(path.join(root, file), 'utf8');
    for (const match of content.matchAll(writes)) {
      unexpected.push(`${file}:${content.slice(0, match.index).split('\n').length}: ${match[0]}`);
    }
  }
  assert.deepEqual(unexpected, [], 'A second measure-store writer requires review before it can ship');
});

test('writer guard detects additional SQL write forms, not reads or table creation', () => {
  for (const sql of ['INSERT INTO session_measures (result) VALUES ($1)',
    'UPDATE session_measures SET result = $1', 'DELETE FROM session_measures WHERE session_id = $1',
    'MERGE INTO "public"."session_measures" USING source', 'COPY session_measures FROM STDIN',
    'TRUNCATE TABLE session_measures;', 'update public.session_measures set result = $1']) {
    assert.equal([...sql.matchAll(writes)].length, 1, sql);
  }
  for (const sql of ['SELECT result FROM session_measures', 'CREATE TABLE IF NOT EXISTS session_measures (result JSONB)']) {
    assert.equal([...sql.matchAll(writes)].length, 0, sql);
  }
});
