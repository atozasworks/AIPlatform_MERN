import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePublicChat } from '../../store/publicChat.js';
import { relativeTime } from '../../lib/time.js';

export default function PublicSidebar({ open, onClose }) {
  const sessions = usePublicChat((s) => s.sessions);
  const activeId = usePublicChat((s) => s.activeId);
  const searchQuery = usePublicChat((s) => s.searchQuery);
  const setSearchQuery = usePublicChat((s) => s.setSearchQuery);
  const loadSessions = usePublicChat((s) => s.loadSessions);
  const newSession = usePublicChat((s) => s.newSession);
  const openSession = usePublicChat((s) => s.openSession);
  const deleteSession = usePublicChat((s) => s.deleteSession);
  const [localQuery, setLocalQuery] = useState(searchQuery || '');

  useEffect(() => {
    const t = setTimeout(() => {
      setSearchQuery(localQuery);
      loadSessions(localQuery);
    }, 250);
    return () => clearTimeout(t);
  }, [localQuery, setSearchQuery, loadSessions]);

  const visible = useMemo(
    () =>
      sessions.filter(
        (c) => c.id === activeId || String(c.title || '').trim() !== 'New chat',
      ),
    [sessions, activeId],
  );

  const handleNew = async () => {
    await newSession();
    onClose?.();
  };

  const handleOpen = async (id) => {
    await openSession(id);
    onClose?.();
  };

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-slate-200 bg-white/95 backdrop-blur transition-transform dark:border-slate-800 dark:bg-slate-900/95 md:static md:translate-x-0 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <img
            src="/logo.png"
            alt="AtozAS AI"
            className="h-9 w-9 rounded-full object-cover ring-1 ring-slate-200 dark:ring-slate-700"
          />
          <span className="text-lg font-bold tracking-tight">
            AtozAS
            <span className="bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
              AI
            </span>
          </span>
        </div>
        <button
          type="button"
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 md:hidden dark:hover:bg-slate-800"
          onClick={onClose}
          aria-label="Close sidebar"
        >
          ✕
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={handleNew}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-3 py-2.5 text-sm font-semibold text-white shadow-md shadow-violet-500/20 transition hover:from-blue-700 hover:to-violet-700"
        >
          <span className="text-lg leading-none">+</span> New chat
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            placeholder="Search chat history..."
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-violet-400 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:focus:bg-slate-800"
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-4 pb-1 pt-2 text-xs font-semibold text-violet-600 dark:text-violet-400">
        Your chat history
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-400">
            {localQuery.trim()
              ? 'No matching chats.'
              : 'No chats yet. Send a message to start.'}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {visible.map((c) => (
              <li key={c.id}>
                <div
                  className={`group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition ${
                    activeId === c.id
                      ? 'bg-gradient-to-r from-blue-50 to-violet-50 text-slate-900 dark:from-blue-900/30 dark:to-violet-900/30 dark:text-white'
                      : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleOpen(c.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={c.title}
                  >
                    <span className="truncate">{c.title || 'New chat'}</span>
                  </button>
                  <span className="flex-none text-[11px] text-slate-400 group-hover:hidden">
                    {relativeTime(c.lastMessageAt || c.updatedAt || c.createdAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteSession(c.id)}
                    className="hidden flex-none text-slate-400 hover:text-red-500 group-hover:block"
                    title="Delete chat"
                    aria-label="Delete chat"
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        <Link
          to="/login"
          className="flex w-full items-center justify-center rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
        >
          Sign in to save forever
        </Link>
      </div>
    </aside>
  );
}
