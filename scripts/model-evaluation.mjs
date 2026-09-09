import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const runner = new URL('./model-evaluation-runner.mjs', import.meta.url);
const childEnvironment = {
  ...process.env,
  DATABASE_URL: process.env.MODEL_EVALUATION_DATABASE_URL
    ?? 'postgresql://bombot:bombot_dev_password@127.0.0.1:5432/bombot',
  PROFILE: 'local',
  LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
  LLM_MODEL: 'bombot-qwen2.5-7b-instruct-q4_K_M:latest',
  OSV_MODE: 'offline',
  OSV_SCANNER_PATH: 'osv-scanner',
  OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: process.env.MODEL_EVALUATION_OSV_CACHE_DIRECTORY
    ?? path.join(os.homedir(), 'bombot-osv', 'scanner-db'),
  RETENTION: 'study',
  PARTICIPANT_ID_MODE: 'email',
  MAX_HISTORY_MESSAGES: '20',
  ENABLE_MODEL_TOOL_CALLS: 'false',
  LLM_TEMPERATURE: '0',
  LLM_TOP_P: '1',
  LLM_MAX_OUTPUT_TOKENS: '4096',
  LLM_SEED: 'null',
};
delete childEnvironment.LLM_API_KEY;
delete childEnvironment.OSV_BASE_URL;

const child = spawn(process.execPath, [runner.pathname], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: 'inherit',
});
child.once('error', error => {
  throw error;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
