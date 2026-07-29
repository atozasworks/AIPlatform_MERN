import { useState } from 'react';
import Markdown from './Markdown.jsx';

/**
 * Renders a single message. User messages are shown as plain text on the right;
 * assistant messages render Markdown on the left with the model attribution and
 * copy/feedback actions (§5). A streaming caret is shown while tokens arrive.
 */
export default function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-white">
          {message.content}
        </div>
      </div>
    );
  }

  const streaming = message.status === 'streaming';
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-8 w-8 flex-none items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white dark:bg-slate-700">
        AI
      </div>
      <div className="min-w-0 flex-1">
        {message.content ? (
          <div className={streaming ? 'streaming-caret' : ''}>
            <Markdown>{message.content}</Markdown>
          </div>
        ) : (
          <div className="flex gap-1 py-2" aria-label="Assistant is typing">
            <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
          </div>
        )}

        {message.status === 'error' && (
          <p className="mt-1 text-sm text-red-500">⚠ {message.error || 'Generation failed.'}</p>
        )}

        {!streaming && message.content && (
          <div className="mt-1.5 flex items-center gap-3 text-xs text-slate-400">
            {message.model && <span>{message.model}</span>}
            <button onClick={copy} className="hover:text-slate-600 dark:hover:text-slate-200">
              {copied ? 'Copied' : 'Copy'}
            </button>
            {message.status === 'stopped' && <span className="italic">stopped</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function Dot({ delay = '0ms' }) {
  return (
    <span
      className="h-2 w-2 animate-bounce rounded-full bg-slate-400"
      style={{ animationDelay: delay }}
    />
  );
}
