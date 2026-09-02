import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';

const CONFIGURATION_VARIABLES = [
  'DATABASE_URL',
  'PROFILE',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'OSV_MODE',
  'OSV_BASE_URL',
  'OSV_MIRROR_BASE_URL',
  'OSV_SNAPSHOT_DATE',
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
  PROFILE: 'local',
  LLM_MODEL: 'synthetic-local-model',
  OSV_MODE: 'offline',
  RETENTION: 'study',
  PARTICIPANT_ID_MODE: 'email',
  LLM_TEMPERATURE: '0',
  LLM_TOP_P: '1',
  LLM_MAX_OUTPUT_TOKENS: '4096',
  LLM_SEED: 'null',
});
delete process.env.LLM_API_KEY;
delete process.env.OSV_BASE_URL;
delete process.env.PARTICIPANT_ID_SALT;

const { default: handler } = await import('./log.ts');
const { closeDb } = await import('../../lib/db/client.ts');

for (const name of CONFIGURATION_VARIABLES) {
  const previousValue = previousValues.get(name);
  if (previousValue === undefined) delete process.env[name];
  else process.env[name] = previousValue;
}

after(async () => {
  await closeDb();
});

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('log API accepts a version 4 session capability initialization', async () => {
  const response = responseRecorder();

  await handler({
    method: 'POST',
    body: { action: 'initialize_session', sessionId: randomUUID() },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { success: true });
});

test('log API rejects unknown request fields', async () => {
  const response = responseRecorder();
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await handler({
      method: 'POST',
      body: {
        action: 'initialize_session',
        sessionId: randomUUID(),
        unexpected: 'field',
      },
    }, response);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'Invalid log request' });
});

test('log API rejects UUIDs that are not version 4 capabilities', async () => {
  const response = responseRecorder();
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await handler({
      method: 'POST',
      body: {
        action: 'initialize_session',
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      },
    }, response);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 400);
});
