import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import 'dotenv/config';
import pg from 'pg';

import { config } from '../../lib/config.ts';
import { buildSoftwareContext } from '../../lib/context/softwareContext.ts';
import {
  getOsvAdvisoryByIdentifier,
  getOsvVulnerabilityRowsByIdentifier,
} from '../../lib/osv/db.ts';
import {
  getCurrentOsvSnapshot,
  matchOsvPackages,
} from '../../lib/osv/match.ts';
import { baseOsvEcosystem, osvRowsFromRecord } from '../../lib/osv/sync.ts';

const execFileAsync = promisify(execFile);
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

async function withDatabase(context, callback) {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping OSV shape-parity test');
    return;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    try {
      await client.connect();
    } catch (error) {
      if (isDatabaseUnreachable(error)) {
        context.skip('DATABASE_URL is configured but Postgres is unreachable; skipping OSV shape-parity test');
        return;
      }
      throw error;
    }
    await callback(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function rawRecordForRow(row, snapshotDate) {
  const archivePath = path.join(
    config.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY,
    snapshotDate,
    'osv-scalibr',
    baseOsvEcosystem(row.ecosystem),
    'all.zip',
  );
  const { stdout } = await execFileAsync('unzip', ['-p', archivePath, `${row.id}.json`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function paritySnapshot(context, client) {
  try {
    await execFileAsync('unzip', ['-v'], { encoding: 'utf8' });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      context.skip('unzip is unavailable; skipping OSV shape-parity test');
      return null;
    }
    throw error;
  }

  const snapshot = await getCurrentOsvSnapshot(client);
  const snapshotDirectory = path.join(
    config.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY,
    snapshot.snapshotDate,
  );
  try {
    await access(snapshotDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      context.skip(`versioned scanner cache for ${snapshot.snapshotDate} is absent; skipping OSV shape-parity test`);
      return null;
    }
    throw error;
  }
  return snapshot;
}

function minimizedVulnerability(vulnerability, row) {
  const package_ = {
    id: `pkg:${row.ecosystem}/${row.packageName}`,
    name: row.packageName,
    version: '0',
    ecosystem: row.ecosystem,
  };
  return buildSoftwareContext({
    softwareName: 'OSV shape parity',
    sbomContent: 'synthetic parity harness',
    packages: [package_],
    dependencies: [],
    vulnerabilityResults: [{ package: package_, vulnerabilities: [vulnerability] }],
    scannedPackageCount: 1,
  }).packages_depends_on[0].vulnerabilities[0];
}

async function matchedAdvisoryForRow(client, row) {
  const versions = row.ranges?.versions;
  assert.ok(
    Array.isArray(versions) && versions.length > 0,
    `OSV row ${row.id} must identify an affected version for matcher parity`,
  );
  const package_ = {
    name: row.packageName,
    version: versions[0],
    ecosystem: row.ecosystem,
  };
  const [match] = await matchOsvPackages(client, [package_]);
  assert.deepEqual(match.package, package_);
  const advisory = match.vulnerabilities.find(vulnerability => vulnerability.id === row.id);
  assert.ok(advisory, `osv-scanner did not match affected advisory ${row.id}`);
  return advisory;
}

async function findSingleRowRawRecord(client, snapshot, predicateSql, rawPredicate) {
  const candidates = await client.query(
    `SELECT id
     FROM (
       SELECT DISTINCT ON (id)
         id, ecosystem, package, ranges, severity, database_specific
       FROM osv_vulns
       ORDER BY id, ecosystem, package
     ) AS first_rows
     WHERE ${predicateSql}
       AND jsonb_array_length(COALESCE(ranges->'versions', '[]'::jsonb)) > 0
     ORDER BY id
     LIMIT 250`,
  );

  for (const candidate of candidates.rows) {
    const rows = await getOsvVulnerabilityRowsByIdentifier(client, candidate.id);
    assert.ok(rows, `OSV rows ${candidate.id} disappeared during parity test`);
    if (rows.length !== 1) continue;
    const [row] = rows;
    const raw = await rawRecordForRow(row, snapshot.snapshotDate);
    const projectedRows = osvRowsFromRecord(raw, baseOsvEcosystem(row.ecosystem));
    if (
      projectedRows.length === 1
      && projectedRows[0].ecosystem === row.ecosystem
      && projectedRows[0].packageName === row.packageName
      && rawPredicate(raw)
    ) {
      return { raw, rows };
    }
  }

  assert.fail('No real single-row OSV advisory satisfied the parity-test predicate');
}

async function findMultiRowRawRecord(client, snapshot) {
  const candidates = await client.query(
    `SELECT id
     FROM osv_vulns
     GROUP BY id
     HAVING COUNT(*) > 1
       AND BOOL_AND(ecosystem = 'npm')
       AND BOOL_OR(ranges @? '$.ranges[*].events[*].fixed')
       AND BOOL_AND(jsonb_array_length(COALESCE(ranges->'versions', '[]'::jsonb)) > 0)
     ORDER BY id
     LIMIT 250`,
  );

  for (const candidate of candidates.rows) {
    const rows = await getOsvVulnerabilityRowsByIdentifier(client, candidate.id);
    assert.ok(rows, `OSV rows ${candidate.id} disappeared during parity test`);
    const baseEcosystems = new Set(rows.map(row => baseOsvEcosystem(row.ecosystem)));
    if (rows.length <= 1 || baseEcosystems.size !== 1) continue;

    const raw = await rawRecordForRow(rows[0], snapshot.snapshotDate);
    const projectedRows = osvRowsFromRecord(raw, baseOsvEcosystem(rows[0].ecosystem));
    const projectedKeys = projectedRows
      .map(row => JSON.stringify([row.ecosystem, row.packageName]))
      .sort();
    const storedKeys = rows
      .map(row => JSON.stringify([row.ecosystem, row.packageName]))
      .sort();
    if (
      projectedRows.length > 1
      && JSON.stringify(projectedKeys) === JSON.stringify(storedKeys)
    ) {
      return { raw, rows, projectedRows };
    }
  }

  assert.fail('No real multi-row OSV advisory with a fixed version satisfied the parity-test predicate');
}

test('stored OSV round trip preserves real fixed-version minimization', async context => {
  await withDatabase(context, async client => {
    const snapshot = await paritySnapshot(context, client);
    if (!snapshot) return;
    const { raw, rows } = await findSingleRowRawRecord(
      client,
      snapshot,
      `ranges @? '$.ranges[*].events[*].fixed'`,
      record => record.affected.some(affected => (
        (affected.ranges ?? []).some(range => (
          (range.events ?? []).some(event => event.fixed !== undefined)
        ))
      )),
    );
    const [row] = rows;
    const expected = minimizedVulnerability(raw, row);
    // matchOsvPackages deliberately returns the stored canonical raw advisory, so matcher-side
    // shape parity is direct by design; this guard pins that contract against the source archive.
    const actual = minimizedVulnerability(await matchedAdvisoryForRow(client, row), row);

    assert.ok(raw.affected.some(affected => (
      (affected.ranges ?? []).some(range => (
        (range.events ?? []).some(event => event.fixed !== undefined)
      ))
    )));
    assert.ok(expected.fixed_versions.length > 0);
    assert.deepEqual(actual, expected);
  });
});

test('stored OSV round trip preserves real database-specific severity fallback', async context => {
  await withDatabase(context, async client => {
    const snapshot = await paritySnapshot(context, client);
    if (!snapshot) return;
    const { raw, rows } = await findSingleRowRawRecord(
      client,
      snapshot,
      `CASE
         WHEN jsonb_typeof(severity) = 'array' THEN jsonb_array_length(severity)
         ELSE 0
       END = 0
       AND database_specific ? 'severity'`,
      record => (
        (!Array.isArray(record.severity) || record.severity.length === 0)
        && typeof record.database_specific?.severity === 'string'
        && record.database_specific.severity.length > 0
      ),
    );
    const [row] = rows;
    const expected = minimizedVulnerability(raw, row);
    // This comparison is intentionally direct: the matcher returns the canonical raw record.
    const actual = minimizedVulnerability(await matchedAdvisoryForRow(client, row), row);

    assert.ok(!Array.isArray(raw.severity) || raw.severity.length === 0);
    assert.ok(typeof raw.database_specific?.severity === 'string');
    assert.deepEqual(expected.severity, [{
      type: 'DATABASE_SPECIFIC',
      score: raw.database_specific.severity,
    }]);
    assert.deepEqual(actual, expected);
  });
});

test('stored OSV round trip preserves real multi-package range and fix minimization', async context => {
  await withDatabase(context, async client => {
    const snapshot = await paritySnapshot(context, client);
    if (!snapshot) return;
    const { raw, rows, projectedRows } = await findMultiRowRawRecord(client, snapshot);
    const expected = minimizedVulnerability(raw, rows[0]);
    // The matcher returns this complete canonical multi-package record rather than narrowing it.
    const actual = minimizedVulnerability(await matchedAdvisoryForRow(client, rows[0]), rows[0]);

    assert.ok(projectedRows.length > 1);
    assert.ok(raw.affected.length > 1);
    assert.ok(expected.fixed_versions.length > 0);
    context.diagnostic(`multi-package parity advisory ${raw.id} projects to ${projectedRows.length} rows`);
    assert.deepEqual(actual, expected);
  });
});

test('OSV identifier lookup resolves a real CVE alias to its primary record', async context => {
  await withDatabase(context, async client => {
    const candidate = await client.query(
      `SELECT id, alias
       FROM osv_vulns
       CROSS JOIN LATERAL jsonb_array_elements_text(aliases) AS alias
       WHERE alias LIKE 'CVE-%' AND id <> alias
       ORDER BY id, ecosystem, package, alias
       LIMIT 1`,
    );
    assert.equal(candidate.rowCount, 1, 'snapshot must contain a CVE alias');

    const advisory = await getOsvAdvisoryByIdentifier(client, candidate.rows[0].alias);
    assert.ok(advisory);
    assert.equal(advisory.id, candidate.rows[0].id);
    assert.ok(advisory.aliases.includes(candidate.rows[0].alias));

    const canonical = await client.query(
      'SELECT record FROM osv_advisories WHERE id = $1',
      [candidate.rows[0].id],
    );
    assert.equal(canonical.rowCount, 1);
    assert.deepEqual(advisory, canonical.rows[0].record);
  });
});
