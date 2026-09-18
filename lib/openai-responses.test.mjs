import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { promisify } from 'node:util';

import 'dotenv/config';
import pg from 'pg';

const { config } = await import('./config.ts');
const { buildBombotInstructions, createFunctionCallExecutor } = await import('./openai-responses.ts');

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

async function databaseAvailable(context) {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping offline model-tool snapshot test');
    return false;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    return true;
  } catch (error) {
    if (isDatabaseUnreachable(error)) {
      context.skip('DATABASE_URL is configured but Postgres is unreachable; skipping offline model-tool snapshot test');
      return false;
    }
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

async function scannerAvailable(context) {
  try {
    await execFileAsync(config.OSV_SCANNER_PATH, ['--version'], { encoding: 'utf8' });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      context.skip('osv-scanner is unavailable; skipping offline model-tool snapshot test');
      return false;
    }
    throw error;
  }
}

function offlineDependencies(overrides = {}) {
  return {
    osvMode: 'offline',
    osvBaseUrl: undefined,
    osvClient: {
      async query() {
        throw new Error('injected offline model-tool test must not query Postgres');
      },
    },
    async fetch() {
      throw new Error('offline model tool must not call the hosted OSV API');
    },
    async getCurrentOsvSnapshot() {
      return { snapshotDate: '2026-09-02' };
    },
    ...overrides,
  };
}

test('hosted model instructions remain byte-identical after OSV provenance becomes conditional', () => {
  const hostedInstructions = buildBombotInstructions('api');

  assert.equal(Buffer.byteLength(hostedInstructions, 'utf8'), 7696);
  assert.equal(
    createHash('sha256').update(hostedInstructions, 'utf8').digest('hex'),
    '1e4850d848f1b7e68262e6d1dbc40b4effb4c662564b17dede24fdcf3c6c5f71',
  );
});

test('offline model instructions disclose pinned provenance without vulnerability-data currency claims', () => {
  const offlineInstructions = buildBombotInstructions('offline');
  const currencyClaim = /(?:\b(?:real[- ]?time|current|up[- ]?to[- ]?date|latest|timely)\b[^\n.!?]{0,80}\b(?:vulnerabilit(?:y|ies)|data|database|information|advice)\b|\b(?:vulnerabilit(?:y|ies)|data|database|information|advice)\b[^\n.!?]{0,80}\b(?:real[- ]?time|current|up[- ]?to[- ]?date|latest|timely)\b)/i;

  assert.match(offlineInstructions, /vulnerability data from (?:a|the) pinned local snapshot/i);
  assert.doesNotMatch(offlineInstructions, currencyClaim);
  assert.match(offlineInstructions, /Provide confidence through accurate information and clear guidance/);
  assert.match(offlineInstructions, /ensure your advice is grounded in the pinned local snapshot and comprehensive/);
});

test('offline CVE tool discloses an alias-resolved advisory substitution', async () => {
  const requestedIdentifier = 'CVE-2021-23337';
  const resolvedAdvisoryId = 'GHSA-35jh-r3h4-6jhm';
  const executor = createFunctionCallExecutor(offlineDependencies({
    async getOsvAdvisoryByIdentifier(_client, identifier) {
      assert.equal(identifier, requestedIdentifier);
      return {
        id: resolvedAdvisoryId,
        aliases: [requestedIdentifier],
        modified: '2026-09-02T00:00:00Z',
        affected: [],
      };
    },
  }));

  const result = JSON.parse(await executor(
    'query_cve_details',
    JSON.stringify({ cve_id: requestedIdentifier }),
  ));

  assert.equal(result.success, true);
  assert.equal(result.source, 'offline_osv_snapshot');
  assert.equal(result.requested_identifier, requestedIdentifier);
  assert.equal(result.resolved_advisory_id, resolvedAdvisoryId);
  assert.equal(result.resolved_via_alias, true);
  assert.ok(result.advisory.aliases.includes(requestedIdentifier));
  assert.equal(
    result.notice,
    `Offline snapshot substitution: requested identifier ${requestedIdentifier} is an alias of advisory ${resolvedAdvisoryId}; the returned details are for ${resolvedAdvisoryId}.`,
  );
});

test('offline CVE tool does not claim substitution for a primary identifier', async () => {
  const requestedIdentifier = 'CVE-2024-0001';
  const executor = createFunctionCallExecutor(offlineDependencies({
    async getOsvAdvisoryByIdentifier() {
      return {
        id: requestedIdentifier,
        aliases: [],
        modified: '2026-09-02T00:00:00Z',
        affected: [],
      };
    },
  }));

  const result = JSON.parse(await executor(
    'query_cve_details',
    JSON.stringify({ cve_id: requestedIdentifier }),
  ));

  assert.equal(result.success, true);
  assert.equal(result.resolved_advisory_id, requestedIdentifier);
  assert.equal(result.resolved_via_alias, false);
  assert.equal(Object.hasOwn(result, 'notice'), false);
});

test('offline package tool invokes the matcher once and refuses versionless queries visibly', async () => {
  let matcherInvocations = 0;
  const executor = createFunctionCallExecutor(offlineDependencies({
    async matchOsvPackages(_client, packages) {
      matcherInvocations += 1;
      assert.deepEqual(packages, [{ name: 'lodash', ecosystem: 'npm', version: '4.17.20' }]);
      return [{
        package: packages[0],
        vulnerabilities: [{ id: 'GHSA-synthetic', modified: '2026-09-02T00:00:00Z', affected: [] }],
      }];
    },
  }));

  const matched = JSON.parse(await executor(
    'query_package_vulnerabilities',
    JSON.stringify({ name: 'lodash', ecosystem: 'npm', version: '4.17.20' }),
  ));
  assert.equal(matched.success, true);
  assert.equal(matched.status, 'ok');
  assert.equal(matched.vulns.length, 1);
  assert.equal(matcherInvocations, 1);

  const versionless = JSON.parse(await executor(
    'query_package_vulnerabilities',
    JSON.stringify({ name: 'lodash', ecosystem: 'npm' }),
  ));
  assert.deepEqual(versionless, {
    success: false,
    source: 'offline_osv_snapshot',
    status: 'unsupported_query',
    error: 'Offline OSV matching requires an exact package version; no vulnerability lookup was performed.',
    query: { name: 'lodash', ecosystem: 'npm' },
  });
  assert.equal(matcherInvocations, 1);

  await assert.rejects(
    executor(
      'query_package_vulnerabilities',
      JSON.stringify({ name: 'package', ecosystem: 'Unknown', version: '1.0.0' }),
    ),
    /Invalid arguments for query_package_vulnerabilities/,
  );
});

test('offline model tools distinguish absence and source failure from clean results', async () => {
  const internalDiagnostic = 'lodash CVE-2099-0001 participant message /private/internal/osv.db';
  const loggedFailures = [];
  const originalConsoleError = console.error;
  console.error = (...values) => loggedFailures.push(values);
  const unavailableExecutor = createFunctionCallExecutor(offlineDependencies({
    async getCurrentOsvSnapshot() {
      throw new Error(internalDiagnostic);
    },
    async matchOsvPackages() {
      throw new Error(internalDiagnostic);
    },
  }));

  let unavailableCve;
  let unavailablePackage;
  try {
    unavailableCve = JSON.parse(await unavailableExecutor(
      'query_cve_details',
      JSON.stringify({ cve_id: 'CVE-2021-23337' }),
    ));
    unavailablePackage = JSON.parse(await unavailableExecutor(
      'query_package_vulnerabilities',
      JSON.stringify({ name: 'lodash', ecosystem: 'npm', version: '4.17.20' }),
    ));
  } finally {
    console.error = originalConsoleError;
  }

  for (const unavailable of [unavailableCve, unavailablePackage]) {
    assert.equal(unavailable.success, false);
    assert.equal(unavailable.status, 'source_unavailable');
    assert.equal(
      unavailable.error,
      'The offline OSV vulnerability source is unavailable; no vulnerability lookup was performed.',
    );
    assert.doesNotMatch(JSON.stringify(unavailable), new RegExp(internalDiagnostic));
  }
  assert.equal(Object.hasOwn(unavailablePackage, 'vulns'), false);
  assert.equal(loggedFailures.length, 2);
  assert.deepEqual(loggedFailures, [
    ['Offline OSV model-tool lookup failed:', 'Error'],
    ['Offline OSV model-tool lookup failed:', 'Error'],
  ]);
  assert.doesNotMatch(JSON.stringify(loggedFailures), /lodash|CVE-2099|participant|osv\.db/);

  const absentExecutor = createFunctionCallExecutor(offlineDependencies({
    async getOsvAdvisoryByIdentifier() {
      return null;
    },
  }));
  const absent = JSON.parse(await absentExecutor(
    'query_cve_details',
    JSON.stringify({ cve_id: 'CVE-2099-0001' }),
  ));
  assert.equal(absent.success, false);
  assert.equal(absent.status, 'not_found');
  assert.match(absent.error, /not found in the pinned offline OSV snapshot/);
});

test('offline package tool returns real vulnerabilities from the pinned snapshot', async context => {
  if (!await databaseAvailable(context)) return;
  if (!await scannerAvailable(context)) return;

  const executor = createFunctionCallExecutor({ osvMode: 'offline', osvBaseUrl: undefined });
  const result = JSON.parse(await executor(
    'query_package_vulnerabilities',
    JSON.stringify({ name: 'lodash', ecosystem: 'npm', version: '4.17.20' }),
  ));

  assert.equal(result.success, true);
  assert.equal(result.source, 'offline_osv_snapshot');
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.vulns));
  assert.ok(result.vulns.length > 0);
});

test('hosted model tools preserve their existing requests and raw return shapes', async () => {
  const requests = [];
  const executor = createFunctionCallExecutor({
    osvMode: 'api',
    osvBaseUrl: 'https://api.osv.test',
    async fetch(url, init) {
      requests.push({ url, init });
      if (init.method === 'GET') {
        return new Response(JSON.stringify({ id: 'CVE-2024-0001' }), { status: 200 });
      }
      return new Response(JSON.stringify({ vulns: [{ id: 'GHSA-hosted' }] }), { status: 200 });
    },
  });

  const packageResult = JSON.parse(await executor(
    'query_package_vulnerabilities',
    JSON.stringify({ name: 'lodash', ecosystem: 'npm' }),
  ));
  const cveResult = JSON.parse(await executor(
    'query_cve_details',
    JSON.stringify({ cve_id: 'cve-2024-0001' }),
  ));

  assert.deepEqual(packageResult, { vulns: [{ id: 'GHSA-hosted' }] });
  assert.deepEqual(cveResult, { id: 'CVE-2024-0001' });
  assert.equal(requests[0].url, 'https://api.osv.test/v1/query');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    package: { name: 'lodash', ecosystem: 'npm' },
  });
  assert.equal(requests[1].url, 'https://api.osv.test/v1/vulns/CVE-2024-0001');
  assert.equal(requests[1].init.method, 'GET');
});
