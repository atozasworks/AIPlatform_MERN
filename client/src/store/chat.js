import { create } from 'zustand';
import { api } from '../lib/api.js';
import { streamChat } from '../lib/stream.js';
import { buildDisplayPath, parentKey } from '../lib/messageTree.js';

/**
 * Chat state: full message tree + branch choices. `messages` is the linearized
 * active path used by the UI (ChatGPT-style version switching).
 */
export const useChat = create((set, get) => ({
  conversations: [],
  activeId: null,
  allMessages: [],
  branchChoices: {},
  messages: [],
  models: [],
  selectedProvider: 'auto',
  selectedModel: '',
  isStreaming: false,
  _stream: null,

  _syncPath(allMessages, branchChoices) {
    const messages = buildDisplayPath(allMessages, branchChoices);
    set({ allMessages, branchChoices, messages });
  },

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
      allMessages: [],
      branchChoices: {},
      messages: [],
    }));
    return conversation;
  },

  async openConversation(id) {
    set({ activeId: id, allMessages: [], branchChoices: {}, messages: [] });
    const { messages } = await api.get(`/conversations/${id}/messages`);
    if (get().activeId === id) get()._syncPath(messages, {});
  },

  async deleteConversation(id) {
    await api.delete(`/conversations/${id}`);
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      ...(s.activeId === id
        ? { activeId: null, allMessages: [], branchChoices: {}, messages: [] }
        : {}),
    }));
  },

  setProvider(provider, model) {
    set({ selectedProvider: provider, selectedModel: model || '' });
  },

  stopStreaming() {
    get()._stream?.cancel();
  },

  /** Switch to another edit version of a user prompt (`< 1/2 >`). */
  selectVersion(messageId, direction) {
    const { allMessages, branchChoices } = get();
    const msg = allMessages.find((m) => m.id === messageId);
    if (!msg || msg.role !== 'user') return;

    const key = parentKey(msg.parentMessage);
    const siblings = allMessages
      .filter((m) => m.role === 'user' && parentKey(m.parentMessage) === key)
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

    const idx = siblings.findIndex((s) => s.id === messageId);
    if (idx < 0) return;

    const next = idx + direction;
    if (next < 0 || next >= siblings.length) return;

    const nextChoices = { ...branchChoices, [key]: siblings[next].id };
    const path = buildDisplayPath(allMessages, nextChoices);
    const keep = new Set(['root']);
    for (const m of path) {
      if (m.role === 'assistant') keep.add(String(m.id));
      if (m.role === 'user') keep.add(parentKey(m.parentMessage));
    }
    const pruned = Object.fromEntries(
      Object.entries(nextChoices).filter(([k]) => keep.has(k)),
    );
    get()._syncPath(allMessages, pruned);
  },

  /**
   * Create a sibling branch with the edited prompt (keeps old versions) and
   * stream a fresh assistant reply — ChatGPT-style edit.
   */
  async editMessage(messageId, content) {
    const text = content.trim();
    if (!text || get().isStreaming) return;

    const activeId = get().activeId;
    if (!activeId) return;

    const { parentMessageId } = await api.post(
      `/conversations/${activeId}/messages/${messageId}/edit`,
      { content: text },
    );

    await get().sendMessage(text, { parentMessageId: parentMessageId ?? null });
  },

  async sendMessage(text, { parentMessageId } = {}) {
    let activeId = get().activeId;
    if (!activeId) {
      const convo = await get().newConversation();
      activeId = convo.id;
    }

    const clientMessageId = crypto.randomUUID();
    let userId = `tmp-user-${clientMessageId}`;
    let assistantId = `tmp-assistant-${clientMessageId}`;

    // Resolve parent for optimistic UI when continuing (not editing).
    let resolvedParent = parentMessageId;
    if (resolvedParent === undefined) {
      const path = get().messages;
      const last = path[path.length - 1];
      resolvedParent = last ? last.id : null;
    }

    const userMsg = {
      id: userId,
      role: 'user',
      content: text,
      status: 'complete',
      parentMessage: resolvedParent,
      createdAt: new Date().toISOString(),
    };
    const assistantMsg = {
      id: assistantId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      provider: null,
      model: null,
      parentMessage: userId,
      createdAt: new Date().toISOString(),
    };

    const allMessages = [...get().allMessages, userMsg, assistantMsg];
    const key = parentKey(resolvedParent);
    const branchChoices = { ...get().branchChoices, [key]: userId };
    get()._syncPath(allMessages, branchChoices);
    set({ isStreaming: true });

    const patchById = (id, patch) => {
      const next = get().allMessages.map((m) => (m.id === id ? { ...m, ...patch } : m));
      get()._syncPath(next, get().branchChoices);
    };

    const renameId = (prevId, nextId, extra = {}) => {
      const choices = { ...get().branchChoices };
      for (const [k, v] of Object.entries(choices)) {
        if (v === prevId) choices[k] = nextId;
      }
      const next = get().allMessages.map((m) => {
        if (m.id === prevId) return { ...m, id: nextId, ...extra };
        if (m.parentMessage === prevId) return { ...m, parentMessage: nextId };
        return m;
      });
      get()._syncPath(next, choices);
    };

    const stream = streamChat(
      activeId,
      {
        content: text,
        provider: get().selectedProvider,
        model: get().selectedModel || undefined,
        clientMessageId,
        // Always send explicitly so edit siblings land on the right parent.
        parentMessageId: resolvedParent,
      },
      {
        onMeta: (meta) => {
          const prevUserId = userId;
          const prevAssistantId = assistantId;
          if (meta.userMessageId) userId = meta.userMessageId;
          if (meta.assistantMessageId) assistantId = meta.assistantMessageId;

          if (prevUserId !== userId) {
            renameId(prevUserId, userId, {
              parentMessage: meta.parentMessageId ?? resolvedParent,
            });
          }
          if (prevAssistantId !== assistantId) {
            renameId(prevAssistantId, assistantId, {
              provider: meta.provider,
              model: meta.model,
              parentMessage: userId,
            });
          } else {
            patchById(assistantId, { provider: meta.provider, model: meta.model });
          }
        },
        onToken: (t) => {
          const next = get().allMessages.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + t } : m,
          );
          get()._syncPath(next, get().branchChoices);
        },
        onTitle: (title) =>
          set((s) => ({
            conversations: s.conversations.map((c) =>
              c.id === activeId ? { ...c, title } : c,
            ),
          })),
        onDone: () => {
          patchById(assistantId, { status: 'complete' });
          set({ isStreaming: false, _stream: null });
        },
        onCancel: () => {
          patchById(assistantId, { status: 'stopped' });
          set({ isStreaming: false, _stream: null });
        },
        onError: (err) => {
          const current = get().allMessages.find((m) => m.id === assistantId);
          patchById(assistantId, {
            status: 'error',
            content: current?.content || '',
            error: err.message,
          });
          set({ isStreaming: false, _stream: null });
        },
      },
    );
    set({ _stream: stream });
  },
}));

export default useChat;
