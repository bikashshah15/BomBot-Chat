import { z, type ZodError } from 'zod';
import { isIP } from 'node:net';
import path from 'node:path';

const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OSV_BASE_URL = 'https://api.osv.dev';
const DEFAULT_OSV_MIRROR_BASE_URL = 'https://storage.googleapis.com';
const DEFAULT_OSV_SCANNER_CACHE_DIRECTORY = '/var/lib/bombot/osv-scanner';
const DEFAULT_SESSION_KEY_DIRECTORY = '/var/lib/bombot/session-keys';

function numericEnvironmentVariable(schema: z.ZodType<number>) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : Number(trimmed);
  }, schema);
}

function booleanEnvironmentVariable(schema: z.ZodType<boolean>) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return value;
  }, schema);
}

const nullableNumber = z.preprocess((value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
    return Number(trimmed);
  }
  return value;
}, z.number().finite().int().nullable());

const outboundHttpUrl = z.string().trim().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'must use http or https').transform(value => value.replace(/\/+$/, ''));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must use YYYY-MM-DD').refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'must be a valid calendar date');

function isLocalInferenceUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === 'host.docker.internal'
    || hostname === 'model'
  ) return true;

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const [first, second] = hostname.split('.').map(Number);
    return first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }

  if (ipVersion === 6) {
    return hostname === '::1'
      || hostname.startsWith('fc')
      || hostname.startsWith('fd')
      || /^fe[89ab]/.test(hostname);
  }

  return false;
}

const environmentSchema = z.object({
  DATABASE_URL: z.string().trim().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  }, 'must use postgres or postgresql'),
  PROFILE: z.enum(['hosted', 'local']).default('hosted'),
  LLM_BASE_URL: z.string().trim().url().default(DEFAULT_LLM_BASE_URL),
  LLM_MODEL: z.string().trim().min(1),
  LLM_API_KEY: z.string().trim().min(1).optional(),
  OSV_MODE: z.enum(['api', 'offline']).default('api'),
  OSV_BASE_URL: outboundHttpUrl.optional(),
  OSV_MIRROR_BASE_URL: outboundHttpUrl.default(DEFAULT_OSV_MIRROR_BASE_URL),
  OSV_SNAPSHOT_DATE: isoDate.optional(),
  OSV_SCANNER_PATH: z.string().trim().min(1).default('osv-scanner'),
  OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: z.string().trim().min(1)
    .refine(value => path.isAbsolute(value), 'must be an absolute path')
    .default(DEFAULT_OSV_SCANNER_CACHE_DIRECTORY),
  MEASURE_PROVIDER_MODULE: z.string().trim().min(1).optional(),
  INSTRUCTIONS_FILE: z.string().trim().min(1).optional(),
  RETENTION: z.enum(['study', 'ephemeral']).default('study'),
  RETENTION_IDLE_HOURS: numericEnvironmentVariable(z.number().finite().int().positive()),
  SESSION_KEY_DIRECTORY: z.string().trim().min(1)
    .refine(value => path.isAbsolute(value), 'must be an absolute path')
    .default(DEFAULT_SESSION_KEY_DIRECTORY),
  PARTICIPANT_ID_MODE: z.enum(['email', 'pseudonymous']).default('email'),
  PARTICIPANT_ID_SALT: z.string().trim().min(32).optional(),
  MAX_HISTORY_MESSAGES: numericEnvironmentVariable(z.number().finite().int().positive().default(20)),
  ENABLE_MODEL_TOOL_CALLS: booleanEnvironmentVariable(z.boolean().default(false)),
  ENABLE_MODEL_TOGGLE: booleanEnvironmentVariable(z.boolean().default(false)),
  LLM_TEMPERATURE: numericEnvironmentVariable(z.number().finite().min(0).max(2)),
  LLM_TOP_P: numericEnvironmentVariable(z.number().finite().min(0).max(1)),
  LLM_MAX_OUTPUT_TOKENS: numericEnvironmentVariable(z.number().finite().int().positive()),
  LLM_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  LLM_SEED: nullableNumber,
  ALT_PROFILE: z.enum(['hosted', 'local']).optional(),
  ALT_LLM_BASE_URL: z.string().trim().url().optional(),
  ALT_LLM_MODEL: z.string().trim().min(1).optional(),
  ALT_LLM_API_KEY: z.string().trim().min(1).optional(),
  ALT_LLM_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
}).superRefine((value, context) => {
  if (value.PROFILE === 'hosted' && !value.LLM_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LLM_API_KEY'],
      message: 'is required when PROFILE=hosted',
    });
  }

  if (value.PROFILE === 'local' && !isLocalInferenceUrl(value.LLM_BASE_URL)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LLM_BASE_URL'],
      message: 'must point to a local inference server when PROFILE=local',
    });
  }

  if (value.ENABLE_MODEL_TOGGLE) {
    for (const key of ['ALT_PROFILE', 'ALT_LLM_BASE_URL', 'ALT_LLM_MODEL'] as const) {
      if (!value[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `is required when ENABLE_MODEL_TOGGLE=true`,
        });
      }
    }

    if (value.ALT_PROFILE === 'hosted' && !value.ALT_LLM_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALT_LLM_API_KEY'],
        message: 'is required when ENABLE_MODEL_TOGGLE=true and ALT_PROFILE=hosted',
      });
    }

    if (value.ALT_PROFILE === 'local' && value.ALT_LLM_BASE_URL
      && !isLocalInferenceUrl(value.ALT_LLM_BASE_URL)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALT_LLM_BASE_URL'],
        message: 'must point to a local inference server when ALT_PROFILE=local',
      });
    }
  }

  if (value.OSV_MODE === 'offline' && value.OSV_BASE_URL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OSV_BASE_URL'],
      message: 'must be unset when OSV_MODE=offline',
    });
  }

  if (value.PARTICIPANT_ID_MODE === 'pseudonymous' && !value.PARTICIPANT_ID_SALT) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PARTICIPANT_ID_SALT'],
      message: 'is required when PARTICIPANT_ID_MODE=pseudonymous',
    });
  }
}).transform(value => ({
  ...value,
  OSV_BASE_URL: value.OSV_MODE === 'api'
    ? value.OSV_BASE_URL ?? DEFAULT_OSV_BASE_URL
    : undefined,
}));

function formatConfigurationError(error: ZodError) {
  return error.issues
    .map(issue => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
    .join('; ');
}

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  throw new Error(`Invalid environment configuration: ${formatConfigurationError(parsedEnvironment.error)}`);
}

export const config = Object.freeze(parsedEnvironment.data);
export type Config = typeof config;
