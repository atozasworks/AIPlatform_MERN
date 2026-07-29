import ModelSelector from './ModelSelector.jsx';
import ThemeToggle from '../ui/ThemeToggle.jsx';

export default function ChatHeader({ onToggleSidebar }) {
  return (
    <header className="flex items-center gap-3 border-b border-slate-200 bg-white/80 px-3 py-2.5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
      <button
        onClick={onToggleSidebar}
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 md:hidden"
        aria-label="Toggle sidebar"
      >
        ☰
      </button>
      <ModelSelector />
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
