import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import 'dotenv/config';
import pg from 'pg';

const { config } = await import('../../lib/config.ts');
const { OSVSourceUnavailableError } = await import('../../lib/osv/errors.ts');
const { createOsvQueryHandler } = await import('./osv-query.ts');

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

async function databaseAvailable(context, reason) {
  if (!process.env.DATABASE_URL) {
    context.skip(`DATABASE_URL is not configured; skipping ${reason}`);
    return false;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    return true;
  } catch (error) {
    if (isDatabaseUnreachable(error)) {
      context.skip(`DATABASE_URL is configured but Postgres is unreachable; skipping ${reason}`);
      return false;
    }
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

async function scannerAvailable(context, reason) {
  try {
    await execFileAsync(config.OSV_SCANNER_PATH, ['--version'], { encoding: 'utf8' });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      context.skip(`osv-scanner is unavailable; skipping ${reason}`);
      return false;
    }
    throw error;
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
}

function syntheticAdvisory(id, aliases = []) {
  return {
    id,
    aliases,
    summary: 'Synthetic advisory',
    details: 'Synthetic advisory details',
    modified: '2026-09-02T00:00:00Z',
    published: '2026-01-01T00:00:00Z',
    affected: [],
    references: [],
  };
}

function offlineDependencies(overrides = {}) {
  return {
    osvMode: 'offline',
    osvClient: {
      async query() {
        throw new Error('injected offline test must not query Postgres');
      },
    },
    async fetch() {
      throw new Error('offline query must not call the hosted OSV API');
    },
    async getCurrentOsvSnapshot() {
      return { snapshotDate: '2026-09-02' };
    },
    ...overrides,
  };
}

test('osv-query rejects a traversal-shaped CVE before making an outbound request', async () => {
  let outboundRequests = 0;
  const handler = createOsvQueryHandler({
    async fetch() {
      outboundRequests += 1;
      throw new Error('Invalid CVE input must not reach OSV');
    },
  });

  const response = responseRecorder();
  await handler({
    method: 'POST',
    body: {
      cve: '../../etc/passwd',
      sessionId: '00000000-0000-4000-8000-000000000001',
    },
  }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.jsonBody.error, 'Invalid CVE ID');
  assert.match(response.jsonBody.details, /Expected a CVE identifier/);
  assert.equal(outboundRequests, 0);
});

test('offline identifier alias resolution is disclosed to the client and model', async () => {
  const requestedIdentifier = 'CVE-2021-23337';
  const resolvedAdvisoryId = 'GHSA-35jh-r3h4-6jhm';
  const advisory = syntheticAdvisory(resolvedAdvisoryId, [requestedIdentifier]);
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const conversationId = 'conversation_osv_alias_disclosure';
  let appended;
  const handler = createOsvQueryHandler(offlineDependencies({
    async getOsvAdvisoryByIdentifier(_client, identifier) {
      assert.equal(identifier, requestedIdentifier);
      return advisory;
    },
    async getConversationSessionId() {
      return sessionId;
    },
    async appendConversationMessages(options) {
      appended = options;
      return [];
    },
  }));

  const response = responseRecorder();
  await handler({
    method: 'POST',
    body: { cve: requestedIdentifier, sessionId, conversationId },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.ok(response.jsonBody.result.aliases.includes(requestedIdentifier));
  assert.deepEqual(response.jsonBody.identifierResolution, {
    requestedIdentifier,
    resolvedAdvisoryId,
    resolvedViaAlias: true,
  });
  assert.equal(appended.messages.length, 1);
  assert.match(
    appended.messages[0].content,
    new RegExp(`Offline snapshot note: Requested identifier ${requestedIdentifier} is an alias of advisory ${resolvedAdvisoryId}; the details below are for ${resolvedAdvisoryId}\\.`),
  );
});

test('offline primary identifier resolution does not claim an alias substitution', async () => {
  const requestedIdentifier = 'CVE-2024-0001';
  const advisory = syntheticAdvisory(requestedIdentifier);
  const sessionId = '00000000-0000-4000-8000-000000000001';
  let appended;
  const handler = createOsvQueryHandler(offlineDependencies({
    async getOsvAdvisoryByIdentifier() {
      return advisory;
    },
    async getConversationSessionId() {
      return sessionId;
    },
    async appendConversationMessages(options) {
      appended = options;
      return [];
    },
  }));

  const response = responseRecorder();
  await handler({
    method: 'POST',
    body: {
      cve: requestedIdentifier,
      sessionId,
      conversationId: 'conversation_osv_primary_resolution',
    },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.jsonBody.identifierResolution, {
    requestedIdentifier,
    resolvedAdvisoryId: requestedIdentifier,
    resolvedViaAlias: false,
  });
  assert.doesNotMatch(appended.messages[0].content, /Offline snapshot note:/);
});

test('offline package lookup returns real vulnerabilities from the pinned snapshot', async context => {
  if (!await databaseAvailable(context, 'offline OSV package route test')) return;
  if (!await scannerAvailable(context, 'offline OSV package route test')) return;

  const handler = createOsvQueryHandler({
    osvMode: 'offline',
    async fetch() {
      throw new Error('offline package lookup must not call the hosted OSV API');
    },
  });
  const response = responseRecorder();
  await handler({
    method: 'POST',
    body: {
      name: 'lodash',
      version: '4.17.20',
      ecosystem: 'npm',
      sessionId: '00000000-0000-4000-8000-000000000001',
    },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.jsonBody.result.vulns));
  assert.ok(response.jsonBody.result.vulns.length > 0);
  assert.ok(response.jsonBody.result.vulns.every(vulnerability => (
    typeof vulnerability.id === 'string' && vulnerability.id.length > 0
  )));
});

test('offline responses distinguish absence, source failure, and unanswerable queries', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';

  const absentIdentifierHandler = createOsvQueryHandler(offlineDependencies({
    async getOsvAdvisoryByIdentifier() {
      return null;
    },
  }));
  const absentIdentifierResponse = responseRecorder();
  await absentIdentifierHandler({
    method: 'POST',
    body: { cve: 'CVE-2099-0001', sessionId },
  }, absentIdentifierResponse);
  assert.equal(absentIdentifierResponse.statusCode, 404);
  assert.match(absentIdentifierResponse.jsonBody.error, /not found/);

  const absentPackageHandler = createOsvQueryHandler(offlineDependencies({
    async matchOsvPackages(_client, packages) {
      return packages.map(package_ => ({ package: package_, vulnerabilities: [] }));
    },
  }));
  const absentPackageResponse = responseRecorder();
  await absentPackageHandler({
    method: 'POST',
    body: { name: 'absent-package', version: '1.0.0', ecosystem: 'npm', sessionId },
  }, absentPackageResponse);
  assert.equal(absentPackageResponse.statusCode, 200);
  assert.deepEqual(absentPackageResponse.jsonBody.result, { vulns: [] });

  const unreadableIdentifierHandler = createOsvQueryHandler(offlineDependencies({
    async getCurrentOsvSnapshot() {
      throw new OSVSourceUnavailableError();
    },
  }));
  const unreadableIdentifierResponse = responseRecorder();
  await unreadableIdentifierHandler({
    method: 'POST',
    body: { cve: 'CVE-2021-23337', sessionId },
  }, unreadableIdentifierResponse);
  assert.equal(unreadableIdentifierResponse.statusCode, 500);
  assert.equal(
    unreadableIdentifierResponse.jsonBody.details,
    'OSV vulnerability source is unavailable',
  );

  const unreadablePackageHandler = createOsvQueryHandler(offlineDependencies({
    async matchOsvPackages() {
      throw new OSVSourceUnavailableError();
    },
  }));
  const unreadablePackageResponse = responseRecorder();
  await unreadablePackageHandler({
    method: 'POST',
    body: { name: 'lodash', version: '4.17.20', ecosystem: 'npm', sessionId },
  }, unreadablePackageResponse);
  assert.equal(unreadablePackageResponse.statusCode, 500);
  assert.equal(
    unreadablePackageResponse.jsonBody.details,
    'OSV vulnerability source is unavailable',
  );

  const versionlessResponse = responseRecorder();
  await unreadablePackageHandler({
    method: 'POST',
    body: { name: 'lodash', ecosystem: 'npm', sessionId },
  }, versionlessResponse);
  assert.equal(versionlessResponse.statusCode, 400);
  assert.equal(
    versionlessResponse.jsonBody.error,
    'Package version is required when OSV_MODE=offline',
  );
});
