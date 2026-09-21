export interface AssistantStreamMessage {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  useMarkdown?: boolean;
}

export interface AssistantStreamState<T extends AssistantStreamMessage> {
  messages: T[];
  messageIndex: number;
}

export function advanceAssistantStreamMessageIndex(messageIndex: number): number {
  return messageIndex + 1;
}

export function startAssistantStreamState<T extends AssistantStreamMessage>(
  state: AssistantStreamState<T>,
  id: string,
  timestamp: Date,
): AssistantStreamState<T> {
  const message = {
    id,
    type: 'assistant' as const,
    content: '',
    timestamp,
    useMarkdown: true,
  } as T;

  return {
    messages: [...state.messages, message],
    messageIndex: advanceAssistantStreamMessageIndex(state.messageIndex),
  };
}

export function appendAssistantStreamState<T extends AssistantStreamMessage>(
  messages: T[],
  id: string,
  delta: string,
): T[] {
  return messages.map(message => message.id === id
    ? { ...message, content: message.content + delta }
    : message);
}

export function resetAssistantStreamState<T extends AssistantStreamMessage>(
  messages: T[],
  id: string,
): T[] {
  return messages.map(message => message.id === id
    ? { ...message, content: '' }
    : message);
}

export function endAssistantStreamState<T extends AssistantStreamMessage>(
  messages: T[],
  id: string,
  finalText: string | null,
): T[] {
  const current = messages.find(message => message.id === id);
  if (!current) return messages;
  if (!current.content && !finalText) {
    return messages.filter(message => message.id !== id);
  }
  if (finalText && finalText !== current.content) {
    return messages.map(message => message.id === id
      ? { ...message, content: finalText }
      : message);
  }
  return messages;
}

export function discardAssistantStreamState<T extends AssistantStreamMessage>(
  messages: T[],
  id: string,
): T[] {
  return messages.filter(message => message.id !== id);
}
