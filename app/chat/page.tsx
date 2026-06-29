import { Suspense } from "react";
import ChatLayout from "@/components/chat/ChatLayout";

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Cargando chat...</div>}>
      <ChatLayout />
    </Suspense>
  );
}
