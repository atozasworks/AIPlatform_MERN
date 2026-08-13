import { useEffect, useMemo, useState } from 'react';
import { useChat } from '../store/chat.js';
import { useAuth } from '../store/auth.js';
import Sidebar from '../components/chat/Sidebar.jsx';
import ChatHeader from '../components/chat/ChatHeader.jsx';
import MessageList from '../components/chat/MessageList.jsx';
import Composer from '../components/chat/Composer.jsx';
import EmptyState from '../components/chat/EmptyState.jsx';
import { isFirstTimeUser, markWelcomeSeen } from '../lib/promptSuggestions.js';

export default function ChatPage() {
  const loadConversations = useChat((s) => s.loadConversations);
  const loadModels = useChat((s) => s.loadModels);
  const activeId = useChat((s) => s.activeId);
  const messages = useChat((s) => s.messages);
  const conversations = useChat((s) => s.conversations);
  const user = useAuth((s) => s.user);
  const resumeActiveGeneration = useChat((s) => s.resumeActiveGeneration);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isNewChat = messages.length === 0;
  const userId = user?.id || user?._id;

  const firstTime = useMemo(
    () => isFirstTimeUser(userId, conversations),
    [userId, conversations],
  );

  useEffect(() => {
    loadConversations();
    loadModels();
  }, [loadConversations, loadModels]);

  // A generation keeps running on the server across a refresh; re-attach to it
  // so the user sees the rest of the answer instead of a frozen bubble.
  useEffect(() => {
    if (activeId) resumeActiveGeneration(activeId);
  }, [activeId, resumeActiveGeneration]);

  // First message leaves the welcome state permanently for this account.
  useEffect(() => {
    if (userId && messages.length > 0) markWelcomeSeen(userId);
  }, [userId, messages.length]);

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
          {isNewChat ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-2 py-6">
              <EmptyState
                key={activeId || 'new'}
                variant={firstTime ? 'first' : 'returning'}
              />
              <div className="w-full max-w-3xl">
                <Composer />
              </div>
            </div>
          ) : (
            <>
              <MessageList />
              <Composer />
            </>
          )}
          <p className="sticky bottom-0 z-20 shrink-0 bg-slate-50/95 px-4 py-2 text-center text-xs text-slate-400 backdrop-blur dark:bg-slate-950/95">
            ATOZAS AI runs on ATOZAS servers. It can make mistakes — verify important
            information.
          </p>
        </div>
      </main>
    </div>
  );
}
