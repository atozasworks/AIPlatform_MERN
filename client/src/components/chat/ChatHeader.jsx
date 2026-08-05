import ThemeToggle from '../ui/ThemeToggle.jsx';
import { useAuth } from '../../store/auth.js';
import { useChat } from '../../store/chat.js';

/**
 * Chat header.
 *
 * The underlying model id/label is intentionally not shown to end users —
 * only the product name. The live-web badge remains, because it changes how
 * much to trust a time-sensitive answer.
 */
export default function ChatHeader({ onToggleSidebar }) {
  const user = useAuth((s) => s.user);
  const webRetrieval = useChat((s) => s.webRetrieval);
  const initial = user?.name?.[0]?.toUpperCase() || 'U';

  return (
    <header className="flex items-center gap-3 px-4 py-3">
      <button
        onClick={onToggleSidebar}
        className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800 md:hidden"
        aria-label="Toggle sidebar"
      >
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
          ATOZAS AI
        </span>
        {webRetrieval?.available && (
          <span
            title="Time-sensitive questions are answered from freshly retrieved web sources, with citations and retrieval dates."
            className="flex-none rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:ring-emerald-900"
          >
            Live web
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <ThemeToggle />
        <div
          className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-sm font-semibold text-white"
          title={user?.name}
        >
          {initial}
        </div>
      </div>
    </header>
  );
}
