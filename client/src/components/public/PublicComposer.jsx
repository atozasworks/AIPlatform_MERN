import { useRef, useState } from 'react';
import { usePublicChat, PHASE } from '../../store/publicChat.js';

export default function PublicComposer() {
  const [text, setText] = useState('');
  const isStreaming = usePublicChat((s) => s.isStreaming);
  const generation = usePublicChat((s) => s.generation);
  const sendMessage = usePublicChat((s) => s.sendMessage);
  const stopStreaming = usePublicChat((s) => s.stopStreaming);
  const textareaRef = useRef(null);

  const submit = async () => {
    const value = text.trim();
    if (!value || isStreaming) return;
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    await sendMessage(value);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onInput = (e) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="px-4 pb-4 pt-2">
      {generation.phase === PHASE.QUEUED && generation.position > 0 ? (
        <p className="mx-auto mb-2 max-w-3xl text-center text-xs text-slate-500">
          In queue — position {generation.position}
          {generation.queueDepth ? ` of ${generation.queueDepth}` : ''}
        </p>
      ) : null}
      {generation.notice ? (
        <p className="mx-auto mb-2 max-w-3xl text-center text-xs text-amber-600 dark:text-amber-400">
          {generation.notice}
        </p>
      ) : null}
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-3xl border border-slate-200 bg-white p-2 pl-4 shadow-lg shadow-slate-200/50 transition focus-within:border-violet-400 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/20">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={onInput}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Ask anything....."
          className="max-h-52 flex-1 resize-none self-center bg-transparent py-2 outline-none"
        />
        {isStreaming ? (
          <button
            onClick={stopStreaming}
            className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-slate-800 text-white transition hover:bg-slate-700"
            title="Stop generating"
            aria-label="Stop generating"
            type="button"
          >
            <span className="block h-3 w-3 rounded-sm bg-white" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            type="button"
            className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-md shadow-violet-500/30 transition hover:from-blue-700 hover:to-violet-700 disabled:opacity-40 disabled:shadow-none"
            title="Send message"
            aria-label="Send message"
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
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
