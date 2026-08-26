import assert from 'node:assert/strict';
import test from 'node:test';

const CONFIGURATION_VARIABLES = [
  'PROFILE',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'OSV_MODE',
  'RETENTION',
  'LLM_TEMPERATURE',
  'LLM_TOP_P',
  'LLM_MAX_OUTPUT_TOKENS',
  'LLM_SEED',
];

let importSequence = 0;

async function loadConfig(environment) {
  const previousValues = new Map(
    CONFIGURATION_VARIABLES.map(name => [name, process.env[name]]),
  );

  for (const name of CONFIGURATION_VARIABLES) delete process.env[name];
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;

  try {
    importSequence += 1;
    return await import(`./config.ts?config-test=${importSequence}`);
  } finally {
    for (const name of CONFIGURATION_VARIABLES) {
      const previousValue = previousValues.get(name);
      if (previousValue === undefined) delete process.env[name];
      else process.env[name] = previousValue;
    }
  }
}

function requiredDecodingConfiguration() {
  return {
    LLM_TEMPERATURE: '0.25',
    LLM_TOP_P: '0.9',
    LLM_MAX_OUTPUT_TOKENS: '2048',
  };
}

function localConfiguration(overrides = {}) {
  return {
    PROFILE: 'local',
    LLM_MODEL: 'synthetic-local-model',
    ...requiredDecodingConfiguration(),
    ...overrides,
  };
}

async function assertConfigurationRejects(environment, variableName) {
  await assert.rejects(
    loadConfig(environment),
    error => {
      assert.match(error.message, new RegExp(variableName));
      return true;
    },
  );
}

test('valid hosted config is frozen and applies non-decoding defaults', async () => {
  const { config } = await loadConfig({
    PROFILE: 'hosted',
    LLM_MODEL: 'synthetic-hosted-model',
    LLM_API_KEY: 'synthetic-hosted-key',
    ...requiredDecodingConfiguration(),
  });

  assert.equal(Object.isFrozen(config), true);
  assert.deepEqual(config, {
    PROFILE: 'hosted',
    LLM_BASE_URL: 'https://api.openai.com/v1',
    LLM_MODEL: 'synthetic-hosted-model',
    LLM_API_KEY: 'synthetic-hosted-key',
    OSV_MODE: 'api',
    RETENTION: 'study',
    LLM_TEMPERATURE: 0.25,
    LLM_TOP_P: 0.9,
    LLM_MAX_OUTPUT_TOKENS: 2048,
    LLM_SEED: null,
  });
});

test('valid local config does not require an API key', async () => {
  const { config } = await loadConfig({
    PROFILE: 'local',
    LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
    LLM_MODEL: 'synthetic-local-model',
    OSV_MODE: 'offline',
    RETENTION: 'ephemeral',
    LLM_TEMPERATURE: '0',
    LLM_TOP_P: '1',
    LLM_MAX_OUTPUT_TOKENS: '4096',
    LLM_SEED: '7',
  });

  assert.equal(config.PROFILE, 'local');
  assert.equal(config.LLM_API_KEY, undefined);
  assert.equal(config.LLM_BASE_URL, 'http://127.0.0.1:11434/v1');
  assert.equal(config.OSV_MODE, 'offline');
  assert.equal(config.RETENTION, 'ephemeral');
  assert.equal(config.LLM_SEED, 7);
});

test('missing LLM_MODEL fails fast and names LLM_MODEL', async () => {
  await assert.rejects(
    loadConfig({
      PROFILE: 'hosted',
      LLM_API_KEY: 'synthetic-hosted-key',
      ...requiredDecodingConfiguration(),
    }),
    error => {
      assert.match(error.message, /LLM_MODEL/);
      return true;
    },
  );
});

test('invalid PROFILE fails fast and names PROFILE', async () => {
  await assert.rejects(
    loadConfig({
      PROFILE: 'invalid-profile',
      LLM_MODEL: 'synthetic-hosted-model',
      LLM_API_KEY: 'synthetic-hosted-key',
      ...requiredDecodingConfiguration(),
    }),
    error => {
      assert.match(error.message, /PROFILE/);
      return true;
    },
  );
});

test('hosted config without LLM_API_KEY fails fast and names LLM_API_KEY', async () => {
  await assert.rejects(
    loadConfig({
      PROFILE: 'hosted',
      LLM_MODEL: 'synthetic-hosted-model',
      ...requiredDecodingConfiguration(),
    }),
    error => {
      assert.match(error.message, /LLM_API_KEY/);
      return true;
    },
  );
});

test('LLM_TEMPERATURE rejects values outside the inclusive 0 to 2 range', async () => {
  for (const invalidValue of ['-5', '2.1']) {
    await assertConfigurationRejects(
      localConfiguration({ LLM_TEMPERATURE: invalidValue }),
      'LLM_TEMPERATURE',
    );
  }
});

test('LLM_TOP_P rejects values outside the inclusive 0 to 1 range', async () => {
  for (const invalidValue of ['-0.1', '1.1', '47']) {
    await assertConfigurationRejects(
      localConfiguration({ LLM_TOP_P: invalidValue }),
      'LLM_TOP_P',
    );
  }
});

test('LLM_MAX_OUTPUT_TOKENS requires a positive integer', async () => {
  for (const invalidValue of ['-100', '0', '3.7']) {
    await assertConfigurationRejects(
      localConfiguration({ LLM_MAX_OUTPUT_TOKENS: invalidValue }),
      'LLM_MAX_OUTPUT_TOKENS',
    );
  }
});

test('LLM_SEED requires an integer when it is not null', async () => {
  await assertConfigurationRejects(
    localConfiguration({ LLM_SEED: '3.7' }),
    'LLM_SEED',
  );
});
