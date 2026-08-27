export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  continuation?: LlmContinuation;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  seed?: number | null;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmContinuation {
  round: number;
  predecessorResponseId: string;
  idempotencyKey: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type LlmResultStatus =
  | 'completed'
  | 'failed'
  | 'in_progress'
  | 'cancelled'
  | 'queued'
  | 'incomplete';

export interface LlmError {
  code?: string;
  message: string;
}

export interface LlmIncompleteDetails {
  reason?: string;
}

export interface LlmResult {
  content: string;
  toolCalls: LlmToolCall[];
  done: boolean;
  responseId?: string;
  conversationId?: string;
  status: LlmResultStatus;
  error?: LlmError;
  incompleteDetails?: LlmIncompleteDetails;
  createdAt?: number;
  completedAt?: number | null;
  model?: string;
  metadata?: Record<string, string>;
  usage?: LlmUsage;
  rawUsage?: unknown;
}

export interface LlmChunk {
  delta?: string;
  toolCalls?: LlmToolCall[];
  result?: LlmResult;
  done: boolean;
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResult>;
  stream(req: LlmRequest): AsyncIterable<LlmChunk>;
}
