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
  conversationId?: string;
  useServerState?: boolean;
}

function toOpenAIInput(messages: LlmMessage[]): OpenAI.Responses.ResponseInput {
  return messages.map((message) => {
    if (message.role !== 'tool') {
      return {
        role: message.role,
        content: message.content,
      };
    }

    if (!message.toolCallId) {
      throw new Error('A tool message requires toolCallId');
    }

    return {
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    };
  });
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
  };

  if (conversationId) result.conversationId = conversationId;
  if (response.error?.message) result.error = response.error.message;
  if (response.usage) {
    result.usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.total_tokens,
    };
  }

  return result;
}

export function createOpenAIProvider(options: OpenAIProviderOptions): LlmProvider {
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
      const response = useServerState
        ? await client.responses.create({
          ...request,
          background: true, // INC-05: remove
        })
        : await client.responses.create(request);

      return toLlmResult(response, conversationId);
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
