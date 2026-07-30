export default function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4">
      <div className="w-full max-w-2xl text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-3xl font-bold text-white">
          A
        </div>
        <h2 className="text-2xl font-semibold">How can I help today?</h2>
        <p className="mt-2 text-slate-500">Ask a question to get started.</p>
      </div>
    </div>
  );
}
