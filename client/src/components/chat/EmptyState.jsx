export default function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4">
      <div className="w-full max-w-2xl text-center">
        <img
          src="/logo.png"
          alt="AtozasAi"
          className="mx-auto mb-4 h-24 w-24 rounded-full object-cover shadow-sm ring-1 ring-slate-200 dark:ring-slate-700"
        />
        <h2 className="text-2xl font-semibold">How can I help today?</h2>
        <p className="mt-2 text-slate-500">Ask a question to get started.</p>
      </div>
    </div>
  );
}
