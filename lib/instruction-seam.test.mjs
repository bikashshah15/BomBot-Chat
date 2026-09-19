import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import 'dotenv/config';

const { buildBombotInstructions, resolveBombotInstructions } = await import('./openai-responses.ts');

test('unset instruction seam preserves both defaults byte-for-byte', () => {
  for (const mode of ['api', 'offline']) {
    assert.equal(resolveBombotInstructions(mode, undefined), buildBombotInstructions(mode));
  }
});

test('configured instruction file is used verbatim regardless of OSV mode', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bombot-instructions-'));
  try {
    const file = path.join(directory, 'instructions.txt');
    const content = '  Synthetic injected instructions\nwith final whitespace.  \n';
    await writeFile(file, content);
    assert.equal(resolveBombotInstructions('api', file), content);
    assert.equal(resolveBombotInstructions('offline', file), content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unreadable, empty and whitespace instruction files fail closed without content', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bombot-instructions-failure-'));
  try {
    const valid = path.join(directory, 'valid-private-name.txt');
    await writeFile(valid, 'Synthetic valid private instructions');
    const cases = [path.join(directory, 'missing-private-name.txt'), path.relative(process.cwd(), valid)];
    for (const [name, content] of [['empty-private-name.txt',''], ['blank-private-name.txt',' \n\t']]) {
      const file = path.join(directory, name); await writeFile(file, content); cases.push(file);
    }
    for (const file of cases) {
      try {
        execFileSync(process.execPath, ['--experimental-strip-types','--import','dotenv/config',
          '-e', "import('./lib/openai-responses.ts')"], {
          cwd: new URL('../', import.meta.url), encoding: 'utf8', stdio: ['ignore','pipe','pipe'],
          env: { ...process.env, INSTRUCTIONS_FILE: file },
        });
        assert.fail('configured invalid instructions must stop module startup');
      } catch (error) {
        assert.notEqual(error.status, 0);
        const output = `${error.stdout}${error.stderr}`;
        assert.match(output, /instructions_file_unavailable/);
        assert.equal(output.includes(file), false);
        assert.equal(output.includes('private-name'), false);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
