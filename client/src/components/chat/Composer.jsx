import { useRef, useState } from 'react';
import { useChat } from '../../store/chat.js';
import { api } from '../../lib/api.js';
import QueueStatus from './QueueStatus.jsx';

/**
 * Broad picker list. Final acceptance is decided server-side after text
 * extraction (PDF / DOCX / Excel / text). Images are listed so the picker
 * opens freely; the API returns a clear error if they cannot be read.
 */
const ACCEPTED =
  '.pdf,.docx,.doc,.xlsx,.xls,.xlsm,.ods,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.log,.xml,.yaml,.yml,.rtf,.js,.ts,.jsx,.tsx,.py,.java,.c,.cpp,.h,.css,.sql,.ini,.conf,.env,.sh,.bat,.ps1,.go,.rs,.php,.rb,.swift,.kt,.tex';
const MAX_BYTES = 2 * 1024 * 1024; // matches RAG_MAX_UPLOAD_BYTES default

/**
 * Sticky prompt composer. Enter sends, Shift+Enter adds a newline. While a
 * response is queued or streaming, the send button becomes a Stop button that
 * cancels the job server-side (§5).
 *
 * Attach uploads via POST /rag/documents/upload (multipart). The server
 * extracts text, indexes the private RAG corpus, and returns the text so this
 * turn can ground on the file immediately.
 */
export default function Composer() {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [attachError, setAttachError] = useState(null);
  const isStreaming = useChat((s) => s.isStreaming);
  const sendMessage = useChat((s) => s.sendMessage);
  const stopStreaming = useChat((s) => s.stopStreaming);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  const uploading = attachments.some((a) => a.status === 'uploading');
  const readyAttachments = attachments.filter((a) => a.status === 'ready');

  const submit = async () => {
    const value = text.trim();
    if (isStreaming || uploading) return;
    if (!value && readyAttachments.length === 0) return;

    let content = value;
    if (readyAttachments.length) {
      const budget = 80_000;
      let used = 0;
      const blocks = [];
      for (const a of readyAttachments) {
        const remaining = budget - used;
        if (remaining < 200) break;
        const body = String(a.content || '').slice(0, remaining);
        blocks.push(`--- Attached file: ${a.title} ---\n${body}`);
        used += body.length;
      }
      const prompt = value || 'Please use the attached document(s) to answer.';
      content = `${prompt}\n\n${blocks.join('\n\n')}`;
    }

    setText('');
    setAttachments([]);
    setAttachError(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    await sendMessage(content);
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

  const openFilePicker = () => {
    if (isStreaming || uploading) return;
    setAttachError(null);
    fileInputRef.current?.click();
  };

  const onFilesSelected = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;

    for (const file of files) {
      if (file.size > MAX_BYTES) {
        setAttachError(`"${file.name}" exceeds the 2 MB upload limit.`);
        continue;
      }

      const localId = `up-${crypto.randomUUID()}`;
      setAttachments((prev) => [
        ...prev,
        { localId, title: file.name, status: 'uploading' },
      ]);

      try {
        const form = new FormData();
        form.append('file', file, file.name);
        form.append('title', file.name);

        const { document, reused, content } = await api.upload('/rag/documents/upload', form);
        if (!String(content || '').trim()) {
          throw new Error('No readable text was found in this file.');
        }

        setAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  localId,
                  title: document?.title || file.name,
                  id: document?.id,
                  status: 'ready',
                  reused: Boolean(reused),
                  content,
                }
              : a,
          ),
        );
      } catch (err) {
        setAttachments((prev) => prev.filter((a) => a.localId !== localId));
        setAttachError(err.message || `Could not attach "${file.name}".`);
      }
    }
  };

  const removeAttachment = (localId) => {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  };

  const canSend =
    !isStreaming && !uploading && (Boolean(text.trim()) || readyAttachments.length > 0);

  return (
    <div className="px-4 pb-2 pt-2">
      <QueueStatus />
      {(attachments.length > 0 || attachError) && (
        <div className="mx-auto mb-2 max-w-3xl space-y-1.5">
          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <li
                  key={a.localId}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  <PaperclipIcon className="h-3.5 w-3.5 flex-none text-violet-500" />
                  <span className="truncate">{a.title}</span>
                  {a.status === 'uploading' ? (
                    <span className="flex-none text-slate-400">Uploading…</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.localId)}
                      className="flex-none rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
                      aria-label={`Remove ${a.title}`}
                      title="Remove"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {attachError && (
            <p className="text-xs text-red-600 dark:text-red-400">{attachError}</p>
          )}
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-3xl border border-slate-200 bg-white p-2 pl-4 shadow-lg shadow-slate-200/50 transition focus-within:border-violet-400 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/20">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          className="hidden"
          onChange={onFilesSelected}
        />
        <button
          type="button"
          onClick={openFilePicker}
          disabled={isStreaming || uploading}
          title="Attach file (PDF, Word, Excel, text)"
          aria-label="Attach file"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-slate-800"
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
          placeholder="Ask me anything, I'm here to help you with answers, ideas, and more."
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
            disabled={!canSend}
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

function PaperclipIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
