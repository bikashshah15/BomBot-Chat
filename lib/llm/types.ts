export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
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

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmResult {
  content: string;
  toolCalls: LlmToolCall[];
  done: boolean;
  responseId?: string;
  conversationId?: string;
  status?: string;
  error?: string;
  usage?: LlmUsage;
}

export interface LlmChunk {
  delta?: string;
  toolCalls?: LlmToolCall[];
  done: boolean;
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResult>;
  stream(req: LlmRequest): AsyncIterable<LlmChunk>;
}
