import type { SupabaseClient } from "@supabase/supabase-js";

export async function ensureConversationMember(supabase: SupabaseClient, conversationId: string, userId: string) {
  const { data, error } = await supabase
    .from("chat_conversation_members")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return { allowed: false, error };
  return { allowed: Boolean(data), error: null };
}
