import { useEffect, useState } from 'react';

/**
 * Shows a sent message's attachments: image thumbnails (click to enlarge) and
 * file chips. The text extracted from them is sent to the model but never
 * rendered here.
 */
export default function MessageAttachments({ attachments, align = 'end' }) {
  const [enlarged, setEnlarged] = useState(null);

  useEffect(() => {
    if (!enlarged) return undefined;
    const onKeyDown = (event) => event.key === 'Escape' && setEnlarged(null);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enlarged]);

  if (!attachments?.length) return null;

  const images = attachments.filter((a) => a.kind === 'image' && a.thumbnail);
  const files = attachments.filter((a) => !(a.kind === 'image' && a.thumbnail));
  const justify = align === 'end' ? 'justify-end' : 'justify-start';

  return (
    <>
      {images.length > 0 && (
        <div className={`flex flex-wrap gap-2 ${justify}`}>
          {images.map((a, i) => (
            <button
              key={`${a.name}-${i}`}
              type="button"
              onClick={() => setEnlarged(a)}
              className="block overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800"
              aria-label={`Enlarge ${a.name}`}
              title={a.name}
            >
              <img
                src={a.thumbnail}
                alt={a.name}
                className={`${images.length === 1 ? 'max-h-72 max-w-full sm:max-w-sm' : 'h-32 w-32'} object-cover`}
              />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul className={`mt-1.5 flex flex-wrap gap-2 ${justify}`}>
          {files.map((a, i) => (
            <li
              key={`${a.name}-${i}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              title={a.name}
            >
              {a.kind === 'image' ? <ImageIcon /> : <PaperclipIcon />}
              <span className="truncate">{a.name}</span>
            </li>
          ))}
        </ul>
      )}
      {enlarged && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEnlarged(null);
          }}
        >
          <button
            type="button"
            onClick={() => setEnlarged(null)}
            className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white text-2xl text-slate-800 shadow hover:bg-slate-100"
            aria-label="Close image preview"
            title="Close"
          >
            ×
          </button>
          <img
            src={enlarged.thumbnail}
            alt={enlarged.name}
            className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain shadow-2xl"
          />
        </div>
      )}
    </>
  );
}

function PaperclipIcon() {
  return (
    <svg className="h-3.5 w-3.5 flex-none text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg className="h-3.5 w-3.5 flex-none text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
  );
}
