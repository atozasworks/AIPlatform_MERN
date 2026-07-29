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
    <div className="border-t border-slate-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-slate-300 bg-white p-2 shadow-sm focus-within:border-brand-500 dark:border-slate-700 dark:bg-slate-900">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={onInput}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Message AiChat…"
          className="max-h-52 flex-1 resize-none bg-transparent px-2 py-1.5 outline-none"
        />
        {isStreaming ? (
          <button
            onClick={stopStreaming}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-slate-800 text-white transition hover:bg-slate-700"
            title="Stop generating"
            aria-label="Stop generating"
          >
            ■
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-40"
            title="Send message"
            aria-label="Send message"
          >
            ↑
          </button>
        )}
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-slate-400">
        AiChat can make mistakes. Verify important information.
      </p>
    </div>
  );
}
