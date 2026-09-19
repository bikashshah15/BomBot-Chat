import { useCallback, useEffect, useRef } from 'react';

export const ASSISTANT_STREAM_INACTIVITY_TIMEOUT_MS = 120_000;
export const ASSISTANT_STREAM_MAX_DURATION_MS = 1_800_000;

export type AssistantStreamTimeoutReason = 'inactivity' | 'max_duration';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

interface CreateStreamWatchdogOptions {
  inactivityMs: number;
  maxDurationMs: number;
  onExpire: (reason: AssistantStreamTimeoutReason) => void;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export function createStreamWatchdog({
  inactivityMs,
  maxDurationMs,
  onExpire,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}: CreateStreamWatchdogOptions) {
  let inactivityTimer: TimerHandle | undefined;
  let maxDurationTimer: TimerHandle | undefined;
  let stopped = false;
  let expired = false;

  const clear = (handle: TimerHandle | undefined) => {
    if (handle !== undefined) clearTimer(handle);
  };

  const expire = (reason: AssistantStreamTimeoutReason) => {
    if (stopped || expired) return;
    expired = true;
    clear(inactivityTimer);
    clear(maxDurationTimer);
    onExpire(reason);
  };

  const armInactivityTimer = () => {
    inactivityTimer = setTimer(() => expire('inactivity'), inactivityMs);
  };

  armInactivityTimer();
  maxDurationTimer = setTimer(() => expire('max_duration'), maxDurationMs);

  return {
    touch() {
      if (stopped || expired) return;
      clear(inactivityTimer);
      armInactivityTimer();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clear(inactivityTimer);
      clear(maxDurationTimer);
    },
  };
}

export class AssistantStreamTimeoutError extends Error {
  reason: AssistantStreamTimeoutReason;

  constructor(reason: AssistantStreamTimeoutReason) {
    super(`Assistant response timed out due to ${reason === 'inactivity' ? 'inactivity' : 'maximum duration'}`);
    this.name = 'AssistantStreamTimeoutError';
    this.reason = reason;
  }
}

export interface StartAssistantStreamOptions {
  conversationId: string;
  sessionId: string;
  messageIndex?: number;
  onDone: (response: string) => void;
  onActivity?: () => void;
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

  const handleFrame = (frame: string) => {
    if (!frame) return;
    options.onActivity?.();
    handleEvent(parseEvent(frame));
  };

  while (!completed) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    const frames = pending.split('\n\n');
    pending = frames.pop() ?? '';
    for (const frame of frames) handleFrame(frame);
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
    let timeoutReason: AssistantStreamTimeoutReason | null = null;
    let watchdog: ReturnType<typeof createStreamWatchdog> | null = null;

    try {
      const search = new URLSearchParams({
        conversationId: options.conversationId,
        sessionId: options.sessionId,
      });
      if (options.messageIndex !== undefined) {
        search.set('messageIndex', String(options.messageIndex));
      }

      watchdog = createStreamWatchdog({
        inactivityMs: ASSISTANT_STREAM_INACTIVITY_TIMEOUT_MS,
        maxDurationMs: ASSISTANT_STREAM_MAX_DURATION_MS,
        onExpire(reason) {
          timeoutReason = reason;
          controller.abort();
        },
      });
      const response = await fetch(`/api/stream?${search.toString()}`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(error.error || 'Failed to start assistant stream');
      }
      await consumeAssistantEventStream(response, {
        ...options,
        onActivity() {
          watchdog?.touch();
          options.onActivity?.();
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AssistantStreamTimeoutError(timeoutReason ?? 'inactivity');
      }
      throw error;
    } finally {
      watchdog?.stop();
      if (activeController.current === controller) activeController.current = null;
    }
  }, []);

  return { startStream };
}
