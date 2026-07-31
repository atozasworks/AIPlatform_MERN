import { useRef, useState } from 'react';
import { useChat } from '../../store/chat.js';

/**
 * Sticky prompt composer. Enter sends, Shift+Enter adds a newline. While a
 * response streams, the send button becomes a Stop button (§5).
 */
export default function Composer() {
  const [text, setText] = useState('');
  const isStreaming = useChat((s) => s.isStreaming);
  const sendMessage = useChat((s) => s.sendMessage);
  const stopStreaming = useChat((s) => s.stopStreaming);
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
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-3xl border border-slate-200 bg-white p-2 pl-4 shadow-lg shadow-slate-200/50 transition focus-within:border-violet-400 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/20">
        <button
          type="button"
          title="Attach file"
          aria-label="Attach file"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
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
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={onInput}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Message AiChat…"
          className="max-h-52 flex-1 resize-none self-center bg-transparent py-2 outline-none"
        />
        <button
          type="button"
          title="Emoji"
          aria-label="Emoji"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
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
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>
        </button>
        {isStreaming ? (
          <button
            onClick={stopStreaming}
            className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-slate-800 text-white transition hover:bg-slate-700"
            title="Stop generating"
            aria-label="Stop generating"
          >
            <span className="block h-3 w-3 rounded-sm bg-white" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
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
      <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-slate-400">
        AiChat can make mistakes. Verify important information.
      </p>
    </div>
  );
}
