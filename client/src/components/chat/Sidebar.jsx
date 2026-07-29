import { useMemo, useState } from 'react';
import { useChat } from '../../store/chat.js';
import { useAuth } from '../../store/auth.js';

export default function Sidebar({ open, onClose }) {
  const conversations = useChat((s) => s.conversations);
  const activeId = useChat((s) => s.activeId);
  const openConversation = useChat((s) => s.openConversation);
  const newConversation = useChat((s) => s.newConversation);
  const deleteConversation = useChat((s) => s.deleteConversation);
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const [query, setQuery] = useState('');

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

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-900 md:static md:translate-x-0 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex items-center gap-2 p-3">
        <button
          onClick={handleNew}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
        >
          <span className="text-lg leading-none">+</span> New chat
        </button>
      </div>

      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-800"
        />
      </div>

      <nav className="flex-1 overflow-y-auto px-2">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-400">No conversations yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((c) => (
              <li key={c.id}>
                <div
                  className={`group flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                    activeId === c.id
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-200'
                      : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <button
                    onClick={() => handleOpen(c.id)}
                    className="flex-1 truncate text-left"
                    title={c.title}
                  >
                    {c.title || 'New chat'}
                  </button>
                  <button
                    onClick={() => deleteConversation(c.id)}
                    className="hidden text-slate-400 hover:text-red-500 group-hover:block"
                    title="Delete conversation"
                    aria-label="Delete conversation"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
            {user?.name?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user?.name}</p>
            <p className="truncate text-xs text-slate-400">{user?.email}</p>
          </div>
          <button
            onClick={logout}
            className="text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            title="Log out"
          >
            Log out
          </button>
        </div>
      </div>
    </aside>
  );
}
