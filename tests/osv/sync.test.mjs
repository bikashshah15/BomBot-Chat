import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import 'dotenv/config';
import pg from 'pg';

import {
  appendDroppedAdvisorySample,
  assertDroppedAdvisoryRateWithinLimit,
  assertSafeArchiveEntries,
  assertSnapshotDateCoversMaxModified,
  baseOsvEcosystem,
  createDroppedReasonCounts,
  incrementDroppedReasonCount,
  MAX_DROPPED_ADVISORY_RATE,
  MAX_DROPPED_ADVISORY_SAMPLES,
  osvIngestResultFromRecord,
  osvRowsFromRecord,
} from '../../lib/osv/sync.ts';

const UNREACHABLE_DATABASE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPERM',
  'ETIMEDOUT',
]);

function isDatabaseUnreachable(error) {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(isDatabaseUnreachable);
  }
  return Boolean(
    error
    && typeof error === 'object'
    && UNREACHABLE_DATABASE_CODES.has(error.code),
  );
}

test('OSV sync rejects archive entries that can escape the extraction directory', () => {
  assert.doesNotThrow(() => assertSafeArchiveEntries(['GHSA-safe.json', 'nested/CVE-safe.json']));

  for (const unsafeEntry of ['../outside.json', '/absolute.json', 'nested/../../outside.json', 'C:\\outside.json']) {
    assert.throws(
      () => assertSafeArchiveEntries([unsafeEntry]),
      /Unsafe OSV archive entry/,
    );
  }
});

test('OSV sync retains range events and explicit affected versions for matching', () => {
  const rows = osvRowsFromRecord({
    id: 'GHSA-synthetic',
    modified: '2026-08-31T12:00:00Z',
    summary: 'Synthetic vulnerability',
    severity: [{ type: 'CVSS_V3', score: 'synthetic-vector' }],
    affected: [
      {
        package: { ecosystem: 'npm', name: 'synthetic-package' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }],
        versions: ['1.0.0', '1.5.0'],
      },
      {
        package: { ecosystem: 'npm', name: 'synthetic-package' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '3.0.0' }] }],
        versions: ['3.0.0'],
      },
      {
        package: { ecosystem: 'PyPI', name: 'other-ecosystem' },
        ranges: [],
      },
      {
        package: { ecosystem: 'npm:https://registry.example.test', name: 'synthetic-package' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }] }],
        versions: ['4.0.0'],
      },
    ],
  }, 'npm');

  assert.equal(rows.length, 2);
  const baseRow = rows.find(row => row.ecosystem === 'npm');
  const namespacedRow = rows.find(row => row.ecosystem === 'npm:https://registry.example.test');
  assert.equal(baseRow.packageName, 'synthetic-package');
  assert.deepEqual(baseRow.ranges, {
    ranges: [
      { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] },
      { type: 'SEMVER', events: [{ introduced: '3.0.0' }] },
    ],
    versions: ['1.0.0', '1.5.0', '3.0.0'],
  });
  assert.equal(namespacedRow.packageName, 'synthetic-package');
  assert.deepEqual(namespacedRow.ranges, {
    ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }] }],
    versions: ['4.0.0'],
  });
  assert.equal(baseOsvEcosystem('Packagist:https://packages.drupal.org/8'), 'Packagist');
  assert.equal(baseOsvEcosystem('crates.io'), 'crates.io');
});

test('OSV sync script refuses to run without an explicit OSV_SNAPSHOT_DATE', () => {
  const repositoryRoot = new URL('../..', import.meta.url);
  const result = spawnSync(process.execPath, ['scripts/osv-sync.mjs'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null',
      DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
      PROFILE: 'local',
      LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
      LLM_MODEL: 'synthetic-local-model',
      LLM_TEMPERATURE: '0',
      LLM_TOP_P: '1',
      LLM_MAX_OUTPUT_TOKENS: '1',
      OSV_MODE: 'api',
      RETENTION_IDLE_HOURS: '24',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MissingOSVSnapshotDateError/);
  assert.match(result.stderr, /OSV_SNAPSHOT_DATE/);
});

test('OSV sync refuses a declared pin that predates max_modified', () => {
  assert.doesNotThrow(() => assertSnapshotDateCoversMaxModified(
    '2026-08-31',
    '2026-08-31T23:59:59Z',
  ));
  assert.throws(
    () => assertSnapshotDateCoversMaxModified('2026-08-30', '2026-08-31T00:00:00Z'),
    error => {
      assert.equal(error.name, 'OSVSnapshotDateMismatchError');
      assert.match(error.message, /OSV_SNAPSHOT_DATE 2026-08-30/);
      assert.match(error.message, /max_modified 2026-08-31T00:00:00Z/);
      return true;
    },
  );
});

test('OSV sync counts zero-row advisories and enforces the measured drop threshold', () => {
  const result = osvIngestResultFromRecord({
    id: 'GHSA-metadata-only',
    modified: '2026-08-31T00:00:00Z',
    affected: [{ package: { ecosystem: 'Packagist', name: 'synthetic-package' } }],
  }, 'npm');
  assert.equal(result.dropped, true);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.droppedSample, {
    id: 'GHSA-metadata-only',
    reason: 'ecosystem_mismatch',
    observedEcosystems: ['Packagist'],
  });

  assert.throws(
    () => assertDroppedAdvisoryRateWithinLimit(
      { all: 286_212 },
      { all: Math.floor(286_212 * MAX_DROPPED_ADVISORY_RATE) + 1 },
    ),
    error => error.name === 'OSVDroppedAdvisoryThresholdError',
  );
});

test('OSV per-ecosystem drop guard rejects the pre-fix Packagist loss', () => {
  const preFixRecordCounts = {
    npm: 228_422,
    PyPI: 25_109,
    Maven: 7_058,
    Go: 8_982,
    Packagist: 7_038,
    RubyGems: 4_657,
    NuGet: 1_877,
    'crates.io': 2_767,
    Hex: 289,
    Pub: 13,
  };
  const preFixDroppedCounts = Object.fromEntries(
    Object.keys(preFixRecordCounts).map(ecosystem => [ecosystem, ecosystem === 'Packagist' ? 539 : 0]),
  );
  assert.throws(
    () => assertDroppedAdvisoryRateWithinLimit(preFixRecordCounts, preFixDroppedCounts),
    error => error.name === 'OSVDroppedAdvisoryThresholdError'
      && /Packagist/.test(error.message)
      && /539\/7038/.test(error.message),
  );

  assert.throws(
    () => assertDroppedAdvisoryRateWithinLimit({ Pub: 13 }, { Pub: 1 }),
    error => error.name === 'OSVDroppedAdvisoryThresholdError'
      && /Pub/.test(error.message)
      && /1\/13/.test(error.message),
  );
});

test('OSV sync classifies and bounds dropped advisory samples', () => {
  const affectedMissing = osvIngestResultFromRecord({
    id: 'GHSA-no-affected-array',
    modified: '2026-08-31T00:00:00Z',
  }, 'npm');
  assert.deepEqual(affectedMissing.droppedSample, {
    id: 'GHSA-no-affected-array',
    reason: 'affected_not_array',
    observedEcosystems: [],
  });

  const affectedEmpty = osvIngestResultFromRecord({
    id: 'GHSA-empty-affected-array',
    modified: '2026-08-31T00:00:00Z',
    affected: [],
  }, 'npm');
  assert.deepEqual(affectedEmpty.droppedSample, {
    id: 'GHSA-empty-affected-array',
    reason: 'affected_empty',
    observedEcosystems: [],
  });

  const invalidName = osvIngestResultFromRecord({
    id: 'GHSA-invalid-package-name',
    modified: '2026-08-31T00:00:00Z',
    affected: [
      { package: { ecosystem: 'PyPI', name: 'other-package' } },
      { package: { ecosystem: 'npm', name: '' } },
    ],
  }, 'npm');
  assert.deepEqual(invalidName.droppedSample, {
    id: 'GHSA-invalid-package-name',
    reason: 'invalid_package_name',
    observedEcosystems: ['PyPI', 'npm'],
  });

  const samples = [];
  const reasonCounts = createDroppedReasonCounts();
  for (let index = 0; index < MAX_DROPPED_ADVISORY_SAMPLES + 5; index += 1) {
    const sample = {
      id: `GHSA-bounded-${index}`,
      reason: 'affected_not_array',
      observedEcosystems: [],
    };
    appendDroppedAdvisorySample(samples, sample);
    incrementDroppedReasonCount(reasonCounts, sample);
  }
  assert.equal(samples.length, 20);
  assert.equal(samples.at(-1).id, 'GHSA-bounded-19');
  assert.deepEqual(reasonCounts, {
    affected_not_array: 25,
    affected_empty: 0,
    ecosystem_mismatch: 0,
    invalid_package_name: 0,
  });
});

test('ingested OSV snapshot preserves at least one namespaced Packagist ecosystem', async context => {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping namespaced OSV snapshot test');
    return;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    try {
      await client.connect();
    } catch (error) {
      if (isDatabaseUnreachable(error)) {
        context.skip('DATABASE_URL is configured but Postgres is unreachable; skipping namespaced OSV snapshot test');
        return;
      }
      throw error;
    }

    const result = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM osv_vulns WHERE ecosystem LIKE 'Packagist:%'
       ) AS has_namespaced_packagist`,
    );
    assert.equal(result.rows[0].has_namespaced_packagist, true);
  } finally {
    await client.end().catch(() => {});
  }
});
