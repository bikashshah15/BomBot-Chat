import OpenAI from 'openai';

import type {
  LlmChunk,
  LlmMessage,
  LlmOperation,
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
  conversationId?: string;
  useServerState?: boolean;
}

export interface OpenAIProvider extends LlmProvider {
  resolve(operation: LlmOperation): Promise<LlmResult>; // INC-06: remove
}

function toOpenAIInput(messages: LlmMessage[]): OpenAI.Responses.ResponseInput {
  const input: OpenAI.Responses.ResponseInput = [];

  for (const message of messages) {
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

function getCurrentTurn(messages: LlmMessage[]): LlmMessage[] {
  const nonSystemMessages = messages.filter(message => message.role !== 'system');
  if (nonSystemMessages.length === 0) {
    throw new Error('At least one non-system message is required');
  }

  const lastMessage = nonSystemMessages.at(-1);
  if (lastMessage?.role !== 'tool') {
    // INC-05: remove — OpenAI Conversations currently hold the earlier turns.
    return [lastMessage as LlmMessage];
  }

  let firstToolIndex = nonSystemMessages.length - 1;
  while (firstToolIndex > 0 && nonSystemMessages[firstToolIndex - 1].role === 'tool') {
    firstToolIndex -= 1;
  }

  // INC-05: remove — only the current tool-output group is sent while OpenAI holds history.
  return nonSystemMessages.slice(firstToolIndex);
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

function toLlmResult(
  response: OpenAI.Responses.Response,
  conversationId?: string,
): LlmResult {
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

  if (conversationId) result.conversationId = conversationId;
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
  const useServerState = options.useServerState ?? true;
  let conversationId = options.conversationId;

  async function resolveConversationId() {
    if (!useServerState) return undefined;
    if (!conversationId) {
      // INC-05: remove — app-owned history will not create an OpenAI Conversation.
      const conversation = await client.conversations.create();
      conversationId = conversation.id;
    }
    return conversationId;
  }

  async function baseRequest(req: LlmRequest): Promise<OpenAI.Responses.ResponseCreateParamsNonStreaming> {
    const requestMessages = useServerState
      ? getCurrentTurn(req.messages) // INC-05: remove — send the caller-supplied full history.
      : req.messages;
    const request: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: options.model,
      input: toOpenAIInput(requestMessages),
      tools: toOpenAITools(req.tools),
      temperature: req.temperature,
      top_p: req.topP,
      max_output_tokens: req.maxOutputTokens,
    };

    if (useServerState) {
      request.instructions = getInstructions(req.messages);
      request.conversation = await resolveConversationId(); // INC-05: remove
      request.store = true; // INC-05: remove
      request.parallel_tool_calls = true;
      request.metadata = {
        bombot_tool_round: String(req.continuation?.round ?? 0),
      }; // INC-05: remove
    } else {
      request.store = false;
    }

    // The Responses API has no seed request field. The gateway still carries seed
    // so providers that support it can apply the same study configuration.
    void req.seed;
    return request;
  }

  return {
    async complete(req) {
      const request = await baseRequest(req);
      const continuationIdentity = req.continuation?.idempotencyKey;
      const response = useServerState
        ? await client.responses.create({
          ...request,
          background: true, // INC-05: remove
        }, continuationIdentity ? {
          idempotencyKey: continuationIdentity,
          headers: { 'Idempotency-Key': continuationIdentity },
        } : undefined)
        : await client.responses.create(request);

      return toLlmResult(response, conversationId);
    },

    // INC-06: remove — hosted Responses polling is temporary provider state.
    async resolve(operation: LlmOperation) {
      if (!useServerState) {
        if (!operation.result) {
          throw new Error('A local LLM operation must carry its completed result');
        }
        return operation.result;
      }

      if (!operation.responseId) {
        throw new Error('A hosted LLM operation requires responseId');
      }

      const response = await client.responses.retrieve(operation.responseId);
      const resolvedConversationId = response.conversation?.id
        ?? operation.conversationId
        ?? conversationId;
      return toLlmResult(response, resolvedConversationId);
    },

    async *stream(req): AsyncIterable<LlmChunk> {
      const request = await baseRequest(req);
      const streamingRequest: OpenAI.Responses.ResponseCreateParamsStreaming = {
        ...request,
        stream: true,
      };
      const stream = await client.responses.create(streamingRequest);
      let emittedDone = false;

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          yield { delta: event.delta, done: false };
          continue;
        }

        if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
          yield {
            toolCalls: [{
              id: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments,
            }],
            done: false,
          };
          continue;
        }

        if (
          event.type === 'response.completed'
          || event.type === 'response.failed'
          || event.type === 'response.incomplete'
          || event.type === 'error'
        ) {
          emittedDone = true;
          yield { done: true };
        }
      }

      if (!emittedDone) yield { done: true };
    },
  };
}
