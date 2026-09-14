import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'dotenv/config';
import { Pool } from 'pg';

import { startLedgerSink } from './sink.mjs';

const { buildBombotInstructions } = await import('../../lib/openai-responses.ts');

const ledgerDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(ledgerDir, '../..');
const fixturesDir = path.join(repoRoot, 'tests/fixtures');
const profile = process.argv[2];
assert.ok(profile === 'hosted' || profile === 'offline', 'Ledger profile must be hosted or offline');
const expectedInstructions = buildBombotInstructions(profile === 'hosted' ? 'api' : 'offline');
const expectedPath = path.join(
  ledgerDir,
  profile === 'hosted' ? 'expected.json' : 'expected-offline.json',
);
const ledgerPath = path.join(
  ledgerDir,
  profile === 'hosted' ? 'ledger-current.json' : 'ledger-offline.json',
);
const hostedLedgerPath = path.join(ledgerDir, 'ledger-current.json');
const documentPath = path.join(repoRoot, 'docs/DISCLOSURE_LEDGER.md');
const interceptPath = path.join(ledgerDir, 'intercept.mjs');

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve application port');
  const { port } = address;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForApplication(origin, child, readLogs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js ledger process exited early (${child.exitCode})\n${readLogs()}`);
    }
    try {
      const response = await fetch(`${origin}/api/stream`);
      if (response.status === 400) return;
    } catch {
      // The dev server has not bound the port yet.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Next.js ledger process\n${readLogs()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
}

async function parseJsonResponse(response, label, allowedStatuses = null) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text}`);
  }

  const allowed = allowedStatuses
    ? allowedStatuses.includes(response.status)
    : response.ok;
  if (!allowed) throw new Error(`${label} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function uploadFixture(appOrigin, fixtureName, fields = {}, allowedStatuses = null) {
  const bytes = await readFile(path.join(fixturesDir, fixtureName));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/json' }), fixtureName);
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  const response = await fetch(`${appOrigin}/api/upload`, { method: 'POST', body: form });
  return parseJsonResponse(response, `upload ${fixtureName}`, allowedStatuses);
}

async function postJson(appOrigin, route, body, label) {
  const response = await fetch(`${appOrigin}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJsonResponse(response, label);
}

async function streamToCompletion(appOrigin, conversationId, sessionId, messageIndex) {
  const params = new URLSearchParams({
    conversationId,
    sessionId,
    messageIndex: String(messageIndex),
  });
  const response = await fetch(`${appOrigin}/api/stream?${params}`);
  assert.equal(response.ok, true);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);
  const frames = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean);
  const events = frames.flatMap(frame => {
    if (frame.startsWith(':')) return [];
    const event = frame.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim();
    const dataText = frame.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim();
    return event && dataText ? [{ event, data: JSON.parse(dataText) }] : [];
  });
  const error = events.find(event => event.event === 'error');
  if (error) throw new Error(`Synthetic Response failed: ${JSON.stringify(error.data)}`);
  const done = events.find(event => event.event === 'done');
  assert.ok(done);
  assert.equal(typeof done.data.response, 'string');
  assert.ok(done.data.response.length > 0);
  assert.equal(events.filter(event => event.event === 'tool_start').length, 0);
  return done.data;
}

function countSinkRequests(requests, host, requestPath, method = null) {
  return requests.filter(request => (
    request.host === host
    && request.path === requestPath
    && (!method || request.method === method)
  )).length;
}

function parseInterceptLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function hostMatches(pattern, host) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
}

function aggregateDestinations(records) {
  const destinations = new Map();

  for (const record of records) {
    if (!destinations.has(record.host)) {
      destinations.set(record.host, {
        host: record.host,
        requestCount: 0,
        totalRequestBodySize: 0,
        maxRequestBodySize: 0,
        carriesInventory: false,
        matchedMarkers: new Set(),
      });
    }
    const destination = destinations.get(record.host);
    destination.requestCount += 1;
    destination.totalRequestBodySize += record.requestBodySize;
    destination.maxRequestBodySize = Math.max(destination.maxRequestBodySize, record.requestBodySize);
    destination.carriesInventory ||= record.classification === 'CARRIES_INVENTORY';
    for (const marker of record.matchedMarkers) destination.matchedMarkers.add(marker);
  }

  return [...destinations.values()]
    .map(destination => ({
      ...destination,
      classification: destination.carriesInventory
        ? 'CARRIES_INVENTORY'
        : 'INVENTORY_INDEPENDENT',
      matchedMarkers: [...destination.matchedMarkers].sort(),
    }))
    .sort((left, right) => left.host.localeCompare(right.host));
}

function markdownDocument(hostedLedger, offlineLedger) {
  const yesNo = value => value ? '**Yes**' : 'No';
  const destinationRows = [hostedLedger, offlineLedger].flatMap(ledger => (
    ledger.destinations.map(item => (
      `| ${ledger.profile} | \`${item.host}\` | ${item.requestCount} | ${item.totalRequestBodySize} | ${item.maxRequestBodySize} | ${yesNo(item.carriesInventory)} |`
    ))
  ));
  const hostedOsv = hostedLedger.destinations.find(item => item.host === 'api.osv.dev');
  const hostedOpenAi = hostedLedger.destinations.find(item => item.host === 'api.openai.com');
  const offlineOpenAi = offlineLedger.destinations.find(item => item.host === 'api.openai.com');
  const hostedPackageRequests = hostedLedger.runs.smallSpdx.osvRequestCount
    + hostedLedger.regressionGuards.oversizeSpdxOsvQueries
    + 1;
  const hostedIdentifierRequests = (hostedOsv?.requestCount ?? 0) - hostedPackageRequests;

  return `# Disclosure Ledger — Hosted and Offline Measurement

This document is generated by \`npm run ledger:build\` using entirely synthetic SBOM data.
Do not edit this file directly; make documentation changes in \`markdownDocument()\` in
\`tests/ledger/run-ledger.mjs\` so regeneration preserves them.
For each profile, the application emits real HTTP to a loopback recording sink. A
\`globalThis.fetch\` interceptor independently records logical destinations, request-body
sizes, and fixture markers. No live OpenAI credits or live external endpoints are used.

The SBOM inputs are synthetic in both profiles, but the vulnerability data is not equally
realistic: the hosted profile receives deterministic synthetic OSV responses from the loopback
sink, while the offline profile receives real advisory data from the pinned local snapshot.
Consequently, the OSV host and request-count comparison remains a valid observation of the two
data paths, but the OpenAI request-body byte totals are descriptive results of these particular
inputs, not a causal estimate of the architectural change. A causal byte comparison would require
both profiles to consume the same vulnerability records and identifier semantics.

## Automated host comparison

| Profile | Host | Requests | Total request-body bytes | Largest single body (bytes) | Carries SBOM-derived content? |
|---|---|---:|---:|---:|---|
${destinationRows.join('\n')}

The hosted run contacted **${hostedLedger.destinations.length}** logical hosts and the offline
run contacted **${offlineLedger.destinations.length}**. OpenAI remains present in both profiles
(${hostedOpenAi?.requestCount ?? 0} hosted requests; ${offlineOpenAi?.requestCount ?? 0} offline
requests). The offline run recorded no \`api.osv.dev\` destination.

## Disclosure-row comparison

| ID | Destination | Hosted observation | Offline observation | Offline disposition and evidence |
|---|---|---|---|---|
| D1 | \`api.openai.com/v1/responses\` | ${hostedOpenAi?.requestCount ?? 0} intercepted requests carrying fixture markers | ${offlineOpenAi?.requestCount ?? 0} intercepted requests carrying fixture markers | Retained in both profiles; measured by the fetch interceptor and loopback sink. |
| D3 | \`api.osv.dev/v1/query\` | ${hostedPackageRequests} intercepted package queries | 0 intercepted requests | Removed from the offline disclosure rows. Fetch-level absence is measured; route assertions prove that the local matcher returned real vulnerabilities. Code inspection establishes that the offline branches call the local matcher instead of \`fetch\`. |
| D4 | \`api.osv.dev/v1/vulns/{id}\` | ${hostedIdentifierRequests} intercepted identifier lookup | 0 intercepted requests | Removed from the offline disclosure rows. Fetch-level absence is measured; code inspection establishes local alias lookup. This is **not equivalence**: the successful offline lookup returns advisory \`${offlineLedger.executionProof.identifier.resolvedAdvisoryId}\`, reached because requested CVE \`${offlineLedger.executionProof.identifier.requestedIdentifier}\` is its alias. |
| D6 | Vercel edge + runtime | Manual deployment property | Manual deployment property | Retained; not observable from in-process interception. |

Vercel TLS termination/runtime handling (D6) must remain a manual row. Its absence from
automated interception must not be read as absence from the deployed system.

INC-05 removes OpenAI-hosted conversation retention (former row D2), but **transit
disclosure is unchanged**: the same inventory-derived content still crosses the same
boundary to OpenAI through D1. This is a retention change, not a reduction in what OpenAI
receives in transit.

## Regression guards

- Hosted: the synthetic 200-package SPDX fixture produced exactly **${hostedLedger.regressionGuards.oversizeSpdxOsvQueries}** intercepted OSV package queries; the small fixture produced **${hostedLedger.runs.smallSpdx.osvRequestCount}** for 12 packages.
- Offline: those fixtures produced **${offlineLedger.regressionGuards.oversizeSpdxOsvQueries}** and **${offlineLedger.runs.smallSpdx.osvRequestCount}** intercepted OSV HTTP requests respectively, while still scanning 150 and 12 packages.
- This makes the existing 150-package cap observable. It is a regression guard, not evidence that a live study input was truncated.
- INC-01 changes observation only; it does not change the cap or application request behavior.

## Offline execution proof

Zero intercepted OSV requests is not treated as proof that the offline path ran. This run also
required all of the following application-level outcomes before writing the artifact:

- The database reported snapshot date \`${offlineLedger.executionProof.snapshot.snapshotDate}\`,
  \`max_modified\` \`${offlineLedger.executionProof.snapshot.maxModified}\`,
  ${offlineLedger.executionProof.snapshot.advisoryRows} advisory rows, and
  ${offlineLedger.executionProof.snapshot.vulnerabilityRows} package-vulnerability rows.
- Uploading the 12-package fixture completed an offline batch scan and returned
  **${offlineLedger.executionProof.smallUpload.vulnerabilitiesFound}** real vulnerabilities.
- The offline package-query route returned
  **${offlineLedger.executionProof.packageQuery.vulnerabilitiesFound}** vulnerabilities for
  \`${offlineLedger.executionProof.packageQuery.package}@${offlineLedger.executionProof.packageQuery.version}\`.
- The identifier route resolved requested CVE
  \`${offlineLedger.executionProof.identifier.requestedIdentifier}\` through an alias to
  differently-keyed advisory \`${offlineLedger.executionProof.identifier.resolvedAdvisoryId}\`.

Together these assertions establish that Postgres, the pinned snapshot, and the scanner were
usable end to end; they do not establish parity with hosted OSV data.

## Suppressed development-mode egress

- \`DEBUG=''\` prevents Next.js's development overlay from checking version staleness at
  \`registry.npmjs.org\`.
- \`NEXT_TELEMETRY_DISABLED=1\` disables Next.js telemetry from the spawned development
  server.

These suppressions are legitimate because both paths are \`next dev\` framework artifacts
that are absent from the production application build; neither is BOMbot application
egress.

## Measurement scope

This harness instruments \`next dev\`, not a production execution using \`next build\` and
\`next start\`. Production may differ in either direction, so the absolute egress claim is
bounded to this measurement mode. The V2 before/after delta is unaffected because both
sides are measured identically. A production-build ledger run remains future work.

The harness measures server-side egress from an instrumented \`next dev\`; it never runs a
browser. Browser-originated egress is identified by static code and bundle inspection, not
measured by this instrument. Those two evidence types must not be presented as equivalent.

A repeatability check ran the hosted profile twice consecutively with identical code and
environment. All nine OpenAI request bodies were field-for-field and byte-for-byte identical;
the aggregate total and largest-body measurements were also identical. The observed repeat noise
floor for this instrument was therefore **0 bytes** across that run pair. This establishes that
the hosted movement recorded in this regeneration is signal, not run-to-run measurement wander.

The interceptor operates specifically by replacing \`globalThis.fetch\` in the spawned Next.js
process. It positively observes calls made through that function, including the logical host of
requests proxied to the loopback sink. It cannot observe PostgreSQL socket traffic, child-process
execution, network activity performed inside \`osv-scanner\`, browser traffic, or HTTP clients
that bypass \`globalThis.fetch\`. Therefore “0 OSV requests” means zero OSV requests observed at
the instrumented fetch layer, not proof that no possible network activity occurred. The local
database/scanner explanation additionally rests on the execution assertions above and inspection
of the offline route branches.

## Instrumentation cross-check

- Hosted sink/interceptor captured every expected automated host: **${hostedLedger.instrumentation.sinkCapturedExpectedHosts}/${hostedLedger.instrumentation.interceptorCapturedExpectedHosts}**
- Offline sink/interceptor captured every expected automated host: **${offlineLedger.instrumentation.sinkCapturedExpectedHosts}/${offlineLedger.instrumentation.interceptorCapturedExpectedHosts}**
- Hosted unexpected transport hosts: **${hostedLedger.instrumentation.unexpectedTransportHosts.length === 0 ? 'none' : hostedLedger.instrumentation.unexpectedTransportHosts.join(', ')}**
- Offline unexpected transport hosts: **${offlineLedger.instrumentation.unexpectedTransportHosts.length === 0 ? 'none' : offlineLedger.instrumentation.unexpectedTransportHosts.join(', ')}**
- On its first run, the interceptor caught \`registry.npmjs.org\`, which was unpredicted by the audit, absent from \`expected.json\`, and originated in framework rather than application code—evidence that the interceptor observes the running system rather than only the author's model of it.
`;
}

const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured for the ledger harness');
}
const database = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 2_000,
});
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-ledger-'));
const interceptLog = path.join(tempDir, 'intercept.ndjson');
await writeFile(interceptLog, '');

const sink = await startLedgerSink();
const appPort = await reservePort();
const appOrigin = `http://127.0.0.1:${appPort}`;
const childLogs = [];
const nextBinary = path.join(repoRoot, 'node_modules/next/dist/bin/next');
const nodeOptions = [
  process.env.NODE_OPTIONS,
  `--import=${pathToFileURL(interceptPath).href}`,
].filter(Boolean).join(' ');
const retiredSupabaseVariables = new Set([
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]);
const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !retiredSupabaseVariables.has(name)),
);
const applicationEnvironment = {
  ...childEnvironment,
  DEBUG: '',
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_OPTIONS: nodeOptions,
  NEXT_TELEMETRY_DISABLED: '1',
  PROFILE: 'hosted',
  LLM_API_KEY: 'synthetic-ledger-llm-key',
  LLM_BASE_URL: `${sink.origin}/proxy/api.openai.com/v1`,
  LLM_MODEL: 'gpt-4o',
  LLM_TEMPERATURE: '0',
  LLM_TOP_P: '1',
  LLM_MAX_OUTPUT_TOKENS: '4096',
  LLM_SEED: 'null',
  OSV_MODE: profile === 'hosted' ? 'api' : 'offline',
  RETENTION: 'study',
  RETENTION_IDLE_HOURS: '24',
  SESSION_KEY_DIRECTORY: path.join(tempDir, 'session-keys'),
  PARTICIPANT_ID_MODE: 'email',
  LEDGER_FIXTURE_PATH: path.join(fixturesDir, 'small-spdx.json'),
  LEDGER_INTERCEPT_LOG: interceptLog,
  LEDGER_SINK_ORIGIN: sink.origin,
  LEDGER_BLOCK_EXTERNAL: '1',
};
if (profile === 'hosted') {
  applicationEnvironment.OSV_BASE_URL = `${sink.origin}/proxy/api.osv.dev`;
} else {
  delete applicationEnvironment.OSV_BASE_URL;
}

const child = spawn(process.execPath, [nextBinary, 'dev', '-H', '127.0.0.1', '-p', String(appPort)], {
  cwd: repoRoot,
  env: applicationEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const collectLog = chunk => {
  childLogs.push(chunk.toString());
  if (childLogs.join('').length > 40_000) childLogs.shift();
};
child.stdout.on('data', collectLog);
child.stderr.on('data', collectLog);
const readLogs = () => childLogs.join('');

let oversizeSpdxOsvQueries;
let smallSpdxOsvQueries;
const sessionId = `ledger-${profile}-synthetic-session`;
const oversizeSessionId = `ledger-${profile}-oversize-session`;
let databaseReady = false;
let offlineExecutionProof = null;
let snapshotProof = null;

try {
  await database.query('DELETE FROM chat_logs WHERE session_id = $1', [sessionId]);
  await database.query('DELETE FROM conversations WHERE session_id = $1', [sessionId]);
  await database.query('DELETE FROM chat_logs WHERE session_id = $1', [oversizeSessionId]);
  await database.query('DELETE FROM conversations WHERE session_id = $1', [oversizeSessionId]);
  databaseReady = true;
  if (profile === 'offline') {
    const snapshotResult = await database.query(
      `SELECT
        snapshot_date::text AS "snapshotDate",
        to_char(max_modified AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "databaseMaxModified",
        (SELECT COUNT(*)::int FROM osv_advisories) AS "advisoryRows",
        (SELECT COUNT(*)::int FROM osv_vulns) AS "vulnerabilityRows"
       FROM osv_snapshots
       ORDER BY ingested_at DESC
       LIMIT 1`,
    );
    assert.equal(snapshotResult.rows.length, 1, 'Offline ledger requires one current OSV snapshot');
    snapshotProof = {
      ...snapshotResult.rows[0],
      maxModified: expected.snapshot.maxModified,
    };
    assert.equal(snapshotProof.snapshotDate, expected.snapshot.snapshotDate);
    assert.equal(snapshotProof.databaseMaxModified, expected.snapshot.databaseMaxModified);
    assert.ok(snapshotProof.advisoryRows > 0);
    assert.ok(snapshotProof.vulnerabilityRows > 0);
  }
  await waitForApplication(appOrigin, child, readLogs);

  const malformed = await uploadFixture(appOrigin, 'malformed.json', { sessionId }, [400]);
  assert.match(malformed.error, /No packages found/);

  const beforeSmallSpdx = countSinkRequests(sink.requests, 'api.osv.dev', '/v1/query', 'POST');
  const upload = await uploadFixture(appOrigin, 'small-spdx.json', {
    sessionId,
    messageIndex: 1,
  });
  const afterSmallSpdx = countSinkRequests(sink.requests, 'api.osv.dev', '/v1/query', 'POST');
  smallSpdxOsvQueries = afterSmallSpdx - beforeSmallSpdx;
  assert.equal(upload.packagesScanned, 12);
  assert.equal(upload.totalPackages, 12);
  assert.equal(smallSpdxOsvQueries, profile === 'hosted' ? 12 : 0);
  if (profile === 'offline') assert.ok(upload.vulnerabilitiesFound > 0);
  await streamToCompletion(appOrigin, upload.conversationId, sessionId, 1);

  const rejectedUploadReuse = await uploadFixture(appOrigin, 'small-spdx.json', {
    sessionId: 'ledger-other-session',
    conversationId: upload.conversationId,
  }, [403]);
  assert.match(rejectedUploadReuse.error, /does not belong/);

  const questions = [
    'What vulnerabilities affect lodash 4.17.20?',
    'Is minimist 1.2.5 vulnerable?',
    'Summarize axios 0.21.1 risks.',
    'What depends on SPDXRef-Package-lodash?',
    'Compare lodash 4.17.20 and axios 0.21.1.',
  ];

  for (const [index, message] of questions.entries()) {
    const messageIndex = index + 2;
    const chat = await postJson(appOrigin, '/api/chat', {
      message,
      conversationId: upload.conversationId,
      sessionId,
      messageIndex,
    }, `chat ${messageIndex}`);
    await streamToCompletion(appOrigin, chat.conversationId, sessionId, messageIndex);
  }

  const packageQuery = await postJson(appOrigin, '/api/osv-query', {
    name: 'lodash',
    version: '4.17.20',
    ecosystem: 'npm',
    conversationId: upload.conversationId,
    sessionId,
  }, 'package query');
  if (profile === 'offline') {
    assert.ok(Array.isArray(packageQuery.result?.vulns));
    assert.ok(packageQuery.result.vulns.length > 0);
  }
  await streamToCompletion(appOrigin, packageQuery.conversationId, sessionId, 7);

  const cveQuery = await postJson(appOrigin, '/api/osv-query', {
    cve: 'CVE-2021-23337',
    conversationId: upload.conversationId,
    sessionId,
  }, 'CVE query');
  if (profile === 'offline') {
    assert.equal(cveQuery.identifierResolution?.requestedIdentifier, 'CVE-2021-23337');
    assert.equal(cveQuery.identifierResolution?.resolvedViaAlias, true);
    assert.equal(typeof cveQuery.identifierResolution?.resolvedAdvisoryId, 'string');
    assert.ok(cveQuery.result?.aliases?.includes('CVE-2021-23337'));
  }
  await streamToCompletion(appOrigin, cveQuery.conversationId, sessionId, 8);

  const beforeOversize = countSinkRequests(sink.requests, 'api.osv.dev', '/v1/query', 'POST');
  const oversize = await uploadFixture(appOrigin, 'oversize-spdx.json', {
    sessionId: oversizeSessionId,
  });
  const afterOversize = countSinkRequests(sink.requests, 'api.osv.dev', '/v1/query', 'POST');
  oversizeSpdxOsvQueries = afterOversize - beforeOversize;
  assert.equal(oversize.packagesScanned, 150);
  assert.equal(oversize.totalPackages, 200);
  assert.equal(oversizeSpdxOsvQueries, profile === 'hosted' ? 150 : 0);
  await streamToCompletion(appOrigin, oversize.conversationId, oversizeSessionId, 1);

  if (profile === 'offline') {
    offlineExecutionProof = {
      snapshot: snapshotProof,
      smallUpload: {
        packagesScanned: upload.packagesScanned,
        vulnerabilitiesFound: upload.vulnerabilitiesFound,
      },
      packageQuery: {
        package: 'lodash',
        version: '4.17.20',
        vulnerabilitiesFound: packageQuery.result.vulns.length,
      },
      identifier: {
        requestedIdentifier: cveQuery.identifierResolution.requestedIdentifier,
        resolvedAdvisoryId: cveQuery.identifierResolution.resolvedAdvisoryId,
        resolvedViaAlias: cveQuery.identifierResolution.resolvedViaAlias,
      },
    };
  }

  const modelRequests = sink.requests.filter(request => (
    request.host === 'api.openai.com'
    && request.path === '/v1/responses'
    && request.method === 'POST'
  ));
  assert.equal(modelRequests.length, 9);
  const modelRequestBodies = modelRequests.map(request => JSON.parse(request.body));
  for (const body of modelRequestBodies) {
    assert.equal(body.temperature, 0);
    assert.equal(body.top_p, 1);
    assert.equal(body.max_output_tokens, 4096);
    assert.equal(body.store, false);
    assert.equal(body.background, undefined);
    assert.equal(body.stream, true);
    assert.equal(body.conversation, undefined);
    assert.equal(body.instructions, expectedInstructions);
    assert.equal(body.input.some(item => item.role === 'system'), false);
    assert.equal(Object.hasOwn(body, 'tools'), false);
  }
  const secondTurnRequest = modelRequestBodies.find(body => body.input.some(item => (
    item.role === 'user' && item.content === questions[1]
  )));
  assert.ok(secondTurnRequest);
  assert.ok(secondTurnRequest.input.some(item => (
    item.role === 'user' && item.content === questions[0]
  )));

  const continuationRequests = modelRequestBodies.filter(body => (
    body.input.at(-1)?.type === 'function_call_output'
  ));
  assert.equal(continuationRequests.length, 0);

  const persistedLogs = await database.query(
    `SELECT
      COUNT(*)::int AS total_logs,
      COUNT(*) FILTER (WHERE message_type = 'file_upload')::int AS file_upload_logs,
      COUNT(*) FILTER (WHERE message_type = 'user')::int AS user_logs,
      COUNT(*) FILTER (
        WHERE ai_response IS NULL
          AND ai_response_ciphertext IS NOT NULL
          AND ai_response_nonce IS NOT NULL
          AND ai_response_auth_tag IS NOT NULL
      )::int AS completed_logs,
      COUNT(*) FILTER (
        WHERE user_message IS NOT NULL OR ai_response IS NOT NULL OR user_email IS NOT NULL
      )::int AS plaintext_content_logs
    FROM chat_logs
    WHERE session_id = $1`,
    [sessionId],
  );
  assert.deepEqual(persistedLogs.rows[0], {
    total_logs: 6,
    file_upload_logs: 1,
    user_logs: 5,
    completed_logs: 6,
    plaintext_content_logs: 0,
  });
} catch (error) {
  const details = error instanceof Error ? error.stack || error.message : String(error);
  throw new Error(`${details}\n\nNext.js ledger process output:\n${readLogs()}`);
} finally {
  await stopChild(child);
  try {
    if (databaseReady) {
      await database.query('DELETE FROM chat_logs WHERE session_id = $1', [sessionId]);
      await database.query('DELETE FROM conversations WHERE session_id = $1', [sessionId]);
      await database.query('DELETE FROM chat_logs WHERE session_id = $1', [oversizeSessionId]);
      await database.query('DELETE FROM conversations WHERE session_id = $1', [oversizeSessionId]);
    }
  } finally {
    await database.end();
    await sink.close();
  }
}

const interceptRecords = parseInterceptLog(interceptLog);
const destinations = aggregateDestinations(interceptRecords);
const expectedPatterns = expected.allowed.map(item => item.host);
const sinkHosts = new Set(sink.requests.map(request => request.host));
const interceptedHosts = new Set(interceptRecords.map(record => record.host));
const sinkCapturedExpectedHosts = expectedPatterns.every(pattern => (
  [...sinkHosts].some(host => hostMatches(pattern, host))
));
const interceptorCapturedExpectedHosts = expectedPatterns.every(pattern => (
  [...interceptedHosts].some(host => hostMatches(pattern, host))
));
const sinkTransportHost = new URL(sink.origin).host;
const unexpectedTransportHosts = [...new Set(
  interceptRecords
    .filter(record => record.transportHost !== sinkTransportHost)
    .map(record => record.transportHost),
)].sort();

const ledger = {
  profile: expected.profile,
  generatedAt: new Date().toISOString(),
  fixture: 'tests/fixtures/small-spdx.json',
  runs: {
    smallSpdx: {
      fixture: 'tests/fixtures/small-spdx.json',
      osvRequestCount: smallSpdxOsvQueries,
    },
  },
  destinations,
  instrumentation: {
    sinkRequestCount: sink.requests.length,
    interceptorRequestCount: interceptRecords.length,
    sinkCapturedExpectedHosts,
    interceptorCapturedExpectedHosts,
    unexpectedTransportHosts,
  },
  regressionGuards: {
    oversizeSpdxPackages: 200,
    oversizeSpdxOsvQueries,
    observedUploadCap: 150,
  },
  ...(offlineExecutionProof ? { executionProof: offlineExecutionProof } : {}),
  manualDeploymentRows: expected.disclosureRows.filter(row => !row.observable),
};

await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
if (profile === 'offline') {
  const hostedLedger = JSON.parse(await readFile(hostedLedgerPath, 'utf8'));
  await fs.promises.mkdir(path.dirname(documentPath), { recursive: true });
  await writeFile(documentPath, markdownDocument(hostedLedger, ledger));
}
await rm(tempDir, { recursive: true, force: true });

console.log(`${profile} egress ledger built with synthetic traffic only.`);
for (const destination of destinations) {
  console.log(
    `- ${destination.host}: ${destination.requestCount} requests, ${destination.classification}, max body ${destination.maxRequestBodySize} bytes`,
  );
}
console.log(`Sink/interceptor requests: ${sink.requests.length}/${interceptRecords.length}`);
console.log(`Small SPDX run: ${smallSpdxOsvQueries} intercepted OSV requests`);
console.log(`Oversize SPDX regression guard: ${oversizeSpdxOsvQueries} intercepted OSV requests for 200 packages`);
if (offlineExecutionProof) {
  console.log(`Offline execution proof: ${offlineExecutionProof.smallUpload.vulnerabilitiesFound} upload vulnerabilities, ${offlineExecutionProof.packageQuery.vulnerabilitiesFound} package-query vulnerabilities, identifier resolved to ${offlineExecutionProof.identifier.resolvedAdvisoryId}`);
}
console.log('Live OpenAI credits consumed: 0');
