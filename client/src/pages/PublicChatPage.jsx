import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ui/ThemeToggle.jsx';
import PublicComposer from '../components/public/PublicComposer.jsx';
import PublicMessageBubble from '../components/public/PublicMessageBubble.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import { usePublicChat } from '../store/publicChat.js';

export default function PublicChatPage() {
  const messages = usePublicChat((s) => s.messages);
  const loadingHistory = usePublicChat((s) => s.loadingHistory);
  const historyError = usePublicChat((s) => s.historyError);
  const loadPublicHistory = usePublicChat((s) => s.loadPublicHistory);
  const loadModels = usePublicChat((s) => s.loadModels);

  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    loadModels();
    loadPublicHistory();
  }, [loadModels, loadPublicHistory]);

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
    <div className="relative flex h-full flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -left-20 top-10 h-72 w-72 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
        <div className="absolute -right-24 top-1/3 h-80 w-80 rounded-full bg-violet-400/10 blur-3xl dark:bg-violet-500/10" />
        <div className="absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-indigo-400/10 blur-3xl dark:bg-indigo-500/10" />
      </div>

      <header className="relative z-10 flex flex-wrap items-center gap-3 border-b border-slate-200/70 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2.5">
          <img
            src="/logo.png"
            alt="AtozAS AI"
            className="h-9 w-9 rounded-full object-cover ring-1 ring-slate-200 dark:ring-slate-700"
          />
          <div>
            <p className="text-sm font-semibold tracking-tight">AtozAS AI</p>
            <p className="text-xs text-slate-500">Public chat — visible to everyone</p>
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

      <main className="relative z-10 flex min-h-0 flex-1 flex-col">
        {loadingHistory ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={28} />
          </div>
        ) : historyError && messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-sm text-red-600 dark:text-red-400">{historyError}</p>
            <button
              type="button"
              onClick={() => loadPublicHistory()}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white dark:bg-slate-100 dark:text-slate-900"
            >
              Retry
            </button>
          </div>
        ) : messages.length === 0 ? (
          <EmptyGuestState />
        ) : (
          <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
              {messages.map((m) => (
                <PublicMessageBubble key={m.id} message={m} />
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
        )}

        <PublicComposer />
      </main>
    </div>
  );
}

function EmptyGuestState() {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-8">
      <div className="w-full max-w-3xl text-center">
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
          Join the public conversation — no login required.
        </p>
        <p className="mt-1 text-sm text-slate-400">
          Messages you send here are visible to everyone using public chat.
        </p>
      </div>
    </div>
  );
}
