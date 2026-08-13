import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ui/ThemeToggle.jsx';
import PublicComposer from '../components/public/PublicComposer.jsx';
import PublicMessageBubble from '../components/public/PublicMessageBubble.jsx';
import PublicSidebar from '../components/public/PublicSidebar.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import { usePublicChat } from '../store/publicChat.js';

export default function PublicChatPage() {
  const messages = usePublicChat((s) => s.messages);
  const loadingHistory = usePublicChat((s) => s.loadingHistory);
  const historyError = usePublicChat((s) => s.historyError);
  const loadSessions = usePublicChat((s) => s.loadSessions);
  const loadModels = usePublicChat((s) => s.loadModels);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const stickToBottom = useRef(true);
  const isNewChat = messages.length === 0;

  useEffect(() => {
    loadModels();
    loadSessions();
  }, [loadModels, loadSessions]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 120;
  };

  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  return (
    <div className="relative flex h-full overflow-hidden bg-slate-50 dark:bg-slate-950">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -left-20 top-10 h-72 w-72 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
        <div className="absolute -right-24 top-1/3 h-80 w-80 rounded-full bg-violet-400/10 blur-3xl dark:bg-violet-500/10" />
        <div className="absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-indigo-400/10 blur-3xl dark:bg-indigo-500/10" />
      </div>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <PublicSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-200/70 px-4 py-3 dark:border-slate-800">
          <button
            type="button"
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 md:hidden dark:text-slate-300 dark:hover:bg-slate-800"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open chat history"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          <div className="flex items-center gap-2.5">
            <img
              src="/logo.png"
              alt="AtozAS AI"
              className="h-9 w-9 rounded-full object-cover ring-1 ring-slate-200 dark:ring-slate-700"
            />
            <div>
              <p className="text-sm font-semibold tracking-tight">AtozAS AI</p>
              <p className="text-xs text-slate-500">Guest chat — private to this browser</p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Link
              to="/login"
              className="rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:from-blue-700 hover:to-violet-700"
            >
              Sign in
            </Link>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          {loadingHistory && messages.length === 0 && !historyError ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner size={28} />
            </div>
          ) : historyError && messages.length === 0 && !isNewChat ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{historyError}</p>
              <button
                type="button"
                onClick={() => loadSessions()}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white dark:bg-slate-100 dark:text-slate-900"
              >
                Retry
              </button>
            </div>
          ) : isNewChat ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-2 py-6">
              <EmptyGuestState />
              <div className="w-full max-w-3xl">
                <PublicComposer />
              </div>
            </div>
          ) : (
            <>
              <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
                  {messages.map((m) => (
                    <PublicMessageBubble key={m.id} message={m} />
                  ))}
                  <div ref={bottomRef} />
                </div>
              </div>
              <PublicComposer />
            </>
          )}

          <p className="sticky bottom-0 z-20 shrink-0 bg-slate-50/95 px-4 py-2 text-center text-xs text-slate-400 backdrop-blur dark:bg-slate-950/95">
            ATOZAS AI runs on ATOZAS servers. It can make mistakes — verify important
            information.
          </p>
        </main>
      </div>
    </div>
  );
}

function EmptyGuestState() {
  return (
    <div className="w-full max-w-3xl px-4 pb-6 text-center">
      <img
        src="/logo.png"
        alt="AtozAS AI"
        className="mx-auto mb-5 h-20 w-20 rounded-full object-cover shadow-sm ring-1 ring-slate-200 dark:ring-slate-700"
      />
      <h1 className="text-3xl font-bold tracking-tight">
        <span className="bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
          AtozAS AI
        </span>
      </h1>
      <p className="mt-3 text-lg font-medium text-slate-600 dark:text-slate-300">
        How can I help you today?
      </p>
      <p className="mt-1 text-sm text-slate-400">
        No login needed. Your chats stay in this browser — other visitors cannot see or continue them.
      </p>
    </div>
  );
}
