import assert from 'node:assert/strict';
import test from 'node:test';

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
  'OSV_SCANNER_PATH',
  'OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY',
  'MEASURE_PROVIDER_MODULE',
  'INSTRUCTIONS_FILE',
  'RETENTION',
  'RETENTION_IDLE_HOURS',
  'SESSION_KEY_DIRECTORY',
  'PARTICIPANT_ID_MODE',
  'PARTICIPANT_ID_SALT',
  'MAX_HISTORY_MESSAGES',
  'ENABLE_MODEL_TOOL_CALLS',
  'ENABLE_MODEL_TOGGLE',
  'LLM_TEMPERATURE',
  'LLM_TOP_P',
  'LLM_MAX_OUTPUT_TOKENS',
  'LLM_REASONING_EFFORT',
  'LLM_SEED',
  'ALT_PROFILE',
  'ALT_LLM_BASE_URL',
  'ALT_LLM_MODEL',
  'ALT_LLM_API_KEY',
  'ALT_LLM_REASONING_EFFORT',
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

function requiredConfiguration() {
  return {
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
    LLM_TEMPERATURE: '0.25',
    LLM_TOP_P: '0.9',
    LLM_MAX_OUTPUT_TOKENS: '2048',
    RETENTION_IDLE_HOURS: '24',
  };
}

function localConfiguration(overrides = {}) {
  return {
    PROFILE: 'local',
    LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
    LLM_MODEL: 'synthetic-local-model',
    OSV_BASE_URL: 'https://api.osv.test',
    ...requiredConfiguration(),
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

test('local config without LLM_BASE_URL fails fast and names LLM_BASE_URL', async () => {
  const environment = localConfiguration();
  delete environment.LLM_BASE_URL;

  await assertConfigurationRejects(environment, 'LLM_BASE_URL');
});

test('local config rejects hosted LLM_BASE_URL values and accepts configured local endpoints', async () => {
  await assertConfigurationRejects(
    localConfiguration({ LLM_BASE_URL: 'https://api.openai.com/v1' }),
    'LLM_BASE_URL',
  );

  for (const LLM_BASE_URL of [
    'http://host.docker.internal:11434/v1',
    'http://model:11434/v1',
    'http://10.0.0.8:11434/v1',
    'http://[fd00::8]:11434/v1',
  ]) {
    const { config } = await loadConfig(localConfiguration({ LLM_BASE_URL }));
    assert.equal(config.LLM_BASE_URL, LLM_BASE_URL);
  }
});

test('valid hosted config is frozen and applies non-decoding defaults', async () => {
  const { config } = await loadConfig({
    PROFILE: 'hosted',
    LLM_MODEL: 'synthetic-hosted-model',
    LLM_API_KEY: 'synthetic-hosted-key',
    OSV_BASE_URL: 'https://api.osv.test/',
    ...requiredConfiguration(),
  });

  assert.equal(Object.isFrozen(config), true);
  assert.deepEqual(config, {
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
    PROFILE: 'hosted',
    LLM_BASE_URL: 'https://api.openai.com/v1',
    LLM_MODEL: 'synthetic-hosted-model',
    LLM_API_KEY: 'synthetic-hosted-key',
    OSV_MODE: 'api',
    OSV_BASE_URL: 'https://api.osv.test',
    OSV_MIRROR_BASE_URL: 'https://storage.googleapis.com',
    OSV_SCANNER_PATH: 'osv-scanner',
    OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: '/var/lib/bombot/osv-scanner',
    RETENTION: 'study',
    RETENTION_IDLE_HOURS: 24,
    SESSION_KEY_DIRECTORY: '/var/lib/bombot/session-keys',
    PARTICIPANT_ID_MODE: 'email',
    MAX_HISTORY_MESSAGES: 20,
    ENABLE_MODEL_TOOL_CALLS: false,
    ENABLE_MODEL_TOGGLE: false,
    LLM_TEMPERATURE: 0.25,
    LLM_TOP_P: 0.9,
    LLM_MAX_OUTPUT_TOKENS: 2048,
    LLM_SEED: null,
  });
});

test('valid local config does not require an API key', async () => {
  const { config } = await loadConfig({
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
    PROFILE: 'local',
    LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
    LLM_MODEL: 'synthetic-local-model',
    OSV_MODE: 'offline',
    RETENTION: 'ephemeral',
    RETENTION_IDLE_HOURS: '24',
    LLM_TEMPERATURE: '0',
    LLM_TOP_P: '1',
    LLM_MAX_OUTPUT_TOKENS: '4096',
    LLM_SEED: '7',
  });

  assert.equal(config.PROFILE, 'local');
  assert.equal(config.LLM_API_KEY, undefined);
  assert.equal(config.LLM_BASE_URL, 'http://127.0.0.1:11434/v1');
  assert.equal(config.OSV_MODE, 'offline');
  assert.equal(config.OSV_BASE_URL, undefined);
  assert.equal(config.RETENTION, 'ephemeral');
  assert.equal(config.LLM_SEED, 7);
});

test('model toggle defaults false and parses the string false without alternate settings', async () => {
  const { config } = await loadConfig(localConfiguration({ ENABLE_MODEL_TOGGLE: 'false' }));
  assert.equal(config.ENABLE_MODEL_TOGGLE, false);
  assert.equal(config.ALT_PROFILE, undefined);
});

test('enabled hosted alternate requires an API key', async () => {
  await assertConfigurationRejects(localConfiguration({
    ENABLE_MODEL_TOGGLE: 'true',
    ALT_PROFILE: 'hosted',
    ALT_LLM_BASE_URL: 'https://api.openai.com/v1',
    ALT_LLM_MODEL: 'synthetic-alternate-model',
  }), 'ALT_LLM_API_KEY');
});

test('enabled local alternate rejects a non-loopback URL', async () => {
  await assertConfigurationRejects(localConfiguration({
    ENABLE_MODEL_TOGGLE: 'true',
    ALT_PROFILE: 'local',
    ALT_LLM_BASE_URL: 'https://api.openai.com/v1',
    ALT_LLM_MODEL: 'synthetic-alternate-model',
  }), 'ALT_LLM_BASE_URL');
});

test('optional seam paths are preserved for their fail-closed loaders', async () => {
  const { config } = await loadConfig(localConfiguration({
    MEASURE_PROVIDER_MODULE: '/opt/bombot/researchProvider.ts',
    INSTRUCTIONS_FILE: '/run/bombot/instructions.txt',
  }));
  assert.equal(config.MEASURE_PROVIDER_MODULE, '/opt/bombot/researchProvider.ts');
  assert.equal(config.INSTRUCTIONS_FILE, '/run/bombot/instructions.txt');
});

test('optional seam paths reject empty and whitespace-only configuration', async () => {
  for (const variable of ['MEASURE_PROVIDER_MODULE', 'INSTRUCTIONS_FILE']) {
    for (const value of ['', ' \n\t ']) {
      await assertConfigurationRejects(localConfiguration({ [variable]: value }), variable);
    }
  }
});

test('OSV_MODE=api defaults OSV_BASE_URL to https://api.osv.dev when unset', async () => {
  const environment = localConfiguration();
  delete environment.OSV_BASE_URL;

  const { config } = await loadConfig(environment);

  assert.equal(config.OSV_BASE_URL, 'https://api.osv.dev');
});

test('OSV_MODE=offline with OSV_BASE_URL fails fast and names OSV_BASE_URL', async () => {
  await assertConfigurationRejects(
    localConfiguration({ OSV_MODE: 'offline' }),
    'OSV_BASE_URL',
  );
});

test('OSV_BASE_URL rejects invalid or non-HTTP URLs', async () => {
  for (const invalidValue of ['not-a-url', 'file:///synthetic/osv']) {
    await assertConfigurationRejects(
      localConfiguration({ OSV_BASE_URL: invalidValue }),
      'OSV_BASE_URL',
    );
  }
});

test('OSV snapshot config leaves the pin unset and normalizes the mirror URL', async () => {
  const defaults = await loadConfig(localConfiguration());
  assert.equal(defaults.config.OSV_MIRROR_BASE_URL, 'https://storage.googleapis.com');
  assert.equal(defaults.config.OSV_SNAPSHOT_DATE, undefined);

  const configured = await loadConfig(localConfiguration({
    OSV_MIRROR_BASE_URL: 'https://mirror.osv.test/',
    OSV_SNAPSHOT_DATE: '2026-08-30',
  }));
  assert.equal(configured.config.OSV_MIRROR_BASE_URL, 'https://mirror.osv.test');
  assert.equal(configured.config.OSV_SNAPSHOT_DATE, '2026-08-30');
});

test('OSV snapshot config rejects unsafe mirrors and invalid dates', async () => {
  await assertConfigurationRejects(
    localConfiguration({ OSV_MIRROR_BASE_URL: 'file:///synthetic/osv' }),
    'OSV_MIRROR_BASE_URL',
  );
  for (const invalidDate of ['2026-8-31', '2026-02-30']) {
    await assertConfigurationRejects(
      localConfiguration({ OSV_SNAPSHOT_DATE: invalidDate }),
      'OSV_SNAPSHOT_DATE',
    );
  }
});

test('OSV scanner config uses safe defaults and rejects a relative cache path', async () => {
  const defaults = await loadConfig(localConfiguration());
  assert.equal(defaults.config.OSV_SCANNER_PATH, 'osv-scanner');
  assert.equal(
    defaults.config.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY,
    '/var/lib/bombot/osv-scanner',
  );

  const configured = await loadConfig(localConfiguration({
    OSV_SCANNER_PATH: '/opt/local/bin/osv-scanner',
    OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: '/var/lib/bombot/osv-scanner',
  }));
  assert.equal(configured.config.OSV_SCANNER_PATH, '/opt/local/bin/osv-scanner');
  assert.equal(
    configured.config.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY,
    '/var/lib/bombot/osv-scanner',
  );

  await assertConfigurationRejects(
    localConfiguration({ OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: 'relative/cache' }),
    'OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY',
  );
});

test('missing LLM_MODEL fails fast and names LLM_MODEL', async () => {
  await assert.rejects(
    loadConfig({
      PROFILE: 'hosted',
      LLM_API_KEY: 'synthetic-hosted-key',
      ...requiredConfiguration(),
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
      ...requiredConfiguration(),
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
      ...requiredConfiguration(),
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

test('LLM_REASONING_EFFORT rejects values outside the fixed enum', async () => {
  await assertConfigurationRejects(
    localConfiguration({ LLM_REASONING_EFFORT: 'maximum' }),
    'LLM_REASONING_EFFORT',
  );
});

test('LLM_SEED requires an integer when it is not null', async () => {
  await assertConfigurationRejects(
    localConfiguration({ LLM_SEED: '3.7' }),
    'LLM_SEED',
  );
});

test('missing DATABASE_URL fails fast and names DATABASE_URL', async () => {
  const environment = localConfiguration();
  delete environment.DATABASE_URL;

  await assertConfigurationRejects(environment, 'DATABASE_URL');
});

test('PARTICIPANT_ID_MODE defaults to email without requiring a salt', async () => {
  const { config } = await loadConfig(localConfiguration());

  assert.equal(config.PARTICIPANT_ID_MODE, 'email');
  assert.equal(config.PARTICIPANT_ID_SALT, undefined);
});

test('RETENTION_IDLE_HOURS is required and must be a positive integer', async () => {
  const missing = localConfiguration();
  delete missing.RETENTION_IDLE_HOURS;
  await assertConfigurationRejects(missing, 'RETENTION_IDLE_HOURS');

  for (const invalidValue of ['0', '-1', '24.5', '0.001']) {
    await assertConfigurationRejects(
      localConfiguration({ RETENTION_IDLE_HOURS: invalidValue }),
      'RETENTION_IDLE_HOURS',
    );
  }
  assert.equal((await loadConfig(localConfiguration({RETENTION_IDLE_HOURS:'1'}))).config.RETENTION_IDLE_HOURS,1);
});

test('SESSION_KEY_DIRECTORY uses a safe default and must be absolute', async () => {
  const defaults = await loadConfig(localConfiguration());
  assert.equal(defaults.config.SESSION_KEY_DIRECTORY, '/var/lib/bombot/session-keys');

  const configured = await loadConfig(localConfiguration({
    SESSION_KEY_DIRECTORY: '/synthetic/session-keys',
  }));
  assert.equal(configured.config.SESSION_KEY_DIRECTORY, '/synthetic/session-keys');

  await assertConfigurationRejects(
    localConfiguration({ SESSION_KEY_DIRECTORY: 'relative/session-keys' }),
    'SESSION_KEY_DIRECTORY',
  );
});

test('MAX_HISTORY_MESSAGES defaults to 20 when unset', async () => {
  const { config } = await loadConfig(localConfiguration());

  assert.equal(config.MAX_HISTORY_MESSAGES, 20);
});

test('MAX_HISTORY_MESSAGES requires a positive integer', async () => {
  for (const invalidValue of ['0', '-1', '3.7']) {
    await assertConfigurationRejects(
      localConfiguration({ MAX_HISTORY_MESSAGES: invalidValue }),
      'MAX_HISTORY_MESSAGES',
    );
  }
});

test('ENABLE_MODEL_TOOL_CALLS defaults false and parses only boolean literals', async () => {
  const defaultConfiguration = await loadConfig(localConfiguration());
  assert.equal(defaultConfiguration.config.ENABLE_MODEL_TOOL_CALLS, false);

  for (const [value, expected] of [['true', true], [' TRUE ', true], ['false', false], [' FaLsE ', false]]) {
    const { config } = await loadConfig(localConfiguration({ ENABLE_MODEL_TOOL_CALLS: value }));
    assert.equal(config.ENABLE_MODEL_TOOL_CALLS, expected);
  }
});

test('ENABLE_MODEL_TOOL_CALLS rejects non-boolean values', async () => {
  for (const invalidValue of ['', '1', 'yes', 'enabled']) {
    await assertConfigurationRejects(
      localConfiguration({ ENABLE_MODEL_TOOL_CALLS: invalidValue }),
      'ENABLE_MODEL_TOOL_CALLS',
    );
  }
});

test('pseudonymous participant IDs require a salt', async () => {
  await assertConfigurationRejects(
    localConfiguration({ PARTICIPANT_ID_MODE: 'pseudonymous' }),
    'PARTICIPANT_ID_SALT',
  );
});

test('pseudonymous participant IDs accept a sufficiently long salt', async () => {
  const { config } = await loadConfig(localConfiguration({
    PARTICIPANT_ID_MODE: 'pseudonymous',
    PARTICIPANT_ID_SALT: 'synthetic-participant-salt-32chars',
  }));

  assert.equal(config.PARTICIPANT_ID_MODE, 'pseudonymous');
  assert.equal(Boolean(config.PARTICIPANT_ID_SALT), true);
});
