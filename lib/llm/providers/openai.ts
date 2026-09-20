import OpenAI from 'openai';

import type {
  LlmChunk,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmToolCall,
  LlmToolDef,
} from '../types.ts';

export interface OpenAIProviderOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  client?: OpenAI;
}

export type OpenAIProvider = LlmProvider;

function toOpenAIInput(messages: LlmMessage[]): OpenAI.Responses.ResponseInput {
  const input: OpenAI.Responses.ResponseInput = [];

  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'assistant' && message.toolCalls?.length) {
      if (message.content) {
        input.push({ role: 'assistant', content: message.content });
      }
      for (const toolCall of message.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
      }
      continue;
    }

    if (message.role !== 'tool') {
      input.push({ role: message.role, content: message.content });
      continue;
    }

    if (!message.toolCallId) {
      throw new Error('A tool message requires toolCallId');
    }

    input.push({
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    });
  }

  return input;
}

function toOpenAITools(tools: LlmToolDef[] | undefined): OpenAI.Responses.FunctionTool[] | undefined {
  return tools?.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict ?? false,
  }));
}

function getInstructions(messages: LlmMessage[]): string | undefined {
  const instructions = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n');
  return instructions || undefined;
}

function getToolCalls(response: OpenAI.Responses.Response): LlmToolCall[] {
  return response.output
    .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call')
    .map(item => ({
      id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    }));
}

function toLlmResult(response: OpenAI.Responses.Response): LlmResult {
  const terminalStatuses = new Set(['completed', 'failed', 'incomplete', 'cancelled']);
  const result: LlmResult = {
    content: response.output_text || '',
    toolCalls: getToolCalls(response),
    done: terminalStatuses.has(response.status),
    responseId: response.id,
    status: response.status,
    createdAt: response.created_at,
    completedAt: response.completed_at,
    model: response.model,
  };

  if (response.error) result.error = { ...response.error };
  if (response.incomplete_details) {
    result.incompleteDetails = { ...response.incomplete_details };
  }
  if (response.metadata) result.metadata = { ...response.metadata };
  if (response.usage) {
    result.usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.total_tokens,
    };
    result.rawUsage = response.usage;
  }

  return result;
}

export function createOpenAIProvider(options: OpenAIProviderOptions): OpenAIProvider {
  if (!options.client && !options.apiKey) {
    throw new Error('An OpenAI API key is required when no client is supplied');
  }

  const client = options.client ?? new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  async function baseRequest(req: LlmRequest): Promise<OpenAI.Responses.ResponseCreateParamsNonStreaming> {
    const request: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: options.model,
      instructions: getInstructions(req.messages),
      input: toOpenAIInput(req.messages),
      tools: toOpenAITools(req.tools),
      ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
      ...(req.reasoningEffort === undefined || req.reasoningEffort === 'none' ? {
        temperature: req.temperature,
        top_p: req.topP,
      } : {}),
      max_output_tokens: req.maxOutputTokens,
      store: false,
      parallel_tool_calls: true,
    };

    // The Responses API has no seed request field. The gateway still carries seed
    // so providers that support it can apply the same study configuration.
    void req.seed;
    return request;
  }

  return {
    async complete(req) {
      const request = await baseRequest(req);
      const continuationIdentity = req.continuation?.idempotencyKey;
      const response = await client.responses.create(request, continuationIdentity ? {
        idempotencyKey: continuationIdentity,
        headers: { 'Idempotency-Key': continuationIdentity },
      } : undefined);

      return toLlmResult(response);
    },

    async *stream(req): AsyncIterable<LlmChunk> {
      const request = await baseRequest(req);
      const streamingRequest: OpenAI.Responses.ResponseCreateParamsStreaming = {
        ...request,
        stream: true,
      };
      const continuationIdentity = req.continuation?.idempotencyKey;
      const stream = await client.responses.create(streamingRequest, continuationIdentity ? {
        idempotencyKey: continuationIdentity,
        headers: { 'Idempotency-Key': continuationIdentity },
      } : undefined);
      let emittedDone = false;
      let streamedContent = '';
      const streamedToolCalls: LlmToolCall[] = [];

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          streamedContent += event.delta;
          yield { delta: event.delta, done: false };
          continue;
        }

        if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
          const toolCall = {
            id: event.item.call_id,
            name: event.item.name,
            arguments: event.item.arguments,
          };
          streamedToolCalls.push(toolCall);
          yield {
            toolCalls: [toolCall],
            done: false,
          };
          continue;
        }

        if (
          event.type === 'response.completed'
          || event.type === 'response.failed'
          || event.type === 'response.incomplete'
        ) {
          emittedDone = true;
          yield { result: toLlmResult(event.response), done: true };
          continue;
        }

        if (event.type === 'error') {
          emittedDone = true;
          yield {
            result: {
              content: streamedContent,
              toolCalls: streamedToolCalls,
              done: true,
              status: 'failed',
              error: {
                message: 'message' in event && typeof event.message === 'string'
                  ? event.message
                  : 'LLM streaming failed',
              },
            },
            done: true,
          };
        }
      }

      if (!emittedDone) {
        yield {
          result: {
            content: streamedContent,
            toolCalls: streamedToolCalls,
            done: true,
            status: 'completed',
          },
          done: true,
        };
      }
    },
  };
}
