import { useMemo, useState } from 'react';
import { useChat } from '../../store/chat.js';
import { useAuth } from '../../store/auth.js';
import { relativeTime } from '../../lib/time.js';
import ConfirmModal from '../ui/ConfirmModal.jsx';

export default function Sidebar({ open, onClose }) {
  const conversations = useChat((s) => s.conversations);
  const activeId = useChat((s) => s.activeId);
  const openConversation = useChat((s) => s.openConversation);
  const newConversation = useChat((s) => s.newConversation);
  const deleteConversation = useChat((s) => s.deleteConversation);
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const [query, setQuery] = useState('');
  const [logoutOpen, setLogoutOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title?.toLowerCase().includes(q));
  }, [conversations, query]);

  const handleNew = async () => {
    await newConversation();
    onClose?.();
  };

  const handleOpen = (id) => {
    openConversation(id);
    onClose?.();
  };

  const confirmLogout = () => {
    setLogoutOpen(false);
    logout();
  };

  const initial = user?.name?.[0]?.toUpperCase() || 'U';

  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-slate-200 bg-white/95 backdrop-blur transition-transform dark:border-slate-800 dark:bg-slate-900/95 md:static md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand header */}
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <img
              src="/logo.png"
              alt="AtozasAi"
              className="h-9 w-9 rounded-full object-cover ring-1 ring-slate-200 dark:ring-slate-700"
            />
            <span className="text-lg font-bold tracking-tight">
              Atozas<span className="bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">Ai</span>
            </span>
          </div>
          <span className="rounded-full bg-red-500 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-white shadow-sm">
            Alpha Version
          </span>
        </div>

        {/* New chat */}
        <div className="px-3 pb-2">
          <button
            onClick={handleNew}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-3 py-2.5 text-sm font-semibold text-white shadow-md shadow-violet-500/20 transition hover:from-blue-700 hover:to-violet-700"
          >
            <span className="text-lg leading-none">+</span> New chat
          </button>
        </div>

        {/* Search */}
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
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:focus:bg-slate-800"
            />
          </div>
        </div>

        {/* Recent conversations */}
        <div className="flex items-center gap-1.5 px-4 pb-1 pt-2 text-xs font-semibold text-violet-600 dark:text-violet-400">
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          Recent conversations
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-400">No conversations yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((c) => (
                <li key={c.id}>
                  <div
                    className={`group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition ${
                      activeId === c.id
                        ? 'bg-gradient-to-r from-blue-50 to-violet-50 text-slate-900 dark:from-blue-900/30 dark:to-violet-900/30 dark:text-white'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <svg
                      className={`h-4 w-4 flex-none ${
                        activeId === c.id ? 'text-violet-600 dark:text-violet-400' : 'text-slate-400'
                      }`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <button
                      onClick={() => handleOpen(c.id)}
                      className="flex-1 truncate text-left"
                      title={c.title}
                    >
                      {c.title || 'New chat'}
                    </button>
                    <span className="flex-none text-[11px] text-slate-400 group-hover:hidden">
                      {relativeTime(c.lastMessageAt || c.updatedAt || c.createdAt)}
                    </span>
                    <button
                      onClick={() => deleteConversation(c.id)}
                      className="hidden flex-none text-slate-400 hover:text-red-500 group-hover:block"
                      title="Delete conversation"
                      aria-label="Delete conversation"
                    >
                      <svg
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </nav>

        {/* User card */}
        <div className="border-t border-slate-200 p-3 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-sm font-semibold text-white">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user?.name}</p>
              <p className="truncate text-xs text-slate-400">{user?.email}</p>
            </div>
            <button
              onClick={() => setLogoutOpen(true)}
              className="flex-none rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              title="Log out"
            >
              Log out
            </button>
          </div>
        </div>
      </aside>

      <ConfirmModal
        open={logoutOpen}
        title="Log out?"
        message="You will need to sign in again to continue chatting."
        confirmLabel="Log out"
        cancelLabel="Cancel"
        danger
        onConfirm={confirmLogout}
        onCancel={() => setLogoutOpen(false)}
      />
    </>
  );
}
