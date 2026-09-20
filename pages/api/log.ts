import { safeLog, safeValue, errorClass } from '../../lib/logging/redact.ts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import { insertLog } from '../../lib/db/chatLogs.ts';

// A session UUID is a bearer capability, not identity proof. It is not registered
// against a person: possession permits use, while logging, sharing, or leaking the
// value defeats this check. Its unguessability prevents practical enumeration only.
const sessionCapabilitySchema = z.string().uuid().refine(
  value => value.slice(14, 15) === '4',
  'must be a version 4 UUID',
);

const initializeSessionSchema = z.object({
  action: z.literal('initialize_session'),
  sessionId: sessionCapabilitySchema,
}).strict();

const logMessageSchema = z.object({
  action: z.literal('log_message'),
  sessionId: sessionCapabilitySchema,
  conversationId: z.string().trim().min(1).max(255).nullable().optional(),
  messageIndex: z.number().int().nonnegative(),
  messageType: z.enum(['user', 'assistant', 'file_upload']),
  userMessage: z.string().nullable().optional(),
  aiResponse: z.string().nullable().optional(),
  fileName: z.string().max(255).nullable().optional(),
  fileSize: z.number().int().nonnegative().nullable().optional(),
  vulnerabilityCount: z.number().int().nonnegative().nullable().optional(),
}).strict();

const logRequestSchema = z.discriminatedUnion('action', [
  initializeSessionSchema,
  logMessageSchema,
]);

function safeErrorDetails(error: unknown) {
  if (!error || typeof error !== 'object') return { name: 'UnknownError' };
  const candidate = error as { name?: unknown; code?: unknown };
  return {
    name: typeof candidate.name === 'string' ? candidate.name : 'Error',
    code: typeof candidate.code === 'string' ? candidate.code : undefined,
  };
}

interface LogHandlerDependencies {
  insertLog: typeof insertLog;
}

function removeLegacyEmailField(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const sanitized = { ...body } as Record<string, unknown>;
  Reflect.deleteProperty(sanitized, 'userEmail');
  return sanitized;
}

export function createLogHandler(overrides: Partial<LogHandlerDependencies> = {}) {
  const dependencies: LogHandlerDependencies = { insertLog, ...overrides };

  return async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const parsedRequest = logRequestSchema.safeParse(removeLegacyEmailField(req.body));
  if (!parsedRequest.success) {
    safeLog('error', safeValue("Log API rejected an invalid request body"));
    return res.status(400).json({ error: 'Invalid log request' });
  }

  if (parsedRequest.data.action === 'initialize_session') {
    // The first persisted log row establishes the session. This call validates that
    // the browser generated the capability in the expected format without inventing
    // a synthetic chat row that would distort message and analytics semantics.
    return res.status(200).json({ success: true });
  }

  const request = parsedRequest.data;
  const now = new Date().toISOString();

  try {
    const log = await dependencies.insertLog({
      id: uuidv4(),
      session_id: request.sessionId,
      conversation_id: request.conversationId ?? null,
      message_index: request.messageIndex,
      message_type: request.messageType,
      user_message: request.userMessage ?? null,
      ai_response: request.aiResponse ?? null,
      file_name: request.fileName ?? null,
      file_size: request.fileSize ?? null,
      vulnerability_count: request.vulnerabilityCount ?? null,
      user_email: null,
      created_at: now,
      updated_at: now,
    });

    return res.status(201).json({ success: true, log });
  } catch (error) {
    safeLog('error', safeValue("Log API database write failed:"), safeValue(errorClass(error)));
    return res.status(500).json({ error: 'Failed to persist log entry' });
  }
  };
}

export default createLogHandler();
