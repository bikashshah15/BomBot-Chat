export interface ChatLog {
  id: string;
  session_id: string;
  conversation_id: string | null;
  message_index: number;
  message_type: 'user' | 'assistant' | 'file_upload';
  user_message: string | null;
  ai_response: string | null;
  file_name: string | null;
  file_size: number | null;
  vulnerability_count: number | null;
  user_email: string | null;
  session_started_at: string;
  session_last_activity: string;
  created_at: string;
  updated_at: string;
}

export interface SessionAnalytics {
  session_id: string;
  user_email: string | null;
  session_started_at: string;
  session_last_activity: string;
  total_messages: number;
  user_messages: number;
  assistant_messages: number;
  file_uploads: number;
  total_vulnerabilities_found: number;
  session_duration_minutes: number;
  last_message_at: string;
}

export type NewChatLog = Pick<
  ChatLog,
  | 'id'
  | 'session_id'
  | 'conversation_id'
  | 'message_index'
  | 'message_type'
  | 'user_message'
  | 'ai_response'
  | 'file_name'
  | 'file_size'
  | 'vulnerability_count'
  | 'user_email'
  | 'created_at'
  | 'updated_at'
>;
