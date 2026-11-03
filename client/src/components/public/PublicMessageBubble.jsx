import Markdown from '../chat/Markdown.jsx';
import Citations from '../chat/Citations.jsx';

/**
 * Simplified bubble for pre-login chat — no edit / branch controls (those
 * belong to the authenticated ChatPage MessageBubble).
 */
export default function PublicMessageBubble({ message }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-br from-blue-600 to-violet-600 px-4 py-2.5 text-sm text-white shadow-sm">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start gap-3">
      <img
        src="/logo.png"
        alt=""
        className="mt-1 h-8 w-8 flex-none rounded-full object-cover ring-1 ring-slate-200 dark:ring-slate-700"
      />
      <div className="min-w-0 max-w-[85%] flex-1">
        {message.status === 'error' && !message.content ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            {message.error || 'Something went wrong generating a reply.'}
          </p>
        ) : (
          <Markdown>{message.content || (message.status === 'streaming' ? '…' : '')}</Markdown>
        )}
        {message.status === 'error' && message.content ? (
          <p className="mt-2 text-xs text-red-500">{message.error}</p>
        ) : null}
        {message.citations?.length ? <Citations citations={message.citations} /> : null}
      </div>
    </div>
  );
}
