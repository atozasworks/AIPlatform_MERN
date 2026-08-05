/**
 * Source list for a grounded answer.
 *
 * Every entry here was verified server-side against the sources actually
 * retrieved for this request — citations the model invented are stripped before
 * the message is sent, so nothing rendered below is fabricated.
 *
 * Live web sources show two dates, and the distinction matters: "published" is
 * what the page claims about itself, "retrieved" is when ATOZAS read it. Only
 * the second is something ATOZAS can vouch for, and it is the one that tells a
 * reader whether a fast-moving answer is worth re-checking.
 */

const WEB_TYPE = 'web';

/** Absolute date, because "2 days ago" on a stored message drifts as it ages. */
function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function Citations({ citations }) {
  if (!citations?.length) return null;

  const hasLive = citations.some((c) => c.sourceType === WEB_TYPE);

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/60">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {hasLive ? 'Sources (includes live web)' : 'Sources'}
      </p>
      <ol className="space-y-1.5">
        {citations.map((citation) => {
          const isLive = citation.sourceType === WEB_TYPE;
          const published = formatDate(citation.publishedAt);
          const retrieved = formatDateTime(citation.retrievedAt);

          return (
            <li
              key={`${citation.label}-${citation.documentId || citation.sourceUri}`}
              className="flex gap-2 text-xs"
            >
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

                {isLive && (
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    {citation.siteName && <span>{citation.siteName}</span>}
                    {published && <span>Published {published}</span>}
                    {retrieved && <span>Retrieved {retrieved}</span>}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
