import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startLedgerSink } from './sink.mjs';

const ledgerDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(ledgerDir, '../..');
const fixturesDir = path.join(repoRoot, 'tests/fixtures');
const expectedPath = path.join(ledgerDir, 'expected.json');
const ledgerPath = path.join(ledgerDir, 'ledger-current.json');
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
      const response = await fetch(`${origin}/api/run-status`);
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

async function pollToCompletion(appOrigin, conversationId, responseId, sessionId, messageIndex) {
  let currentResponseId = responseId;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const params = new URLSearchParams({
      conversationId,
      responseId: currentResponseId,
      sessionId,
      messageIndex: String(messageIndex),
    });
    const response = await fetch(`${appOrigin}/api/run-status?${params}`);
    const body = await parseJsonResponse(response, `poll ${currentResponseId}`);
    currentResponseId = body.responseId || currentResponseId;

    if (body.status === 'failed' || (body.completed && body.error)) {
      throw new Error(`Synthetic Response failed: ${JSON.stringify(body)}`);
    }
    if (body.completed) {
      assert.equal(typeof body.response, 'string');
      assert.ok(body.response.length > 0);
      return body;
    }
    await delay(50);
  }

  throw new Error(`Synthetic Response did not complete: ${currentResponseId}`);
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

function markdownDocument(ledger, expected, records) {
  const requestCount = predicate => records.filter(predicate).length;
  const destinationMap = new Map(ledger.destinations.map(item => [item.host, item]));
  const supabase = ledger.destinations.find(item => item.host.endsWith('.supabase.co'));
  const yesNo = value => value ? '**Yes**' : 'No';

  return `# Disclosure Ledger — Hosted Baseline

This document is generated by \`npm run ledger:build\` using entirely synthetic SBOM data.
Do not edit this file directly; make documentation changes in \`markdownDocument()\` in
\`tests/ledger/run-ledger.mjs\` so regeneration preserves them.
The application emits real HTTP to a loopback recording sink; a \`globalThis.fetch\`
interceptor independently records the logical destination, request-body size, and fixture
markers present in every request. No live OpenAI credits or live external endpoints are used.

## Automated host summary

| Host | Requests | Carries SBOM-derived content? | Maximum request body (bytes) |
|---|---:|---|---:|
${ledger.destinations.map(item => `| \`${item.host}\` | ${item.requestCount} | ${yesNo(item.carriesInventory)} | ${item.maxRequestBodySize} |`).join('\n')}

Automated result: **${ledger.destinations.filter(item => item.carriesInventory).length} inventory-carrying hosts** out of the allowed maximum of **${expected.maxInventoryCarryingHosts}**.

## Seven-row current-state disclosure ledger

| ID | Destination | Operator | Carries SBOM-derived content? | Observation | Code site |
|---|---|---|---|---|---|
| D1 | \`api.openai.com/v1/responses\` | OpenAI | **Yes** | ${requestCount(record => record.host === 'api.openai.com' && record.url.includes('/v1/responses'))} intercepted requests; package/version/ID markers observed | four API routes via \`lib/llm/gateway.ts\`; \`lib/llm/providers/openai.ts\` |
| D2 | \`api.openai.com/v1/conversations\` | OpenAI | **Yes (indirectly)** | ${requestCount(record => record.host === 'api.openai.com' && record.url.includes('/v1/conversations'))} intercepted conversation creations; subsequent Responses carry the conversation content | \`lib/llm/providers/openai.ts\` |
| D3 | \`api.osv.dev/v1/query\` | Google | **Yes** | ${requestCount(record => record.host === 'api.osv.dev' && record.url.includes('/v1/query'))} intercepted package queries with inventory markers | \`upload.ts\`, \`osv-query.ts\`, \`openai-responses.ts\` |
| D4 | \`api.osv.dev/v1/vulns/{id}\` | Google | Partially | ${requestCount(record => record.host === 'api.osv.dev' && record.url.includes('/v1/vulns/'))} intercepted CVE lookup; identifier is in the URL rather than the request body | \`osv-query.ts\`, \`openai-responses.ts\` |
| D5 | Supabase (\`NEXT_PUBLIC_SUPABASE_URL\`) | Supabase + AWS | **Yes** | ${supabase?.requestCount || 0} intercepted requests; chat package markers observed | \`upload.ts\`, \`chat.ts\`, \`run-status.ts\`, \`chatLogger.ts\` |
| D6 | Vercel edge + runtime | Vercel | **Yes** | **Manual deployment property; not observable from in-process interception** | deployment property; \`vercel.json\` |
| D7 | Vercel Analytics | Vercel | No (page telemetry) | **Manual deployment property; not observable from in-process interception** | \`src/App.tsx\` |

Vercel TLS termination/runtime handling (D6) and Vercel Analytics (D7) must remain
manual rows. Their absence from automated interception must not be read as absence from
the deployed system.

## Regression guards

- The synthetic 200-package SPDX fixture produced exactly **${ledger.regressionGuards.oversizeSpdxOsvQueries}** OSV package queries.
- This makes the existing 150-package cap observable. It is a regression guard, not evidence that a live study input was truncated.
- INC-01 changes observation only; it does not change the cap or application request behavior.

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

## Instrumentation cross-check

- Local sink captured every expected automated host: **${ledger.instrumentation.sinkCapturedExpectedHosts}**
- Global fetch interceptor captured every expected automated host: **${ledger.instrumentation.interceptorCapturedExpectedHosts}**
- Unexpected transport hosts: **${ledger.instrumentation.unexpectedTransportHosts.length === 0 ? 'none, given the development-mode suppressions documented above' : ledger.instrumentation.unexpectedTransportHosts.join(', ')}**
- On its first run, the interceptor caught \`registry.npmjs.org\`, which was unpredicted by the audit, absent from \`expected.json\`, and originated in framework rather than application code—evidence that the interceptor observes the running system rather than only the author's model of it.
- Current automated host classifications: OpenAI=${destinationMap.get('api.openai.com')?.classification}, OSV=${destinationMap.get('api.osv.dev')?.classification}, Supabase=${supabase?.classification}
`;
}

const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
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

const child = spawn(process.execPath, [nextBinary, 'dev', '-H', '127.0.0.1', '-p', String(appPort)], {
  cwd: repoRoot,
  env: {
    ...process.env,
    DEBUG: '',
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
    NODE_OPTIONS: nodeOptions,
    NEXT_TELEMETRY_DISABLED: '1',
    PROFILE: 'hosted',
    OPENAI_API_KEY: 'synthetic-ledger-openai-key',
    LLM_API_KEY: 'synthetic-ledger-llm-key',
    OPENAI_MODEL: 'gpt-4o',
    LLM_BASE_URL: `${sink.origin}/proxy/api.openai.com/v1`,
    LLM_MODEL: 'gpt-4o',
    LLM_TEMPERATURE: '0',
    LLM_TOP_P: '1',
    LLM_MAX_OUTPUT_TOKENS: '4096',
    LLM_SEED: 'null',
    OSV_MODE: 'api',
    OSV_BASE_URL: `${sink.origin}/proxy/api.osv.dev`,
    RETENTION: 'study',
    NEXT_PUBLIC_SUPABASE_URL: `${sink.origin}/proxy/synthetic-project.supabase.co`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-ledger-browser-key',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-ledger-server-key',
    LEDGER_FIXTURE_PATH: path.join(fixturesDir, 'small-spdx.json'),
    LEDGER_INTERCEPT_LOG: interceptLog,
    LEDGER_SINK_ORIGIN: sink.origin,
    LEDGER_BLOCK_EXTERNAL: '1',
  },
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

try {
  await waitForApplication(appOrigin, child, readLogs);

  const malformed = await uploadFixture(appOrigin, 'malformed.json', {}, [400]);
  assert.match(malformed.error, /No packages found/);

  const sessionId = 'ledger-synthetic-session';
  const upload = await uploadFixture(appOrigin, 'small-spdx.json', {
    sessionId,
    messageIndex: 1,
  });
  assert.equal(upload.packagesScanned, 12);
  assert.equal(upload.totalPackages, 12);
  await pollToCompletion(appOrigin, upload.conversationId, upload.responseId, sessionId, 1);

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
    await pollToCompletion(appOrigin, chat.conversationId, chat.responseId, sessionId, messageIndex);
  }

  const packageQuery = await postJson(appOrigin, '/api/osv-query', {
    name: 'lodash',
    version: '4.17.20',
    ecosystem: 'npm',
    conversationId: upload.conversationId,
  }, 'package query');
  await pollToCompletion(appOrigin, packageQuery.conversationId, packageQuery.responseId, sessionId, 7);

  const cveQuery = await postJson(appOrigin, '/api/osv-query', {
    cve: 'CVE-2021-23337',
    conversationId: upload.conversationId,
  }, 'CVE query');
  await pollToCompletion(appOrigin, cveQuery.conversationId, cveQuery.responseId, sessionId, 8);

  const beforeOversize = countSinkRequests(sink.requests, 'api.osv.dev', '/v1/query', 'POST');
  const oversize = await uploadFixture(appOrigin, 'oversize-spdx.json');
  const afterOversize = countSinkRequests(sink.requests, 'api.osv.dev', '/v1/query', 'POST');
  oversizeSpdxOsvQueries = afterOversize - beforeOversize;
  assert.equal(oversize.packagesScanned, 150);
  assert.equal(oversize.totalPackages, 200);
  assert.equal(oversizeSpdxOsvQueries, 150);

  const modelRequests = sink.requests.filter(request => (
    request.host === 'api.openai.com'
    && request.path === '/v1/responses'
    && request.method === 'POST'
  ));
  assert.equal(modelRequests.length, 10);
  const modelRequestBodies = modelRequests.map(request => JSON.parse(request.body));
  for (const body of modelRequestBodies) {
    assert.equal(body.temperature, 0);
    assert.equal(body.top_p, 1);
    assert.equal(body.max_output_tokens, 4096);
  }
  const continuationRequests = modelRequestBodies.filter(body => (
    body.metadata?.bombot_tool_round === '1'
  ));
  assert.equal(continuationRequests.length, 1);
  assert.ok(continuationRequests[0].input.some(item => (
    item.type === 'function_call_output'
    && item.call_id?.startsWith('call_resp_ledger_')
  )));
} catch (error) {
  const details = error instanceof Error ? error.stack || error.message : String(error);
  throw new Error(`${details}\n\nNext.js ledger process output:\n${readLogs()}`);
} finally {
  await stopChild(child);
  await sink.close();
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
  manualDeploymentRows: expected.disclosureRows.filter(row => !row.observable),
};

await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
await fs.promises.mkdir(path.dirname(documentPath), { recursive: true });
await writeFile(documentPath, markdownDocument(ledger, expected, interceptRecords));
await rm(tempDir, { recursive: true, force: true });

console.log('Egress ledger built with synthetic traffic only.');
for (const destination of destinations) {
  console.log(
    `- ${destination.host}: ${destination.requestCount} requests, ${destination.classification}, max body ${destination.maxRequestBodySize} bytes`,
  );
}
console.log(`Sink/interceptor requests: ${sink.requests.length}/${interceptRecords.length}`);
console.log(`Oversize SPDX regression guard: ${oversizeSpdxOsvQueries} OSV queries for 200 packages`);
console.log('Live OpenAI credits consumed: 0');
