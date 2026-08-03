import { MODE, usePublicChat } from '../../store/publicChat.js';

export default function ModeToggle() {
  const mode = usePublicChat((s) => s.mode);
  const setMode = usePublicChat((s) => s.setMode);
  const isStreaming = usePublicChat((s) => s.isStreaming);

  return (
    <div
      className="inline-flex items-center rounded-full border border-slate-200 bg-white/80 p-1 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/80"
      role="group"
      aria-label="Chat mode"
    >
      <button
        type="button"
        disabled={isStreaming}
        onClick={() => setMode(MODE.PUBLIC)}
        className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
          mode === MODE.PUBLIC
            ? 'bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow'
            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
        } disabled:opacity-50`}
      >
        Public
      </button>
      <button
        type="button"
        disabled={isStreaming}
        onClick={() => setMode(MODE.PRIVATE)}
        className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
          mode === MODE.PRIVATE
            ? 'bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow'
            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
        } disabled:opacity-50`}
      >
        Private
      </button>
    </div>
  );
}
