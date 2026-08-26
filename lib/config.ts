import { z, type ZodError, type ZodNumber } from 'zod';

const DEFAULT_OSV_BASE_URL = 'https://api.osv.dev';

function numericEnvironmentVariable(schema: ZodNumber) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : Number(trimmed);
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

const environmentSchema = z.object({
  PROFILE: z.enum(['hosted', 'local']).default('hosted'),
  LLM_BASE_URL: z.string().trim().url().default('https://api.openai.com/v1'),
  LLM_MODEL: z.string().trim().min(1),
  LLM_API_KEY: z.string().trim().min(1).optional(),
  OSV_MODE: z.enum(['api', 'offline']).default('api'),
  OSV_BASE_URL: outboundHttpUrl.optional(),
  RETENTION: z.enum(['study', 'ephemeral']).default('study'),
  LLM_TEMPERATURE: numericEnvironmentVariable(z.number().finite().min(0).max(2)),
  LLM_TOP_P: numericEnvironmentVariable(z.number().finite().min(0).max(1)),
  LLM_MAX_OUTPUT_TOKENS: numericEnvironmentVariable(z.number().finite().int().positive()),
  LLM_SEED: nullableNumber,
}).superRefine((value, context) => {
  if (value.PROFILE === 'hosted' && !value.LLM_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LLM_API_KEY'],
      message: 'is required when PROFILE=hosted',
    });
  }

  if (value.OSV_MODE === 'offline' && value.OSV_BASE_URL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OSV_BASE_URL'],
      message: 'must be unset when OSV_MODE=offline',
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
