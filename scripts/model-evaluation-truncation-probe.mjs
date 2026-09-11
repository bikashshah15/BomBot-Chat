import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';

const MODEL = 'bombot-qwen2.5-7b-instruct-q4_K_M:latest';
const FIXTURES = [
  'dependency-of-spdx.json',
  'mixed-ecosystems-cyclonedx.json',
  'mixed-ecosystems-spdx.json',
  'over-150-mixed-ecosystems.json',
  'oversize-spdx.json',
  'small-cyclonedx.json',
  'small-spdx.json',
];
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);

Object.assign(process.env, {
  DATABASE_URL: process.env.MODEL_EVALUATION_DATABASE_URL
    ?? 'postgresql://bombot:bombot_dev_password@127.0.0.1:5432/bombot',
  PROFILE: 'local',
  LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
  LLM_MODEL: MODEL,
  OSV_MODE: 'offline',
  OSV_SCANNER_PATH: 'osv-scanner',
  OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: process.env.MODEL_EVALUATION_OSV_CACHE_DIRECTORY
    ?? path.join(os.homedir(), 'bombot-osv', 'scanner-db'),
  RETENTION: 'study',
  RETENTION_IDLE_HOURS: '24',
  PARTICIPANT_ID_MODE: 'email',
  MAX_HISTORY_MESSAGES: '20',
  ENABLE_MODEL_TOOL_CALLS: 'false',
  LLM_TEMPERATURE: '0',
  LLM_TOP_P: '1',
  LLM_MAX_OUTPUT_TOKENS: '4096',
  LLM_SEED: 'null',
});
delete process.env.LLM_API_KEY;
delete process.env.OSV_BASE_URL;

const { createUploadHandler, parseSBOMData } = await import('../pages/api/upload.ts');
const { closeDb } = await import('../lib/db/client.ts');
const { createLlmGateway } = await import('../lib/llm/gateway.ts');
const { buildBombotInstructions } = await import('../lib/openai-responses.ts');
const { OSV_ECOSYSTEMS } = await import('../lib/osv/ecosystems.ts');
const { matchOsvPackages } = await import('../lib/osv/match.ts');

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

function packageIdentity(package_) {
  return [package_.ecosystem, package_.name, package_.version ?? ''].join('\u0000');
}

async function matchReferencePackages(client, packages) {
  const matchesByIdentity = new Map();
  const groups = Map.groupBy(packages, package_ => package_.ecosystem);
  for (const ecosystemPackages of groups.values()) {
    try {
      const matches = await matchOsvPackages(client, ecosystemPackages);
      for (const match of matches) matchesByIdentity.set(packageIdentity(match.package), match);
    } catch (error) {
      for (const package_ of ecosystemPackages) {
        const candidates = await client.query(
          'SELECT count(*)::int AS count FROM osv_vulns WHERE ecosystem = $1 AND package = $2',
          [package_.ecosystem, package_.name],
        );
        if (candidates.rows[0].count !== 0) throw error;
        matchesByIdentity.set(packageIdentity(package_), { package: package_, vulnerabilities: [] });
      }
    }
  }
  return packages.map(package_ => matchesByIdentity.get(packageIdentity(package_)));
}

async function preparePrompt(client, fixtureName) {
  const fixturePath = path.join(repositoryRoot, 'tests', 'fixtures', fixtureName);
  const content = await readFile(fixturePath, 'utf8');
  const parsed = parseSBOMData(content, fixtureName);
  const recognized = new Set(OSV_ECOSYSTEMS);
  const packagesToScan = parsed.packages.slice(0, 150)
    .filter(package_ => recognized.has(package_.ecosystem));
  const matches = await matchReferencePackages(client, packagesToScan);
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'bombot-truncation-probe-'));
  const uploadPath = path.join(tempDirectory, fixtureName);
  await copyFile(fixturePath, uploadPath);
  let prompt;
  const handler = createUploadHandler({
    osvMode: 'offline',
    osvClient: client,
    async parseForm() {
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: fixtureName,
            size: Buffer.byteLength(content),
          },
        },
      };
    },
    async queryOSVForPackage() {
      throw new Error('The truncation probe must not call the hosted OSV API');
    },
    async matchOsvPackages() {
      return matches;
    },
    async createConversation() {
      return { id: `truncation_probe_${fixtureName}` };
    },
    async appendConversationMessages(options) {
      prompt = options.messages[0].content;
    },
    async insertLog() {},
    async wait() {
      throw new Error('The truncation probe must not apply hosted API pacing');
    },
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);
    if (response.statusCode !== 200 || typeof prompt !== 'string') {
      throw new Error(`Failed to construct prompt for ${fixtureName}`);
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
  return prompt;
}

function contentSize(content) {
  return {
    bytes: Buffer.byteLength(content, 'utf8'),
    characters: Array.from(content).length,
  };
}

function markedPrompt(body, leadingMarker, trailingMarker) {
  return [
    leadingMarker,
    'The exact line above is the LEADING marker for this diagnostic. Preserve it exactly.',
    body,
    '',
    'Truncation diagnostic: answer both questions directly.',
    '1. What exact LEADING marker appeared on the first line?',
    '2. What exact TRAILING marker appears on the final line?',
    'Copy each visible marker character for character. The TRAILING marker follows this sentence.',
    trailingMarker,
  ].join('\n');
}

function oversizeBody() {
  return Array.from(
    { length: 20_000 },
    (_, index) => `diagnostic-filler-${String(index).padStart(6, '0')}-${(index * 2654435761 >>> 0).toString(16).padStart(8, '0')}`,
  ).join('\n');
}

const gateway = createLlmGateway({
  settings: {
    PROFILE: 'local',
    LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
    LLM_MODEL: MODEL,
    LLM_API_KEY: undefined,
    LLM_TEMPERATURE: 0,
    LLM_TOP_P: 1,
    LLM_MAX_OUTPUT_TOKENS: 4096,
    LLM_SEED: null,
  },
});
const systemPrompt = buildBombotInstructions('offline');

async function runProbe(name, userPrompt, leadingMarker, trailingMarker) {
  let result;
  for await (const chunk of gateway.stream({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  })) {
    if (chunk.result) result = chunk.result;
  }
  if (!result || result.status !== 'completed') {
    throw new Error(`${name} did not complete: ${result?.status ?? 'missing terminal result'}`);
  }
  const promptTokens = result.usage?.inputTokens;
  if (!Number.isSafeInteger(promptTokens)) {
    throw new Error(`${name} omitted the server-reported prompt token count`);
  }
  return {
    name,
    promptTokens,
    leadingMarkerReturned: result.content.includes(leadingMarker),
    trailingMarkerReturned: result.content.includes(trailingMarker),
    responseCharacters: Array.from(result.content).length,
    shortResponse: Array.from(result.content).length <= 200 ? result.content : null,
  };
}

async function measureUnmodifiedPrompt(name, userPrompt) {
  let result;
  for await (const chunk of gateway.stream({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  })) {
    if (chunk.result) result = chunk.result;
  }
  if (!result || result.status !== 'completed') {
    throw new Error(`${name} did not complete: ${result?.status ?? 'missing terminal result'}`);
  }
  const promptTokens = result.usage?.inputTokens;
  if (!Number.isSafeInteger(promptTokens)) {
    throw new Error(`${name} omitted the server-reported prompt token count`);
  }
  return { name, promptTokens, responseCharacters: Array.from(result.content).length };
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const snapshot = await client.query(
    'SELECT snapshot_date::text AS snapshot_date FROM osv_snapshots ORDER BY ingested_at DESC LIMIT 1',
  );
  if (snapshot.rows[0]?.snapshot_date !== '2026-09-07') {
    throw new Error(`Expected pinned OSV snapshot 2026-09-07, got ${snapshot.rows[0]?.snapshot_date ?? 'none'}`);
  }

  const fixturePrompts = {};
  for (const fixtureName of FIXTURES) {
    fixturePrompts[fixtureName] = await preparePrompt(client, fixtureName);
  }
  const targetPrompt = fixturePrompts['small-cyclonedx.json'];
  const targetSize = contentSize(targetPrompt);
  const systemSize = contentSize(systemPrompt);
  process.stdout.write(`${JSON.stringify({
    target: 'small-cyclonedx.json',
    userPrompt: targetSize,
    systemPrompt: systemSize,
    messageContentTotal: {
      bytes: targetSize.bytes + systemSize.bytes,
      characters: targetSize.characters + systemSize.characters,
    },
    charactersPerReportedToken8290: targetSize.characters / 8290,
    allFixtureUserPromptSizes: Object.fromEntries(
      Object.entries(fixturePrompts).map(([name, prompt]) => [name, contentSize(prompt)]),
    ),
  })}\n`);

  if (process.argv.includes('--measure-fixtures')) {
    const measurements = [];
    for (const [fixtureName, prompt] of Object.entries(fixturePrompts)) {
      measurements.push(await measureUnmodifiedPrompt(`unmodified-${fixtureName}`, prompt));
    }
    process.stdout.write(`${JSON.stringify({ measurements })}\n`);
  } else {
    const targetMarkers = {
    leading: 'MARKER-ALPHA-TARGET-7F2A91C4',
    trailing: 'MARKER-OMEGA-TARGET-9D84E6B1',
  };
  const belowMarkers = {
    leading: 'MARKER-ALPHA-BELOW-3C71A8F5',
    trailing: 'MARKER-OMEGA-BELOW-6E29D4B0',
  };
  const aboveMarkers = {
    leading: 'MARKER-ALPHA-ABOVE-1B63F9D2',
    trailing: 'MARKER-OMEGA-ABOVE-8A47C5E0',
  };
  if (!process.argv.includes('--probes-only')) {
    const reconciliation = await measureUnmodifiedPrompt(
      'unmodified-oversize-spdx',
      fixturePrompts['oversize-spdx.json'],
    );
    process.stdout.write(`${JSON.stringify({ reconciliation })}\n`);
  }
  const probes = [];
  probes.push(await runProbe(
    'target-small-cyclonedx',
    markedPrompt(targetPrompt, targetMarkers.leading, targetMarkers.trailing),
    targetMarkers.leading,
    targetMarkers.trailing,
  ));
  probes.push(await runProbe(
    'comfortably-below-window',
    markedPrompt('This intentionally short diagnostic body is comfortably below the context window.', belowMarkers.leading, belowMarkers.trailing),
    belowMarkers.leading,
    belowMarkers.trailing,
  ));
  probes.push(await runProbe(
    'deliberately-far-above-window',
    markedPrompt(oversizeBody(), aboveMarkers.leading, aboveMarkers.trailing),
    aboveMarkers.leading,
    aboveMarkers.trailing,
  ));
    process.stdout.write(`${JSON.stringify({ probes })}\n`);
  }
} finally {
  await client.end();
  await closeDb();
}
