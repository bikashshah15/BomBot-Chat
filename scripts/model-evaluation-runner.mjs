import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';

import {
  aggregateScores,
  collapseGuardDecision,
  fixedVersionsFromVulnerability,
  normalizeIdentifier,
  scoreResponse,
  severityRankFromVulnerability,
} from './model-evaluation-lib.mjs';

const FIXTURES = [
  'dependency-of-spdx.json',
  'mixed-ecosystems-cyclonedx.json',
  'mixed-ecosystems-spdx.json',
  'over-150-mixed-ecosystems.json',
  'oversize-spdx.json',
  'small-cyclonedx.json',
  'small-spdx.json',
];
const MODELS = [
  'bombot-qwen2.5-7b-instruct-q4_K_M:latest',
  'bombot-qwen2.5-14b-instruct-q4_K_M:latest',
  'bombot-mistral-nemo-12b-instruct-2407-q4_K_M:latest',
];
const REPEATS = 3;
const SERVED_CONTEXT_TOKENS = 16_384;
// Two independent oversize probes collapsed to half the served window plus the same observed
// two-token server offset: floor(16,384 / 2) + 2 = 8,194. The offset's cause is not established.
const COLLAPSE_OBSERVED_OFFSET_TOKENS = 2;
const COLLAPSE_TOLERANCE = 1;
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);

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

function referenceFromMatches(matches) {
  return matches.map(match => {
    const severities = match.vulnerabilities
      .map(severityRankFromVulnerability)
      .filter(rank => rank !== null);
    return {
      identity: packageIdentity(match.package),
      ecosystem: match.package.ecosystem,
      name: match.package.name,
      version: match.package.version,
      primaryIds: match.vulnerabilities.map(vulnerability => normalizeIdentifier(vulnerability.id)),
      referenceSeverity: severities.length > 0 ? Math.max(...severities) : null,
      fixedVersions: [...new Set(match.vulnerabilities.flatMap(fixedVersionsFromVulnerability))],
    };
  });
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

async function prepareFixture(client, fixtureName) {
  const fixturePath = path.join(repositoryRoot, 'tests', 'fixtures', fixtureName);
  const content = await readFile(fixturePath, 'utf8');
  const parsed = parseSBOMData(content, fixtureName);
  const recognized = new Set(OSV_ECOSYSTEMS);
  const packagesToScan = parsed.packages.slice(0, 150)
    .filter(package_ => recognized.has(package_.ecosystem));
  const matches = await matchReferencePackages(client, packagesToScan);
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'bombot-model-evaluation-'));
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
      throw new Error('The model evaluation must not call the hosted OSV API');
    },
    async matchOsvPackages() {
      return matches;
    },
    async createConversation() {
      return { id: `evaluation_${fixtureName}` };
    },
    async appendConversationMessages(options) {
      prompt = options.messages[0].content;
    },
    async insertLog() {},
    async wait() {
      throw new Error('The offline model evaluation must not apply hosted API pacing');
    },
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);
    if (response.statusCode !== 200 || typeof prompt !== 'string') {
      throw new Error(`Failed to construct evaluation prompt for ${fixtureName}`);
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }

  return {
    fixtureName,
    prompt,
    packageReferences: referenceFromMatches(matches),
  };
}

function gatewayForModel(model) {
  return createLlmGateway({
    settings: {
      PROFILE: 'local',
      LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
      LLM_MODEL: model,
      LLM_API_KEY: undefined,
      LLM_TEMPERATURE: 0,
      LLM_TOP_P: 1,
      LLM_MAX_OUTPUT_TOKENS: 4096,
      LLM_SEED: null,
    },
  });
}

async function streamTurn(gateway, prompt) {
  let result;
  for await (const chunk of gateway.stream({
    messages: [
      { role: 'system', content: buildBombotInstructions('offline') },
      { role: 'user', content: prompt },
    ],
  })) {
    if (chunk.result) result = chunk.result;
  }
  if (!result || result.status !== 'completed') {
    throw new Error(`Model turn did not complete: ${result?.status ?? 'missing terminal result'}`);
  }
  const promptTokens = result.usage?.inputTokens;
  if (!Number.isSafeInteger(promptTokens)) {
    throw new Error('Ollama omitted the server-reported prompt token count');
  }
  return { response: result.content, promptTokens };
}

function markedPrompt(prompt, leadingMarker, trailingMarker) {
  return [
    leadingMarker,
    'The exact line above is the LEADING marker for this diagnostic. Preserve it exactly.',
    prompt,
    '',
    'Truncation diagnostic: answer both questions directly.',
    '1. What exact LEADING marker appeared on the first line?',
    '2. What exact TRAILING marker appears on the final line?',
    'Copy each visible marker character for character. The TRAILING marker follows this sentence.',
    trailingMarker,
  ].join('\n');
}

async function evaluateTurn(gateway, prompt, turnIdentity) {
  const turn = await streamTurn(gateway, prompt);
  const guard = collapseGuardDecision({
    promptTokens: turn.promptTokens,
    servedContextTokens: SERVED_CONTEXT_TOKENS,
    observedOffsetTokens: COLLAPSE_OBSERVED_OFFSET_TOKENS,
    tolerance: COLLAPSE_TOLERANCE,
  });
  if (guard.decision === 'pass') return { ...turn, guard };

  const suffix = createHash('sha256').update(turnIdentity).digest('hex').slice(0, 12).toUpperCase();
  const leadingMarker = `MARKER-ALPHA-${suffix}`;
  const trailingMarker = `MARKER-OMEGA-${suffix}`;
  const probe = await streamTurn(gateway, markedPrompt(prompt, leadingMarker, trailingMarker));
  const leadingMarkerReturned = probe.response.includes(leadingMarker);
  const trailingMarkerReturned = probe.response.includes(trailingMarker);
  const escalation = {
    promptTokens: probe.promptTokens,
    leadingMarkerReturned,
    trailingMarkerReturned,
  };
  if (leadingMarkerReturned && trailingMarkerReturned) {
    return { ...turn, guard: { ...guard, decision: 'passed_after_escalation', escalation } };
  }
  if (!leadingMarkerReturned && trailingMarkerReturned) {
    throw new Error(`Prompt truncation confirmed by marker escalation: ${JSON.stringify({
      turnIdentity,
      originalPromptTokens: turn.promptTokens,
      ...escalation,
    })}`);
  }
  throw new Error(`Prompt truncation escalation inconclusive: ${JSON.stringify({
    turnIdentity,
    originalPromptTokens: turn.promptTokens,
    ...escalation,
  })}`);
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

  const fixtures = [];
  for (const fixtureName of FIXTURES) fixtures.push(await prepareFixture(client, fixtureName));

  const identifierResolutionCache = new Map();
  async function resolveIdentifier(identifier) {
    const normalizedIdentifier = normalizeIdentifier(identifier);
    if (!identifierResolutionCache.has(normalizedIdentifier)) {
      const resolved = await client.query(
        `SELECT id
         FROM osv_advisories
         WHERE lower(id) = lower($1)
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(COALESCE(aliases, '[]'::jsonb)) AS alias(value)
              WHERE lower(alias.value) = lower($1)
            )
         ORDER BY CASE WHEN lower(id) = lower($1) THEN 0 ELSE 1 END, id
         LIMIT 1`,
        [normalizedIdentifier],
      );
      identifierResolutionCache.set(normalizedIdentifier,
        typeof resolved.rows[0]?.id === 'string'
          ? normalizeIdentifier(resolved.rows[0].id)
          : null);
    }
    return identifierResolutionCache.get(normalizedIdentifier);
  }

  const modelResults = [];
  for (const model of MODELS) {
    const gateway = gatewayForModel(model);
    const turns = [];
    for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
      for (const fixture of fixtures) {
        process.stdout.write(`Evaluating ${model} / ${fixture.fixtureName} / repeat ${repeat}\n`);
        const turnIdentity = `${model}/${fixture.fixtureName}/repeat-${repeat}`;
        const turn = await evaluateTurn(gateway, fixture.prompt, turnIdentity);
        const identifiers = new Set((turn.response.match(/\b(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|(?:PYSEC|RUSTSEC|MAL|GO|OSV|BIT|GSD|EEF-CVE)-\d{4}-\d+)\b/giu) ?? [])
          .map(normalizeIdentifier));
        for (const identifier of identifiers) await resolveIdentifier(identifier);
        const score = scoreResponse({
          response: turn.response,
          packageReferences: fixture.packageReferences,
          resolveIdentifier(identifier) {
            return identifierResolutionCache.get(normalizeIdentifier(identifier)) ?? null;
          },
        });
        turns.push({
          fixture: fixture.fixtureName,
          repeat,
          promptTokens: turn.promptTokens,
          truncationGuard: turn.guard,
          response: turn.response,
          score,
        });
      }
    }
    const aggregates = Array.from({ length: REPEATS }, (_, index) => aggregateScores(
      turns.filter(turn => turn.repeat === index + 1).map(turn => turn.score),
    ));
    modelResults.push({ model, aggregates, turns });
  }

  const artifact = {
    schemaVersion: 2,
    snapshotDate: '2026-09-07',
    servedContextTokens: SERVED_CONTEXT_TOKENS,
    truncationSignature: {
      derivation: 'floor(servedContextTokens / 2) + 2 observed server offset tokens',
      collapseTokens: Math.floor(SERVED_CONTEXT_TOKENS / 2) + COLLAPSE_OBSERVED_OFFSET_TOKENS,
      observedOffsetTokens: COLLAPSE_OBSERVED_OFFSET_TOKENS,
      tolerance: COLLAPSE_TOLERANCE,
    },
    decoding: { temperature: 0, topP: 1, maxOutputTokens: 4096, seed: null },
    repeats: REPEATS,
    fixtures: fixtures.map(fixture => ({
      fixture: fixture.fixtureName,
      packages: fixture.packageReferences,
    })),
    models: modelResults,
  };
  const outputPath = path.join(repositoryRoot, 'docs', 'model-evaluation-runs.json');
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${path.relative(repositoryRoot, outputPath)}\n`);
} finally {
  await client.end();
  await closeDb();
}
