import { create } from 'zustand';
import { api } from '../lib/api.js';
import { streamChat } from '../lib/stream.js';

/**
 * Chat state: conversation list, the active conversation's messages, and the
 * streaming lifecycle. Streaming appends tokens to the last assistant message
 * in place to avoid re-rendering the whole list (§5 smooth streaming).
 */
export const useChat = create((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  models: [],
  selectedProvider: 'auto',
  selectedModel: '',
  isStreaming: false,
  _stream: null,

  async loadModels() {
    try {
      const { models } = await api.get('/ai/models');
      set({ models });
    } catch {
      set({ models: [] });
    }
  },

  async loadConversations() {
    const { conversations } = await api.get('/conversations?limit=50');
    set({ conversations });
  },

  async newConversation() {
    const { conversation } = await api.post('/conversations', {
      provider: get().selectedProvider,
      model: get().selectedModel || undefined,
    });
    set((s) => ({
      conversations: [conversation, ...s.conversations],
      activeId: conversation.id,
      messages: [],
    }));
    return conversation;
  },

  async openConversation(id) {
    set({ activeId: id, messages: [] });
    const { messages } = await api.get(`/conversations/${id}/messages`);
    if (get().activeId === id) set({ messages });
  },

  async deleteConversation(id) {
    await api.delete(`/conversations/${id}`);
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      ...(s.activeId === id ? { activeId: null, messages: [] } : {}),
    }));
  },

  setProvider(provider, model) {
    set({ selectedProvider: provider, selectedModel: model || '' });
  },

  stopStreaming() {
    get()._stream?.cancel();
  },

  async sendMessage(text) {
    let activeId = get().activeId;
    if (!activeId) {
      const convo = await get().newConversation();
      activeId = convo.id;
    }

    const clientMessageId = crypto.randomUUID();
    const userMsg = {
      id: `tmp-user-${clientMessageId}`,
      role: 'user',
      content: text,
      status: 'complete',
    };
    const assistantMsg = {
      id: `tmp-assistant-${clientMessageId}`,
      role: 'assistant',
      content: '',
      status: 'streaming',
      provider: null,
      model: null,
    };
    set((s) => ({ messages: [...s.messages, userMsg, assistantMsg], isStreaming: true }));

    const patchAssistant = (patch) =>
      set((s) => ({
        messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, ...patch } : m)),
      }));

    const stream = streamChat(
      activeId,
      {
        content: text,
        provider: get().selectedProvider,
        model: get().selectedModel || undefined,
        clientMessageId,
      },
      {
        onMeta: (meta) =>
          patchAssistant({ provider: meta.provider, model: meta.model, id: assistantMsg.id }),
        onToken: (t) =>
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id ? { ...m, content: m.content + t } : m,
            ),
          })),
        onTitle: (title) =>
          set((s) => ({
            conversations: s.conversations.map((c) =>
              c.id === activeId ? { ...c, title } : c,
            ),
          })),
        onDone: () => {
          patchAssistant({ status: 'complete' });
          set({ isStreaming: false, _stream: null });
        },
        onCancel: () => {
          patchAssistant({ status: 'stopped' });
          set({ isStreaming: false, _stream: null });
        },
        onError: (err) => {
          patchAssistant({ status: 'error', content: get().messages.find((m) => m.id === assistantMsg.id)?.content || '', error: err.message });
          set({ isStreaming: false, _stream: null });
        },
      },
    );
    set({ _stream: stream });
  },
}));

export default useChat;
