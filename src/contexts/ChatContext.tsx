import { safeLog, safeValue, errorClass } from '../../lib/logging/redact.ts';
import React, { createContext, useContext, useState, ReactNode, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ChatLogger } from '@/lib/chatLogger';
import {
  loadingTimestamps,
  shouldCommitActivity,
  type LoadingPhase,
} from '@/hooks/progressStatus';

interface DependencyGraphNode {
  id: string;
  label: string;
  version?: string;
  ecosystem: string;
  hasVulnerabilities: boolean;
  vulnerabilityCount: number;
}

interface DependencyGraphEdge {
  from: string;
  to: string;
  label: string;
  relationship: string;
}

interface DependencyGraphData {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
}

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  vulnerabilities?: any[];
  totalVulnerabilities?: number;
  dependencyGraph?: DependencyGraphData;
  useMarkdown?: boolean;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  uploadedAt: Date;
  runId?: string;
  status?: 'uploading' | 'analyzing' | 'completed' | 'error';
}

interface ChatContextType {
  messages: Message[];
  uploadedFiles: UploadedFile[];
  currentConversationId: string | null;
  sessionId: string;
  messageIndex: number;
  isLoading: boolean;
  loadingPhase: LoadingPhase | null;
  responseStartedAt: number | null;
  lastActivityAt: number | null;
  userEmail: string | null;
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => void;
  addUploadedFile: (file: UploadedFile) => void;
  setCurrentConversationId: (conversationId: string | null) => void;
  setLoading: (loading: boolean, phase?: LoadingPhase) => void;
  beginResponse: () => void;
  markActivity: () => void;
  setUserEmail: (email: string) => void;
  isolateForProviderSwitch: (conversationId: string) => void;
  clearChat: () => void;
  logChatMessage: (
    messageType: 'user' | 'assistant' | 'file_upload',
    userMessage?: string,
    aiResponse?: string,
    fileName?: string,
    fileSize?: number,
    vulnerabilityCount?: number
  ) => Promise<void>;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [sessionId] = useState<string>(() => uuidv4());
  const [messageIndex, setMessageIndex] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase | null>(null);
  const [responseStartedAt, setResponseStartedAt] = useState<number | null>(null);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const lastActivityAtRef = useRef<number | null>(null);
  const lastActivityCommittedAtRef = useRef<number | null>(null);
  const [userEmail, setUserEmailState] = useState<string | null>(null);

  // Initialize session and check for stored email on component mount
  useEffect(() => {
    const initSession = async () => {
      await ChatLogger.initializeSession(sessionId);
    };
    initSession();

    // Check for stored email in localStorage
    const storedEmail = localStorage.getItem('bombot-user-email');
    if (storedEmail) {
      setUserEmailState(storedEmail);
    }
  }, [sessionId]);

  const addMessage = (message: Omit<Message, 'id' | 'timestamp'>) => {
    const newMessage: Message = {
      ...message,
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, newMessage]);
    setMessageIndex(prev => prev + 1);
  };

  const addUploadedFile = (file: UploadedFile) => {
    setUploadedFiles(prev => [...prev, file]);
  };

  const setLoading = (loading: boolean, phase: LoadingPhase = 'response') => {
    setIsLoading(loading);
    if (loading) {
      const timestamps = loadingTimestamps(phase, Date.now());
      setLoadingPhase(phase);
      setResponseStartedAt(timestamps.responseStartedAt);
      setLastActivityAt(timestamps.lastActivityAt);
      lastActivityAtRef.current = timestamps.lastActivityAt;
      lastActivityCommittedAtRef.current = timestamps.lastActivityAt;
      return;
    }
    setLoadingPhase(null);
    setResponseStartedAt(null);
    setLastActivityAt(null);
    lastActivityAtRef.current = null;
    lastActivityCommittedAtRef.current = null;
  };

  const beginResponse = () => {
    const timestamps = loadingTimestamps('response', Date.now());
    setIsLoading(true);
    setLoadingPhase('response');
    setResponseStartedAt(timestamps.responseStartedAt);
    setLastActivityAt(timestamps.lastActivityAt);
    lastActivityAtRef.current = timestamps.lastActivityAt;
    lastActivityCommittedAtRef.current = timestamps.lastActivityAt;
  };

  const markActivity = () => {
    const now = Date.now();
    lastActivityAtRef.current = now;
    if (!shouldCommitActivity(lastActivityCommittedAtRef.current, now)) return;
    lastActivityCommittedAtRef.current = now;
    setLastActivityAt(lastActivityAtRef.current);
  };

  const setUserEmail = (email: string) => {
    setUserEmailState(email);
    // Store email in localStorage for persistence
    localStorage.setItem('bombot-user-email', email);
  };

  const clearChat = () => {
    setMessages([]);
    setUploadedFiles([]);
    setCurrentConversationId(null);
    setMessageIndex(0);
  };

  const isolateForProviderSwitch = (conversationId: string) => {
    setMessages(previous => previous.filter(message =>
      (message.type === 'user' && message.content.startsWith('📎 Uploaded:'))
      || (message.type === 'assistant' && (
        Boolean(message.dependencyGraph)
        || Boolean(message.vulnerabilities)
        || message.content.includes('**Coverage:**')
      )),
    ));
    setCurrentConversationId(conversationId);
    setMessageIndex(0);
  };

  const logChatMessage = async (
    messageType: 'user' | 'assistant' | 'file_upload',
    userMessage?: string,
    aiResponse?: string,
    fileName?: string,
    fileSize?: number,
    vulnerabilityCount?: number
  ) => {
    try {
      await ChatLogger.logMessage({
        sessionId,
        conversationId: currentConversationId,
        messageIndex,
        messageType,
        userMessage,
        aiResponse,
        fileName,
        fileSize,
        vulnerabilityCount,
        userEmail,
      });
    } catch (error) {
      safeLog('error', safeValue("Error logging chat message:"), safeValue(errorClass(error)));
    }
  };

  return (
    <ChatContext.Provider value={{
      messages,
      uploadedFiles,
      currentConversationId,
      sessionId,
      messageIndex,
      isLoading,
      loadingPhase,
      responseStartedAt,
      lastActivityAt,
      userEmail,
      addMessage,
      addUploadedFile,
      setCurrentConversationId,
      setLoading,
      beginResponse,
      markActivity,
      setUserEmail,
      isolateForProviderSwitch,
      clearChat,
      logChatMessage,
    }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};
