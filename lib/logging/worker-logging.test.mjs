import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('P3/P6: failed worker diagnostic sink cannot reject deletion preparation; fields unchanged', () => {
  execFileSync(process.execPath, ['--import', 'dotenv/config', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { prepareDeletion } = await import('./lib/db/retentionWorker.ts');
    const { dbPool } = await import('./lib/db/client.ts');
    const original = console.error;
    try {
      const logs = []; console.error = (...args) => logs.push(args);
      const deps = { extract: async () => { throw new Error('participant lodash'); },
        recordFailure: async () => { throw new Error('private.json'); } };
      await prepareDeletion(deps, 10);
      assert.deepEqual(logs, [['{"event":"retention_failure_record_unavailable"}']]);
      console.error = () => { throw new Error('logging sink failed'); };
      await assert.doesNotReject(() => prepareDeletion(deps, 10));
    } finally { console.error = original; await dbPool.end(); }
  `], { stdio: 'pipe' });
});

test('P3/P5: failed request diagnostic sink preserves the parser error contract', () => {
  execFileSync(process.execPath, ['--import', 'dotenv/config', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { parseSBOMData } = await import('./pages/api/upload.ts');
    const { dbPool } = await import('./lib/db/client.ts');
    const original = console.error;
    try {
      const logs = []; console.error = (...args) => logs.push(args);
      assert.throws(() => parseSBOMData('lodash', 'private.json'), /Invalid SBOM format/);
      assert.deepEqual(logs, [['Error parsing SBOM:', 'SyntaxError']]);
      console.error = () => { throw new Error('sink failed'); };
      assert.throws(() => parseSBOMData('lodash', 'private.json'), /Invalid SBOM format/);
    } finally { console.error = original; await dbPool.end(); }
  `], { stdio: 'pipe' });
});
