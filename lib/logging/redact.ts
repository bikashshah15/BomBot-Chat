const approved = new WeakMap<object, string | number | boolean | null>();
const REDACTED = '[REDACTED]';

/** Explicit opt-in for reviewed, content-free scalar diagnostics only. */
export function safeValue(value: unknown): object {
  const token = Object.freeze({});
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) {
    approved.set(token, value as string | number | boolean | null);
  }
  return token;
}

/** Never inspect, traverse, or stringify an unapproved value. */
export function redact(value: unknown): string | number | boolean | null {
  try {
    if (typeof value === 'object' && value !== null && approved.has(value)) {
      return approved.get(value)!;
    }
  } catch { /* Fail closed. */ }
  return REDACTED;
}

/** Built-in classes only: mutable name/code/message/stack are untrusted payloads. */
export function errorClass(value: unknown): string {
  try {
    for (const type of [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError]) {
      if (value instanceof type) return type.name;
    }
    if (value instanceof Error) return 'Error';
  } catch { /* Revoked proxies and hostile prototypes are unknown errors. */ }
  return 'UnknownError';
}

/** Console failures cannot escape into request or worker control flow. */
export function safeLog(level: 'log' | 'warn' | 'error', ...values: unknown[]): void {
  try { console[level](...values.map(redact)); } catch { /* Logging is best effort. */ }
}
