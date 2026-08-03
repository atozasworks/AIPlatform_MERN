import { useEffect, useState } from 'react';
import { useChat } from '../store/chat.js';
import Sidebar from '../components/chat/Sidebar.jsx';
import ChatHeader from '../components/chat/ChatHeader.jsx';
import MessageList from '../components/chat/MessageList.jsx';
import Composer from '../components/chat/Composer.jsx';

export default function ChatPage() {
  const loadConversations = useChat((s) => s.loadConversations);
  const loadModels = useChat((s) => s.loadModels);
  const activeId = useChat((s) => s.activeId);
  const resumeActiveGeneration = useChat((s) => s.resumeActiveGeneration);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    loadConversations();
    loadModels();
  }, [loadConversations, loadModels]);

  // A generation keeps running on the server across a refresh; re-attach to it
  // so the user sees the rest of the answer instead of a frozen bubble.
  useEffect(() => {
    if (activeId) resumeActiveGeneration(activeId);
  }, [activeId, resumeActiveGeneration]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main className="relative flex min-w-0 flex-1 flex-col bg-slate-50 dark:bg-slate-950">
        {/* Decorative background blobs */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
          <div className="absolute -left-20 top-10 h-72 w-72 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
          <div className="absolute -right-24 top-1/3 h-80 w-80 rounded-full bg-violet-400/10 blur-3xl dark:bg-violet-500/10" />
          <div className="absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-indigo-400/10 blur-3xl dark:bg-indigo-500/10" />
        </div>

        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <ChatHeader onToggleSidebar={() => setSidebarOpen((v) => !v)} />
          <MessageList />
          <Composer />
        </div>
      </main>
    </div>
  );
}
