import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { config } from '../config.ts';
import type { ConversationMessage } from '../db/types.ts';
import { safeLog, safeValue } from '../logging/redact.ts';

export const DEMO_ACCESS_COOKIE = 'bombot_demo_access';

export type HostedGuardCode =
  | 'sbom_required'
  | 'demo_access_required'
  | 'invalid_origin'
  | 'hosted_rate_limited'
  | 'hosted_stream_busy'
  | 'hosted_budget_exhausted'
  | 'hosted_turn_limit';

export interface HostedGuardFailure {
  status: number;
  code: HostedGuardCode;
  error: string;
}

interface RollingEntry {
  timestamps: number[];
  total: number;
}

export interface HostedGuardLimits {
  sessionHourly: number;
  ipHourly: number;
  processBudget: number;
  maxTurnsPerConversation: number;
}

export interface HostedGuardState {
  sessions: Map<string, RollingEntry>;
  ips: Map<string, RollingEntry>;
  activeStreams: Set<string>;
  processRequests: number;
  rateLimitRejections: number;
}

export const hostedGuardLimits: HostedGuardLimits = Object.freeze({
  sessionHourly: config.HOSTED_SESSION_HOURLY_LIMIT,
  ipHourly: config.HOSTED_IP_HOURLY_LIMIT,
  processBudget: config.HOSTED_PROCESS_REQUEST_BUDGET,
  maxTurnsPerConversation: config.HOSTED_MAX_TURNS_PER_CONVERSATION,
});

export const hostedGuardState: HostedGuardState = {
  sessions: new Map(),
  ips: new Map(),
  activeStreams: new Set(),
  processRequests: 0,
  rateLimitRejections: 0,
};

const failures: Record<HostedGuardCode, HostedGuardFailure> = {
  sbom_required: { status: 409, code: 'sbom_required', error: 'Upload an SBOM before asking the hosted model.' },
  demo_access_required: { status: 403, code: 'demo_access_required', error: 'Hosted model access is not available for this request.' },
  invalid_origin: { status: 403, code: 'invalid_origin', error: 'This request origin is not allowed.' },
  hosted_rate_limited: { status: 429, code: 'hosted_rate_limited', error: 'Too many hosted-model requests. Please try again later.' },
  hosted_stream_busy: { status: 429, code: 'hosted_stream_busy', error: 'A hosted-model response is already in progress.' },
  hosted_budget_exhausted: { status: 429, code: 'hosted_budget_exhausted', error: 'Hosted model access is temporarily unavailable.' },
  hosted_turn_limit: { status: 429, code: 'hosted_turn_limit', error: 'This conversation has reached its hosted-model turn limit.' },
};

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function timingSafeSecretMatch(candidate: string, secret: string): boolean {
  const candidateDigest = digest(candidate);
  const secretDigest = digest(secret);
  return timingSafeEqual(candidateDigest, secretDigest);
}

export function demoCookieValue(secret: string): string {
  return digest(`bombot-demo-cookie\0${secret}`).toString('base64url');
}

function cookies(req: NextApiRequest): Record<string, string> {
  if (req.cookies) return req.cookies;
  const header = req.headers?.cookie;
  if (!header) return {};
  return Object.fromEntries(header.split(';').flatMap(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    const name = part.slice(0, separator).trim();
    try {
      return [[name, decodeURIComponent(part.slice(separator + 1).trim())]];
    } catch {
      return [];
    }
  }));
}

function requestIp(req: NextApiRequest): string | null {
  const forwarded = req.headers?.['x-forwarded-for'];
  const socketAddress = req.socket?.remoteAddress;
  const normalizedSocket = socketAddress?.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  const trustForwarded = isLoopback(normalizedSocket ?? null);
  const candidate = (trustForwarded
    ? (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    : undefined) || socketAddress;
  if (!candidate) return null;
  const normalized = candidate.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  return isIP(normalized) ? normalized : null;
}

function isLoopback(ip: string | null): boolean {
  return ip === '::1' || ip?.startsWith('127.') === true;
}

function hasDemoCookie(req: NextApiRequest): boolean {
  return Object.prototype.hasOwnProperty.call(cookies(req), DEMO_ACCESS_COOKIE);
}

function hasValidDemoCookie(req: NextApiRequest, secret: string): boolean {
  const candidate = cookies(req)[DEMO_ACCESS_COOKIE];
  return typeof candidate === 'string'
    && timingSafeSecretMatch(candidate, demoCookieValue(secret));
}

function sameOrigin(req: NextApiRequest): boolean {
  const origin = req.headers?.origin;
  if (!origin) return true;
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
  const hostValue = Array.isArray(host) ? host[0] : host;
  if (!hostValue) return false;
  const forwardedProtocol = req.headers?.['x-forwarded-proto'];
  const protocolValue = (Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol)
    ?.split(',')[0]?.trim();
  const protocol = protocolValue === 'http' || protocolValue === 'https'
    ? protocolValue
    : req.socket && 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http';
  try {
    return new URL(origin).origin === `${protocol}://${hostValue}`;
  } catch {
    return false;
  }
}

function reject(code: HostedGuardCode): HostedGuardFailure {
  if (code === 'hosted_rate_limited') hostedGuardState.rateLimitRejections += 1;
  safeLog(
    'warn',
    safeValue('Hosted guard refusal'),
    safeValue(code),
    safeValue('provider=hosted'),
    safeValue(hostedGuardState.processRequests),
    safeValue(hostedGuardState.rateLimitRejections),
  );
  return failures[code];
}

export function checkHostedAccess(
  req: NextApiRequest,
  demoToken: string | undefined = config.DEMO_ACCESS_TOKEN,
): HostedGuardFailure | null {
  if (hasDemoCookie(req) && !sameOrigin(req)) return reject('invalid_origin');
  if (demoToken) {
    return hasValidDemoCookie(req, demoToken)
      ? null
      : reject('demo_access_required');
  }
  return isLoopback(requestIp(req)) ? null : reject('demo_access_required');
}

function conversationFailure(messages: ConversationMessage[]): HostedGuardFailure | null {
  if (!messages.some(message => message.role === 'user' && message.pinned)) {
    return reject('sbom_required');
  }
  const hostedTurns = messages.filter(message => message.role === 'user' && !message.pinned).length;
  return hostedTurns >= hostedGuardLimits.maxTurnsPerConversation
    ? reject('hosted_turn_limit')
    : null;
}

export function checkHostedRequest(
  req: NextApiRequest,
  messages: ConversationMessage[],
): HostedGuardFailure | null {
  const failure = checkHostedAccess(req) ?? conversationFailure(messages);
  if (failure) return failure;
  return hostedGuardState.processRequests >= hostedGuardLimits.processBudget
    ? reject('hosted_budget_exhausted')
    : null;
}

function rollingEntry(map: Map<string, RollingEntry>, key: string, now: number): RollingEntry {
  const entry = map.get(key) ?? { timestamps: [], total: 0 };
  entry.timestamps = entry.timestamps.filter(timestamp => timestamp > now - 60 * 60 * 1000);
  map.set(key, entry);
  return entry;
}

export function acquireHostedStream(
  req: NextApiRequest,
  sessionId: string,
  messages: ConversationMessage[],
  now = Date.now(),
): { failure: HostedGuardFailure | null; release: () => void } {
  const preflightFailure = checkHostedRequest(req, messages);
  if (preflightFailure) return { failure: preflightFailure, release() {} };
  const ip = requestIp(req);
  if (!ip) return { failure: reject('demo_access_required'), release() {} };
  if (hostedGuardState.activeStreams.has(sessionId)) {
    return { failure: reject('hosted_stream_busy'), release() {} };
  }

  const session = rollingEntry(hostedGuardState.sessions, sessionId, now);
  const ipEntry = rollingEntry(hostedGuardState.ips, ip, now);
  if (session.timestamps.length >= hostedGuardLimits.sessionHourly
    || ipEntry.timestamps.length >= hostedGuardLimits.ipHourly) {
    return { failure: reject('hosted_rate_limited'), release() {} };
  }
  if (hostedGuardState.processRequests >= hostedGuardLimits.processBudget) {
    return { failure: reject('hosted_budget_exhausted'), release() {} };
  }

  session.timestamps.push(now);
  session.total += 1;
  ipEntry.timestamps.push(now);
  ipEntry.total += 1;
  hostedGuardState.processRequests += 1;
  hostedGuardState.activeStreams.add(sessionId);
  let released = false;
  return {
    failure: null,
    release() {
      if (released) return;
      released = true;
      hostedGuardState.activeStreams.delete(sessionId);
    },
  };
}

export function sendHostedGuardFailure(
  res: NextApiResponse,
  failure: HostedGuardFailure,
) {
  return res.status(failure.status).json({ code: failure.code, error: failure.error });
}

export function hostedGuardVisibility(sessionId: string | undefined) {
  return {
    hostedRequestsThisSession: sessionId
      ? hostedGuardState.sessions.get(sessionId)?.total ?? 0
      : 0,
    rateLimitRejections: hostedGuardState.rateLimitRejections,
  };
}

export function resetHostedGuardStateForTests(): void {
  hostedGuardState.sessions.clear();
  hostedGuardState.ips.clear();
  hostedGuardState.activeStreams.clear();
  hostedGuardState.processRequests = 0;
  hostedGuardState.rateLimitRejections = 0;
}
