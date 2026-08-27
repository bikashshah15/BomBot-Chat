import { useCallback, useEffect, useRef } from 'react';

export const ASSISTANT_STREAM_TIMEOUT_MS = 180_000;

export class AssistantStreamTimeoutError extends Error {
  constructor() {
    super('Assistant response timed out after 3 minutes');
    this.name = 'AssistantStreamTimeoutError';
  }
}

export interface StartAssistantStreamOptions {
  conversationId: string;
  sessionId: string;
  messageIndex?: number;
  onDone: (response: string) => void;
  onToolStart?: (round: number) => void;
  onToolEnd?: (round: number) => void;
}

interface ParsedEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseEvent(frame: string): ParsedEvent | null {
  if (!frame || frame.startsWith(':')) return null;
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;

  return {
    event,
    data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
  };
}

export async function consumeAssistantEventStream(
  response: Response,
  options: StartAssistantStreamOptions,
): Promise<void> {
  if (!response.body) throw new Error('Assistant stream returned no response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let bufferedResponse = '';
  let completed = false;

  const handleEvent = (parsed: ParsedEvent | null) => {
    if (!parsed) return;
    if (parsed.event === 'delta' && typeof parsed.data.delta === 'string') {
      bufferedResponse += parsed.data.delta;
      return;
    }
    if (parsed.event === 'tool_start') {
      // Match the previous presentation: only the final post-tool response is rendered.
      bufferedResponse = '';
      if (typeof parsed.data.round === 'number') options.onToolStart?.(parsed.data.round);
      return;
    }
    if (parsed.event === 'tool_end') {
      if (typeof parsed.data.round === 'number') options.onToolEnd?.(parsed.data.round);
      return;
    }
    if (parsed.event === 'error') {
      throw new Error(
        typeof parsed.data.error === 'string'
          ? parsed.data.error
          : 'Assistant stream failed',
      );
    }
    if (parsed.event === 'done') {
      completed = true;
      const responseText = bufferedResponse
        || (typeof parsed.data.response === 'string' ? parsed.data.response : '');
      options.onDone(responseText);
    }
  };

  while (!completed) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    const frames = pending.split('\n\n');
    pending = frames.pop() ?? '';
    for (const frame of frames) handleEvent(parseEvent(frame));
    if (done) break;
  }

  if (!completed && pending) handleEvent(parseEvent(pending));
  if (!completed) throw new Error('Assistant stream ended before completion');
}

export function useAssistantStream() {
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => () => activeController.current?.abort(), []);

  const startStream = useCallback(async (options: StartAssistantStreamOptions) => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), ASSISTANT_STREAM_TIMEOUT_MS);

    try {
      const search = new URLSearchParams({
        conversationId: options.conversationId,
        sessionId: options.sessionId,
      });
      if (options.messageIndex !== undefined) {
        search.set('messageIndex', String(options.messageIndex));
      }

      const response = await fetch(`/api/stream?${search.toString()}`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(error.error || 'Failed to start assistant stream');
      }
      await consumeAssistantEventStream(response, options);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AssistantStreamTimeoutError();
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
      if (activeController.current === controller) activeController.current = null;
    }
  }, []);

  return { startStream };
}
