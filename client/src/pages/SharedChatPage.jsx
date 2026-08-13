import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import Spinner from '../components/ui/Spinner.jsx';
import ThemeToggle from '../components/ui/ThemeToggle.jsx';

export default function SharedChatPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get(`/public/shared/${token}`);
        if (cancelled) return;
        setSession(data.session);
        setMessages(data.messages || []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Shared chat not found');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex h-full flex-col bg-slate-50 dark:bg-slate-950">
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <Link to="/" className="flex items-center gap-2">
          <img
            src="/logo.png"
            alt="AtozAS AI"
            className="h-8 w-8 rounded-full object-cover ring-1 ring-slate-200 dark:ring-slate-700"
          />
          <span className="text-sm font-semibold">AtozAS AI</span>
        </Link>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800">
          Shared chat · read only
        </span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8">
          {loading ? (
            <div className="flex justify-center py-20">
              <Spinner size={28} />
            </div>
          ) : error ? (
            <div className="py-20 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              <Link to="/" className="mt-4 inline-block text-sm text-violet-600 hover:underline">
                Start your own chat
              </Link>
            </div>
          ) : (
            <>
              <h1 className="mb-6 text-xl font-semibold tracking-tight">
                {session?.title || 'Shared chat'}
              </h1>
              <div className="space-y-5">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      m.role === 'user'
                        ? 'ml-8 bg-violet-600 text-white'
                        : 'mr-8 bg-white text-slate-800 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700'
                    }`}
                  >
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">
                      {m.role === 'user' ? 'You' : 'ATOZAS AI'}
                    </p>
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  </div>
                ))}
              </div>
              <div className="mt-10 text-center">
                <Link
                  to="/"
                  className="inline-flex rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white"
                >
                  Continue in AtozAS AI
                </Link>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
