import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CONFIGURATION_VARIABLES = [
  'DATABASE_URL',
  'PROFILE',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'OSV_MODE',
  'OSV_BASE_URL',
  'RETENTION',
  'PARTICIPANT_ID_MODE',
  'PARTICIPANT_ID_SALT',
  'LLM_TEMPERATURE',
  'LLM_TOP_P',
  'LLM_MAX_OUTPUT_TOKENS',
  'LLM_SEED',
];
const previousValues = new Map(
  CONFIGURATION_VARIABLES.map(name => [name, process.env[name]]),
);

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
  PROFILE: 'hosted',
  LLM_BASE_URL: 'https://api.openai.test/v1',
  LLM_MODEL: 'gpt-4o',
  LLM_API_KEY: 'synthetic-test-key',
  OSV_MODE: 'api',
  RETENTION: 'study',
  LLM_TEMPERATURE: '0',
  LLM_TOP_P: '1',
  LLM_MAX_OUTPUT_TOKENS: '4096',
  LLM_SEED: 'null',
});
delete process.env.OSV_BASE_URL;

const {
  BOMBOT_INSTRUCTIONS,
  BOMBOT_LLM_TOOLS,
  BOMBOT_TOOLS,
  MAX_FUNCTION_CALL_ROUNDS,
  TOOL_ROUND_METADATA_KEY,
  continueFunctionCallingLoop,
  createBackgroundResponse,
  createConversation,
  executeFunctionCall,
  extractResponseText,
  getToolContinuationIdempotencyKey,
  parseToolArguments,
} = await import('../lib/openai-responses.ts');

for (const name of CONFIGURATION_VARIABLES) {
  const previousValue = previousValues.get(name);
  if (previousValue === undefined) delete process.env[name];
  else process.env[name] = previousValue;
}

function syntheticResponse(overrides = {}) {
  return {
    id: 'resp_synthetic',
    created_at: 1,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-4o',
    object: 'response',
    output: [],
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    status: 'completed',
    ...overrides,
  };
}

function syntheticToolCall(callId = 'call_package') {
  return {
    type: 'function_call',
    call_id: callId,
    name: 'query_package_vulnerabilities',
    arguments: JSON.stringify({ name: 'synthetic-package', ecosystem: 'npm' }),
    status: 'completed',
  };
}

const emptyOSVFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ vulns: [] }),
});

test('instructions faithfully include Instruction Prompt.md and all four tools', async () => {
  const prompt = (await readFile(new URL('../Instruction Prompt.md', import.meta.url), 'utf8')).trim();
  assert.ok(BOMBOT_INSTRUCTIONS.startsWith(prompt));
  assert.deepEqual(
    BOMBOT_TOOLS.map(tool => tool.name),
    [
      'query_package_vulnerabilities',
      'query_cve_details',
      'analyze_sbom_package',
      'query_package_dependencies',
    ],
  );
  assert.deepEqual(
    BOMBOT_LLM_TOOLS.map(tool => tool.name),
    BOMBOT_TOOLS.map(tool => tool.name),
  );
});

test('tool argument parsing accepts valid input and rejects invalid input', () => {
  assert.deepEqual(
    parseToolArguments(
      'query_package_vulnerabilities',
      JSON.stringify({ name: 'lodash', ecosystem: 'npm', version: '4.17.20' }),
    ),
    { name: 'lodash', ecosystem: 'npm', version: '4.17.20' },
  );

  assert.throws(
    () => parseToolArguments('query_cve_details', JSON.stringify({ cve_id: 'not-a-cve' })),
    /Expected a CVE identifier/,
  );
});

test('package and CVE functions return only mocked OSV data', async () => {
  const requests = [];
  const osvFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => String(url).includes('/vulns/')
        ? { id: 'CVE-2024-0001', summary: 'Synthetic CVE' }
        : { vulns: [{ id: 'GHSA-synthetic', summary: 'Synthetic package result' }] },
    };
  };

  const packageResult = JSON.parse(await executeFunctionCall(
    'query_package_vulnerabilities',
    JSON.stringify({ name: 'synthetic-package', ecosystem: 'npm', version: '1.0.0' }),
    osvFetch,
  ));
  const cveResult = JSON.parse(await executeFunctionCall(
    'query_cve_details',
    JSON.stringify({ cve_id: 'CVE-2024-0001' }),
    osvFetch,
  ));

  assert.equal(requests[0].url, 'https://api.osv.dev/v1/query');
  assert.equal(requests[1].url, 'https://api.osv.dev/v1/vulns/CVE-2024-0001');
  assert.equal(packageResult.vulns[0].id, 'GHSA-synthetic');
  assert.equal(cveResult.id, 'CVE-2024-0001');
});

test('SBOM and dependency tools preserve their conversation-context behavior', async () => {
  const sbomResult = JSON.parse(await executeFunctionCall(
    'analyze_sbom_package',
    JSON.stringify({ package_name: 'synthetic-package', include_dependencies: true }),
  ));
  const dependencyResult = JSON.parse(await executeFunctionCall(
    'query_package_dependencies',
    JSON.stringify({ package_name: 'synthetic-package', direction: 'dependents' }),
  ));

  assert.equal(sbomResult.action, 'analyze_uploaded_data');
  assert.equal(sbomResult.include_dependencies, true);
  assert.equal(dependencyResult.action, 'query_dependency_data');
  assert.equal(dependencyResult.direction, 'dependents');
});

test('a new conversation and follow-up Responses use the same durable context', async () => {
  const createdRequests = [];
  const client = {
    conversations: {
      create: async () => ({ id: 'conv_synthetic', object: 'conversation', created_at: 1, metadata: {} }),
    },
    responses: {
      create: async params => {
        createdRequests.push(params);
        return syntheticResponse({ id: `resp_${createdRequests.length}`, status: 'queued' });
      },
    },
  };

  const conversation = await createConversation(client);
  await createBackgroundResponse(conversation.id, 'first synthetic turn', client);
  await createBackgroundResponse(conversation.id, 'follow-up synthetic turn', client);

  assert.equal(conversation.id, 'conv_synthetic');
  assert.equal(createdRequests[0].conversation, 'conv_synthetic');
  assert.equal(createdRequests[1].conversation, 'conv_synthetic');
  assert.equal(createdRequests[0].background, true);
  assert.equal(createdRequests[0].metadata[TOOL_ROUND_METADATA_KEY], '0');
  assert.equal(createdRequests[1].metadata[TOOL_ROUND_METADATA_KEY], '0');
  assert.equal(createdRequests[1].model, 'gpt-4o');
  assert.equal(createdRequests[1].instructions, BOMBOT_INSTRUCTIONS);
  assert.equal(createdRequests[1].tools, BOMBOT_TOOLS);
});

test('function output creates a successor Response ID for polling', async () => {
  const createdRequests = [];
  const initial = syntheticResponse({
    id: 'resp_initial',
    metadata: { [TOOL_ROUND_METADATA_KEY]: '0' },
    output: [syntheticToolCall()],
  });
  const requestOptions = [];
  const client = {
    responses: {
      create: async (params, options) => {
        createdRequests.push(params);
        requestOptions.push(options);
        return syntheticResponse({
          id: 'resp_successor',
          status: 'queued',
          metadata: params.metadata,
        });
      },
    },
  };

  const result = await continueFunctionCallingLoop(
    initial,
    'conv_synthetic',
    client,
    emptyOSVFetch,
  );

  assert.equal(result.responseId, 'resp_successor');
  assert.deepEqual(result.successorResponseIds, ['resp_successor']);
  assert.equal(result.toolCallsProcessed, 1);
  assert.equal(createdRequests[0].conversation, 'conv_synthetic');
  assert.equal(createdRequests[0].metadata[TOOL_ROUND_METADATA_KEY], '1');
  assert.deepEqual(createdRequests[0].input, [{
    type: 'function_call_output',
    call_id: 'call_package',
    output: JSON.stringify({ vulns: [] }),
  }]);
  const expectedKey = getToolContinuationIdempotencyKey('resp_initial');
  assert.equal(requestOptions[0].idempotencyKey, expectedKey);
  assert.equal(requestOptions[0].headers['Idempotency-Key'], expectedKey);
});

test('eight rounds remain allowed across eight separate polling invocations', async () => {
  const createdRequests = [];
  const client = {
    responses: {
      create: async (params, options) => {
        createdRequests.push({ params, options });
        return syntheticResponse({
          id: `resp_round_${createdRequests.length}`,
          status: 'queued',
          metadata: params.metadata,
        });
      },
    },
  };

  let source = syntheticResponse({
    id: 'resp_round_0',
    metadata: { [TOOL_ROUND_METADATA_KEY]: '0' },
    output: [syntheticToolCall('call_round_1')],
  });

  for (let round = 1; round <= MAX_FUNCTION_CALL_ROUNDS; round += 1) {
    const result = await continueFunctionCallingLoop(
      source,
      'conv_eight_rounds',
      client,
      emptyOSVFetch,
    );

    assert.equal(result.responseId, `resp_round_${round}`);
    assert.deepEqual(result.successorResponseIds, [`resp_round_${round}`]);
    assert.equal(result.response.metadata[TOOL_ROUND_METADATA_KEY], String(round));

    source = syntheticResponse({
      ...result.response,
      status: 'completed',
      output: [syntheticToolCall(`call_round_${round + 1}`)],
    });
  }

  assert.equal(createdRequests.length, MAX_FUNCTION_CALL_ROUNDS);
  assert.deepEqual(
    createdRequests.map(request => request.params.metadata[TOOL_ROUND_METADATA_KEY]),
    ['1', '2', '3', '4', '5', '6', '7', '8'],
  );
});

test('a ninth function-calling round is rejected without creating a Response', async () => {
  let createAttempts = 0;
  const client = {
    responses: {
      create: async () => {
        createAttempts += 1;
        return syntheticResponse({ id: 'resp_must_not_exist', status: 'queued' });
      },
    },
  };
  const ninthSource = syntheticResponse({
    id: 'resp_round_8',
    metadata: { [TOOL_ROUND_METADATA_KEY]: String(MAX_FUNCTION_CALL_ROUNDS) },
    output: [syntheticToolCall('call_round_9')],
  });

  await assert.rejects(
    continueFunctionCallingLoop(ninthSource, 'conv_eight_rounds', client, emptyOSVFetch),
    /maximum of 8 consecutive rounds/,
  );
  assert.equal(createAttempts, 0);
});

test('duplicate continuation attempts carry the same idempotency identity', async () => {
  const createAttempts = [];
  const responsesByIdempotencyKey = new Map();
  const client = {
    responses: {
      create: async (params, options) => {
        const sdkKey = options?.idempotencyKey;
        const headerKey = options?.headers?.['Idempotency-Key'];
        createAttempts.push({ params, sdkKey, headerKey });
        assert.equal(sdkKey, headerKey);

        // This fake models server-side deduplication; it is not evidence that the
        // deployed provider returns one successor for concurrent duplicate requests.
        if (!responsesByIdempotencyKey.has(sdkKey)) {
          responsesByIdempotencyKey.set(sdkKey, syntheticResponse({
            id: 'resp_single_successor',
            status: 'queued',
            metadata: params.metadata,
          }));
        }
        return responsesByIdempotencyKey.get(sdkKey);
      },
    },
  };
  const source = syntheticResponse({
    id: 'resp_duplicate_source',
    metadata: { [TOOL_ROUND_METADATA_KEY]: '3' },
    output: [syntheticToolCall('call_duplicate')],
  });

  const [first, second] = await Promise.all([
    continueFunctionCallingLoop(source, 'conv_duplicate', client, emptyOSVFetch),
    continueFunctionCallingLoop(source, 'conv_duplicate', client, emptyOSVFetch),
  ]);

  const expectedKey = getToolContinuationIdempotencyKey(source.id);
  assert.equal(createAttempts.length, 2);
  assert.ok(createAttempts.every(attempt => attempt.sdkKey === expectedKey));
  assert.equal(responsesByIdempotencyKey.size, 1);
  assert.equal(first.responseId, 'resp_single_successor');
  assert.equal(second.responseId, 'resp_single_successor');
  assert.deepEqual(first.successorResponseIds, ['resp_single_successor']);
  assert.deepEqual(second.successorResponseIds, ['resp_single_successor']);
});

test('run-status responses explicitly disable caching', async () => {
  const source = await readFile(new URL('../pages/api/run-status.ts', import.meta.url), 'utf8');
  assert.match(source, /Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate'/);
  assert.match(source, /Pragma', 'no-cache'/);
  assert.match(source, /Expires', '0'/);
});

test('response text extraction uses the SDK aggregate and output fallback', () => {
  assert.equal(extractResponseText(syntheticResponse({ output_text: 'aggregate text' })), 'aggregate text');
  assert.equal(extractResponseText(syntheticResponse({
    output: [{
      type: 'message',
      id: 'msg_synthetic',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'fallback text', annotations: [], logprobs: [] }],
    }],
  })), 'fallback text');
});
