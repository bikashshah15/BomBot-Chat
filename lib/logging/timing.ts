import { safeLog, safeValue } from './redact.ts';

export const TIMING_TOOL_NAMES = [
  'query_package_vulnerabilities',
  'query_cve_details',
  'analyze_sbom_package',
  'query_package_dependencies',
] as const;
export const TIMING_ROUNDS_CAP = 9;

const MAX_DURATION_MS = 86_400_000;
const TOOL_RECORDS_CAP = 64;

type TimingToolName = typeof TIMING_TOOL_NAMES[number] | 'unknown';

export function createTimer(now: () => number = () => performance.now()): {
  start(): number;
  since(startedAt: number): number;
} {
  return {
    start: now,
    since(startedAt: number) {
      const elapsed = now() - startedAt;
      if (!Number.isFinite(elapsed)) return 0;
      return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(elapsed)));
    },
  };
}

export function timingToolName(value: unknown): TimingToolName {
  return typeof value === 'string'
    && (TIMING_TOOL_NAMES as readonly string[]).includes(value)
    ? value as TimingToolName
    : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every(key => allowed.includes(key));
}

function numberOrNull(
  value: unknown,
  markInvalid: () => void,
  maximum?: number,
): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    markInvalid();
    return undefined;
  }
  const rounded = Math.round(value);
  if (maximum !== undefined && rounded > maximum) {
    markInvalid();
    return undefined;
  }
  return rounded;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  markInvalid: () => void,
): T | undefined {
  if (typeof value === 'string' && values.includes(value as T)) return value as T;
  markInvalid();
  return undefined;
}

function booleanValue(value: unknown, markInvalid: () => void): boolean | undefined {
  if (typeof value === 'boolean') return value;
  markInvalid();
  return undefined;
}

export function formatTimingRecord(value: unknown): string {
  try {
    let invalid = false;
    const markInvalid = () => { invalid = true; };
    const output: Record<string, unknown> = { event: 'timing_v1' };

    if (!isRecord(value)) {
      output.invalid = true;
      return JSON.stringify(output);
    }

    const kind = enumValue(value.kind, ['chat_turn', 'upload'] as const, markInvalid);
    if (kind) output.kind = kind;

    if (kind === 'chat_turn') {
      const allowed = [
        'kind', 'tools_enabled', 'outcome', 'history_load_ms', 'rounds', 'tools',
        'persist_ms', 'total_ms',
      ];
      if (!hasOnlyKeys(value, allowed)) markInvalid();

      const toolsEnabled = booleanValue(value.tools_enabled, markInvalid);
      if (toolsEnabled !== undefined) output.tools_enabled = toolsEnabled;
      const outcome = enumValue(
        value.outcome,
        ['completed', 'model_error', 'exception', 'sequence_conflict'] as const,
        markInvalid,
      );
      if (outcome) output.outcome = outcome;

      const historyLoadMs = numberOrNull(value.history_load_ms, markInvalid, MAX_DURATION_MS);
      if (historyLoadMs !== undefined) output.history_load_ms = historyLoadMs;

      if (!Array.isArray(value.rounds) || value.rounds.length > TIMING_ROUNDS_CAP) {
        markInvalid();
      } else {
        const rounds: Record<string, unknown>[] = [];
        for (const round of value.rounds) {
          if (!isRecord(round)) {
            markInvalid();
            continue;
          }
          const allowedRoundKeys = [
            'db_prep_ms', 'model_first_chunk_ms', 'model_stream_ms', 'db_append_ms',
            'input_tokens', 'output_tokens', 'tool_calls_requested',
          ];
          if (!hasOnlyKeys(round, allowedRoundKeys)) markInvalid();
          const cleanRound: Record<string, unknown> = {};
          for (const key of allowedRoundKeys) {
            const parsed = numberOrNull(round[key], markInvalid,
              key.endsWith('_ms') ? MAX_DURATION_MS : undefined);
            if (parsed !== undefined) cleanRound[key] = parsed;
          }
          rounds.push(cleanRound);
        }
        output.rounds = rounds;
      }

      if (!Array.isArray(value.tools) || value.tools.length > TOOL_RECORDS_CAP) {
        markInvalid();
      } else {
        const tools: Record<string, unknown>[] = [];
        for (const tool of value.tools) {
          if (!isRecord(tool)) {
            markInvalid();
            continue;
          }
          if (!hasOnlyKeys(tool, ['round', 'tool', 'ms', 'ok'])) markInvalid();
          const cleanTool: Record<string, unknown> = {};
          const round = numberOrNull(tool.round, markInvalid);
          if (round !== undefined) cleanTool.round = round;
          const mappedTool = timingToolName(tool.tool);
          if (mappedTool === 'unknown' && tool.tool !== 'unknown') markInvalid();
          cleanTool.tool = mappedTool;
          const ms = numberOrNull(tool.ms, markInvalid, MAX_DURATION_MS);
          if (ms !== undefined) cleanTool.ms = ms;
          const ok = booleanValue(tool.ok, markInvalid);
          if (ok !== undefined) cleanTool.ok = ok;
          tools.push(cleanTool);
        }
        output.tools = tools;
      }
      for (const key of ['persist_ms', 'total_ms'] as const) {
        const parsed = numberOrNull(value[key], markInvalid, MAX_DURATION_MS);
        if (parsed !== undefined) output[key] = parsed;
      }
    } else if (kind === 'upload') {
      const allowed = [
        'kind', 'osv_mode', 'outcome', 'parse_ms', 'scan_ms', 'persist_ms',
        'total_ms', 'packages_scanned', 'packages_total',
      ];
      if (!hasOnlyKeys(value, allowed)) markInvalid();

      const osvMode = enumValue(value.osv_mode, ['api', 'offline'] as const, markInvalid);
      if (osvMode) output.osv_mode = osvMode;
      const outcome = enumValue(
        value.outcome,
        ['ok', 'client_error', 'conflict', 'exception'] as const,
        markInvalid,
      );
      if (outcome) output.outcome = outcome;
      for (const key of [
        'parse_ms', 'scan_ms', 'persist_ms', 'total_ms', 'packages_scanned', 'packages_total',
      ] as const) {
        const parsed = numberOrNull(value[key], markInvalid,
          key.endsWith('_ms') ? MAX_DURATION_MS : undefined);
        if (parsed !== undefined) output[key] = parsed;
      }
    } else {
      markInvalid();
      if (Object.keys(value).some(key => key !== 'kind')) markInvalid();
    }

    if (invalid) output.invalid = true;
    return JSON.stringify(output);
  } catch {
    return '{"event":"timing_v1","invalid":true}';
  }
}

export function logTiming(record: unknown): void {
  try {
    safeLog('log', safeValue(formatTimingRecord(record)));
  } catch {
    // Timing diagnostics cannot affect request control flow.
  }
}
