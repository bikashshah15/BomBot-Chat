import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSessionMeasures } from './extract.ts';

const scan = (ids = ['GHSA-aaaa-bbbb-cccc']) => ({ role: 'user', pinned: true,
  content: `Private filename participant-inventory.json\n**Minimized Software Context:**\n${JSON.stringify({
    software_name: 'Private software', sbom_hash: 'private-hash',
    scanned_package_count: 4, scan_truncated: true,
    packages_depends_on: [{ package_name: 'private-package', vulnerabilities: ids.map(id => ({ id })) }],
  })}\n\nPlease summarize.` });

async function run(text, source = { osv_mode: 'offline', snapshot_date: '2026-09-16', status: 'available' }, scans = [scan()]) {
  let stored;
  let requested;
  const measure = await extractSessionMeasures('synthetic-session', {
    async readMessages() { return [...scans, { role: 'assistant', content: text, pinned: false },
      { role: 'tool', content: 'CVE-2026-9999', pinned: false }]; },
    async resolveLocally(ids) {
      requested = ids;
      return { source, primaryByIdentifier: new Map([
        ['CVE-2026-1234', 'GHSA-aaaa-bbbb-cccc'], ['CVE-2026-5678', 'GHSA-dddd-eeee-ffff'],
      ]) };
    },
    async store(id, value) { assert.equal(id, 'synthetic-session'); stored = JSON.parse(JSON.stringify(value)); },
  });
  assert.deepEqual(stored, measure);
  return { stored, requested };
}

test('alias-only emission stores a completed grounded resolution outcome', async () => {
  const { stored } = await run('CVE-2026-1234');
  assert.equal(stored.grounded_count, 1);
  assert.equal(stored.alias_grounded_count, 1);
  assert.equal(stored.direct_count, 0);
  assert.equal(stored.unresolved_count, 0);
});

test('identifier absent from the scan is ungrounded; a local miss is distinct', async () => {
  const { stored } = await run('CVE-2026-5678 CVE-2026-9998');
  assert.equal(stored.ungrounded_count, 2);
  assert.equal(stored.resolved_ungrounded_count, 1);
  assert.equal(stored.not_found_count, 1);
});

test('unanswerable snapshot records provenance without error or outbound fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Outbound request prohibited'); };
  try {
    for (const status of ['missing_snapshot', 'pin_mismatch']) {
      const { stored } = await run('CVE-2026-1234 GHSA-aaaa-bbbb-cccc', {
        osv_mode: 'offline', snapshot_date: 'unknown', status,
      });
      assert.equal(stored.resolution_provenance.status, status);
      assert.equal(stored.unresolved_count, 1);
      assert.equal(stored.direct_count, 1);
      assert.equal(stored.ungrounded_count, 0);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('legacy scan provenance is unknown and separate from extraction source', async () => {
  const { stored } = await run('CVE-2026-1234');
  assert.deepEqual(stored.scan_provenance, [{ osv_mode: 'unknown', snapshot_date: 'unknown',
    scan_truncated: true, scanned_package_count: 4 }]);
  assert.deepEqual(stored.resolution_provenance, { osv_mode: 'offline', snapshot_date: '2026-09-16', status: 'available' });
  assert.equal(stored.reference_definition, 'alias-aware-pre-scan-v1');
});

test('stored result excludes message text, filenames, hashes, packages and identifiers', async () => {
  const text = 'Private answer CVE-2026-1234';
  const { stored } = await run(text);
  const serialized = JSON.stringify(stored);
  for (const value of [text, 'Private answer', 'participant-inventory.json', 'private-package',
    'private-hash', 'Private software', 'CVE-2026-1234', 'GHSA-aaaa-bbbb-cccc']) {
    assert.equal(serialized.includes(value), false);
  }
});

test('occurrences match harness semantics; repeated lookup identifiers are deduplicated', async () => {
  const { stored, requested } = await run('[CVE-2026-1234](https://osv.dev/CVE-2026-1234) ghsa-aaaa-bbbb-cccc');
  assert.equal(stored.emitted_count, 3);
  assert.equal(stored.grounded_count, 3);
  assert.deepEqual(requested, ['CVE-2026-1234', 'GHSA-AAAA-BBBB-CCCC']);
});

test('missing and malformed scans are unresolved, not clean negatives', async () => {
  for (const [scans, status] of [[[], 'missing_scan'], [[{ role: 'user', pinned: true,
    content: '**Minimized Software Context:**\n{"packages_depends_on":false}' }], 'invalid_scan']]) {
    const { stored } = await run('CVE-2026-1234', undefined, scans);
    assert.equal(stored.reference_status, status);
    assert.equal(stored.unresolved_count, 1);
    assert.equal(stored.grounded_count, 0);
    assert.equal(stored.ungrounded_count, 0);
  }
});

test('multiple scans contribute session references and preserve separate coverage', async () => {
  const { stored } = await run('CVE-2026-1234 CVE-2026-5678', undefined,
    [scan(), scan(['GHSA-dddd-eeee-ffff'])]);
  assert.equal(stored.grounded_count, 2);
  assert.equal(stored.scan_provenance.length, 2);
});

test('failed persistence propagates; a future caller must not shred on failure', async () => {
  await assert.rejects(extractSessionMeasures('synthetic-session', {
    async readMessages() { return []; },
    async resolveLocally() { return { source: { osv_mode: 'offline', snapshot_date: 'unknown', status: 'missing_snapshot' },
      primaryByIdentifier: new Map() }; },
    async store() { throw new Error('Persistence failed'); },
  }), /Persistence failed/);
});
