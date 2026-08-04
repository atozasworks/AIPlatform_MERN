import ThemeToggle from '../ui/ThemeToggle.jsx';
import ModelPicker from './ModelPicker.jsx';
import { useAuth } from '../../store/auth.js';

export default function ChatHeader({ onToggleSidebar }) {
  const user = useAuth((s) => s.user);
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
      <ModelPicker />
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
