/**
 * Source list for a grounded answer.
 *
 * Every entry here was verified server-side against the chunks actually
 * retrieved for this request — citations the model invented are stripped before
 * the message is sent, so nothing rendered below is fabricated.
 */
export default function Citations({ citations }) {
  if (!citations?.length) return null;

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/60">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Sources
      </p>
      <ol className="space-y-1.5">
        {citations.map((citation) => (
          <li key={`${citation.label}-${citation.documentId}`} className="flex gap-2 text-xs">
            <span className="mt-px flex-none rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              {citation.label}
            </span>
            <span className="min-w-0 flex-1 text-slate-600 dark:text-slate-300">
              {citation.sourceUri ? (
                <a
                  href={citation.sourceUri}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  {citation.title}
                </a>
              ) : (
                <span className="font-medium">{citation.title}</span>
              )}
              {citation.heading && (
                <span className="text-slate-500 dark:text-slate-400"> — {citation.heading}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
