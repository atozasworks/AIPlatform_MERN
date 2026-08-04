import { useEffect, useRef, useState } from 'react';
import { useChat } from '../../store/chat.js';

/**
 * Model selector for the chat header.
 *
 * The engine serves several models from one endpoint, so switching is just a
 * field on the next request — there is nothing to restart and no need to start
 * a new conversation. Models the engine cannot currently load are listed but
 * disabled, with the reason shown, which is more useful than hiding them and
 * leaving the user wondering where a model went.
 */

const REASON_TEXT = {
  'weights-missing': 'Not installed on this server',
  'engine-offline': 'Inference engine offline',
};

export default function ModelPicker() {
  const models = useChat((s) => s.models);
  const selectedModel = useChat((s) => s.selectedModel);
  const selectModel = useChat((s) => s.selectModel);

  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (e) => {
      if (!containerRef.current?.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Nothing to choose between until the catalogue loads.
  if (models.length < 1) return null;

  const current = models.find((m) => m.id === selectedModel);

  const choose = (model) => {
    if (!model.available) return;
    selectModel(model.id);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose the model that answers your next message"
        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <span className="truncate">{current?.label || current?.id || 'Select model'}</span>
        <svg
          className={`h-4 w-4 flex-none text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute left-0 z-30 mt-1 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl shadow-slate-300/40 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/40"
        >
          {models.map((model) => {
            const isSelected = model.id === selectedModel;
            return (
              <li key={model.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={!model.available}
                  onClick={() => choose(model)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:disabled:hover:bg-transparent"
                >
                  <span className="mt-0.5 h-4 w-4 flex-none text-violet-600 dark:text-violet-400">
                    {isSelected && (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                      {model.label || model.id}
                    </span>
                    {model.description && (
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {model.description}
                      </span>
                    )}
                    {!model.available && (
                      <span className="mt-0.5 block text-xs font-medium text-amber-600 dark:text-amber-500">
                        {REASON_TEXT[model.unavailableReason] || 'Unavailable'}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
