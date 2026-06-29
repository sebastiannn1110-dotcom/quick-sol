export interface ChatUser {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "manager" | "employee";
  department: string | null;
  region: string | null;
  bio?: string | null;
  job_title?: string | null;
  avatar_path?: string | null;
}

export interface ChatMember {
  id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  last_read_at: string | null;
  profile: ChatUser | null;
}

export interface ChatConversation {
  id: string;
  type: "direct" | "group" | "all_company";
  name: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  members: ChatMember[];
  latestMessage: { id: string; sender_id: string | null; body: string | null; message_type: string; created_at: string } | null;
}

export interface ChatAttachment {
  id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  body: string | null;
  message_type: "text" | "file" | "record_reference" | "upload_reference" | "system";
  metadata: Record<string, string | number | boolean | null>;
  created_at: string;
  sender: ChatUser | null;
  chat_attachments?: ChatAttachment[];
}
