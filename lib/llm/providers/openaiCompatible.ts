import OpenAI from 'openai';

import type {
  LlmChunk,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmResultStatus,
  LlmToolCall,
  LlmToolDef,
} from '../types.ts';

type ChatCompletionRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletionStreamRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

export interface OpenAICompatibleTransport {
  complete(request: ChatCompletionRequest): Promise<OpenAI.Chat.Completions.ChatCompletion>;
  stream(
    request: ChatCompletionStreamRequest,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
}

export interface OpenAICompatibleProviderOptions {
  model: string;
  baseURL: string;
  apiKey?: string;
  transport?: OpenAICompatibleTransport;
}

export type OpenAICompatibleProvider = LlmProvider;

function toCompatibleMessages(
  messages: LlmMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('A tool message requires toolCallId');
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }

    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map(toolCall => ({
            id: toolCall.id,
            type: 'function' as const,
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          })),
        } : {}),
      };
    }

    return { role: message.role, content: message.content };
  });
}

function toCompatibleTools(
  tools: LlmToolDef[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  return tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict ?? false,
    },
  }));
}

function getToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): LlmToolCall[] {
  return (toolCalls ?? [])
    .filter((toolCall): toolCall is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => (
      toolCall.type === 'function'
    ))
    .map(toolCall => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    }));
}

function statusFromFinishReason(
  finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'],
): Pick<LlmResult, 'status' | 'incompleteDetails'> {
  if (finishReason === 'length' || finishReason === 'content_filter') {
    return {
      status: 'incomplete',
      incompleteDetails: {
        reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter',
      },
    };
  }

  return { status: 'completed' };
}

function toUsage(
  usage: OpenAI.CompletionUsage | undefined,
): Pick<LlmResult, 'usage' | 'rawUsage'> {
  if (!usage) return {};
  return {
    usage: {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    },
    rawUsage: usage,
  };
}

function toLlmResult(response: OpenAI.Chat.Completions.ChatCompletion): LlmResult {
  const choice = response.choices[0];
  if (!choice) {
    return {
      content: '',
      toolCalls: [],
      done: true,
      responseId: response.id,
      status: 'failed',
      error: { message: 'OpenAI-compatible server returned no completion choices' },
      createdAt: response.created,
      model: response.model,
      ...toUsage(response.usage),
    };
  }

  return {
    content: choice.message.content ?? '',
    toolCalls: getToolCalls(choice.message.tool_calls),
    done: true,
    responseId: response.id,
    ...statusFromFinishReason(choice.finish_reason),
    createdAt: response.created,
    model: response.model,
    ...toUsage(response.usage),
  };
}

function transportError(baseURL: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const endpoint = `${baseURL.replace(/\/+$/, '')}/chat/completions`;
  return new Error(
    `OpenAI-compatible LLM server is unreachable or rejected the request at ${endpoint}: ${detail}`,
  );
}

function createSdkTransport(options: OpenAICompatibleProviderOptions): OpenAICompatibleTransport {
  const client = new OpenAI({
    apiKey: options.apiKey ?? 'local-openai-compatible',
    baseURL: options.baseURL,
  });

  return {
    async complete(request) {
      return client.chat.completions.create(request);
    },
    async stream(request) {
      return client.chat.completions.create(request);
    },
  };
}

function baseRequest(
  options: OpenAICompatibleProviderOptions,
  req: LlmRequest,
): ChatCompletionRequest {
  // Reasoning effort is a hosted Responses API setting; local requests ignore it.
  void req.reasoningEffort;
  return {
    model: options.model,
    messages: toCompatibleMessages(req.messages),
    tools: toCompatibleTools(req.tools),
    temperature: req.temperature,
    top_p: req.topP,
    max_tokens: req.maxOutputTokens,
    seed: req.seed,
    stream: false,
  };
}

export function createOpenAICompatibleProvider(
  options: OpenAICompatibleProviderOptions,
): OpenAICompatibleProvider {
  const transport = options.transport ?? createSdkTransport(options);

  return {
    async complete(req) {
      try {
        return toLlmResult(await transport.complete(baseRequest(options, req)));
      } catch (error) {
        throw transportError(options.baseURL, error);
      }
    },

    async *stream(req): AsyncIterable<LlmChunk> {
      const request: ChatCompletionStreamRequest = {
        ...baseRequest(options, req),
        stream: true,
        stream_options: { include_usage: true },
      };
      let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      try {
        stream = await transport.stream(request);
      } catch (error) {
        throw transportError(options.baseURL, error);
      }

      let content = '';
      let responseId: string | undefined;
      let createdAt: number | undefined;
      let model: string | undefined;
      let status: LlmResultStatus = 'completed';
      let incompleteDetails: LlmResult['incompleteDetails'];
      let usage: OpenAI.CompletionUsage | undefined;
      const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

      try {
        for await (const chunk of stream) {
          responseId = chunk.id || responseId;
          createdAt = chunk.created || createdAt;
          model = chunk.model || model;
          usage = chunk.usage ?? usage;
          const choice = chunk.choices[0];
          if (!choice) continue;

          if (choice.delta.content) {
            content += choice.delta.content;
            yield { delta: choice.delta.content, done: false };
          }

          for (const part of choice.delta.tool_calls ?? []) {
            const accumulated = toolCallParts.get(part.index) ?? {
              id: '',
              name: '',
              arguments: '',
            };
            if (part.id) accumulated.id += part.id;
            if (part.function?.name) accumulated.name += part.function.name;
            if (part.function?.arguments) accumulated.arguments += part.function.arguments;
            toolCallParts.set(part.index, accumulated);
          }

          if (choice.finish_reason) {
            const finish = statusFromFinishReason(choice.finish_reason);
            status = finish.status;
            incompleteDetails = finish.incompleteDetails;
          }
        }
      } catch (error) {
        throw transportError(options.baseURL, error);
      }

      const toolCalls = [...toolCallParts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, toolCall]) => toolCall);
      yield {
        result: {
          content,
          toolCalls,
          done: true,
          responseId,
          status,
          ...(incompleteDetails ? { incompleteDetails } : {}),
          createdAt,
          model,
          ...toUsage(usage),
        },
        done: true,
      };
    },
  };
}
