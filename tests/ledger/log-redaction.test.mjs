import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoPackageLogs, fixturePackageNames } from './log-redaction.mjs';

test('P7: gate checks SPDX and CycloneDX names, including early and split output', () => {
  const names = fixturePackageNames([{ packages: [{ name: 'lodash' }] }, { components: [{ name: 'axios' }] }]);
  assert.deepEqual(names, ['lodash', 'axios']);
  assert.doesNotThrow(() => assertNoPackageLogs('Upload handler error: Error', names));
  for (const name of names) assert.throws(() => assertNoPackageLogs(`early error ${name}`, names), /Log redaction gate/);
  assert.throws(() => assertNoPackageLogs(['lo', 'dash'].join(''), names), /Log redaction gate/);
});
