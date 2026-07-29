import { useChat } from '../../store/chat.js';

const SUGGESTIONS = [
  'Explain quantum computing in simple terms',
  'Write a professional email requesting a meeting',
  'Debug this JavaScript function for me',
  'Summarize the key points of a long article',
];

export default function EmptyState() {
  const sendMessage = useChat((s) => s.sendMessage);

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4">
      <div className="w-full max-w-2xl text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-3xl font-bold text-white">
          A
        </div>
        <h2 className="text-2xl font-semibold">How can I help today?</h2>
        <p className="mt-2 text-slate-500">
          Ask a question, or try one of these to get started.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => sendMessage(s)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm transition hover:border-brand-400 hover:bg-brand-50/50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-brand-500 dark:hover:bg-slate-800"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
