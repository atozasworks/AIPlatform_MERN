import { useEffect, useState } from 'react';
import { useChat } from '../store/chat.js';
import Sidebar from '../components/chat/Sidebar.jsx';
import ChatHeader from '../components/chat/ChatHeader.jsx';
import MessageList from '../components/chat/MessageList.jsx';
import Composer from '../components/chat/Composer.jsx';

export default function ChatPage() {
  const loadConversations = useChat((s) => s.loadConversations);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        <MessageList />
        <Composer />
      </main>
    </div>
  );
}
