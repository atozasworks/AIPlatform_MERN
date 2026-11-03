import { useEffect, useRef } from 'react';
import { useChat } from '../../store/chat.js';
import MessageBubble from './MessageBubble.jsx';

export default function MessageList() {
  const messages = useChat((s) => s.messages);
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const stickToBottom = useRef(true);

  // Only auto-scroll when the user is already near the bottom, so we never
  // yank the viewport while they scroll up to read (§5 no scroll jumping).
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 120;
  };

  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  return (
    <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
