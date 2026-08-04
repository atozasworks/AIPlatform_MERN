import { create } from 'zustand';
import { api } from '../lib/api.js';
import { streamChat, resumeStream } from '../lib/stream.js';
import { buildDisplayPath, parentKey } from '../lib/messageTree.js';

/**
 * Chat state: full message tree + branch choices. `messages` is the linearized
 * active path used by the UI (ChatGPT-style version switching).
 *
 * Generation is queued server-side, so the store tracks a lifecycle rather than
 * a boolean: idle → queued → generating → idle. `generation` carries the queue
 * position and job id so the composer can show progress and stop the right job.
 */

/** Phases the UI renders differently. */
export const PHASE = {
  IDLE: 'idle',
  QUEUED: 'queued',
  PREPARING: 'preparing',
  GENERATING: 'generating',
};

const emptyGeneration = {
  phase: PHASE.IDLE,
  jobId: null,
  position: 0,
  queueDepth: 0,
  activeGenerations: 0,
  notice: null,
};

export const useChat = create((set, get) => ({
  conversations: [],
  activeId: null,
  allMessages: [],
  branchChoices: {},
  messages: [],
  models: [],
  profiles: [],
  selectedProvider: 'llamacpp',
  selectedModel: '',
  selectedProfile: 'balanced',
  generation: { ...emptyGeneration },
  /**
   * Derived from `generation.phase` and kept as a plain field rather than a
   * getter: zustand merges state with Object.assign, which would flatten a
   * getter into a stale value on the first update.
   */
  isStreaming: false,
  _stream: null,

  _syncPath(allMessages, branchChoices) {
    const messages = buildDisplayPath(allMessages, branchChoices);
    set({ allMessages, branchChoices, messages });
  },

  _setGeneration(patch) {
    set((s) => {
      const generation = { ...s.generation, ...patch };
      return { generation, isStreaming: generation.phase !== PHASE.IDLE };
    });
  },

  _endGeneration(notice = null) {
    set({ generation: { ...emptyGeneration, notice }, isStreaming: false, _stream: null });
  },

  async loadModels() {
    try {
      const [{ models }, profileData] = await Promise.all([
        api.get('/ai/models'),
        api.get('/ai/profiles').catch(() => ({ profiles: [], default: 'balanced' })),
      ]);

      const firstAvailable = models.find((m) => m.available);
      set({
        models,
        profiles: profileData.profiles || [],
        selectedProfile: profileData.default || 'balanced',
        // The engine serves one model; adopt whatever it actually loaded.
        selectedProvider: firstAvailable?.provider || 'llamacpp',
        selectedModel: firstAvailable?.id || '',
      });
    } catch {
      set({ models: [], profiles: [] });
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
      profile: get().selectedProfile,
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

  /**
   * Mark a message private: the server links a unique code to it and emails the
   * code to the user as a receipt. Updates the local message with the code.
   */
  async markMessagePrivate(messageId) {
    if (String(messageId).startsWith('tmp-')) return null;
    const activeId = get().activeId;
    if (!activeId) return null;

    const { message, emailDelivered } = await api.post(
      `/conversations/${activeId}/messages/${messageId}/private`,
    );

    const next = get().allMessages.map((m) =>
      m.id === messageId
        ? {
            ...m,
            isPrivate: true,
            privateCode: message.privateCode,
            privateCodeSentAt: message.privateCodeSentAt,
          }
        : m,
    );
    get()._syncPath(next, get().branchChoices);

    return { privateCode: message.privateCode, emailDelivered };
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

  setProfile(profile) {
    set({ selectedProfile: profile });
  },

  dismissNotice() {
    get()._setGeneration({ notice: null });
  },

  /** Stop Generation — cancels server-side so the worker frees its slot. */
  async stopStreaming() {
    const stream = get()._stream;
    if (!stream) return;
    get()._setGeneration({ phase: PHASE.GENERATING, notice: null });
    await stream.cancel();
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
    const pruned = Object.fromEntries(Object.entries(nextChoices).filter(([k]) => keep.has(k)));
    get()._syncPath(allMessages, pruned);
  },

  /**
   * Create a sibling branch with the edited prompt (keeps old versions) and
   * stream a fresh assistant reply — ChatGPT-style edit.
   */
  async editMessage(messageId, content) {
    const text = content.trim();
    if (!text || get().generation.phase !== PHASE.IDLE) return;

    const activeId = get().activeId;
    if (!activeId) return;

    const { parentMessageId } = await api.post(
      `/conversations/${activeId}/messages/${messageId}/edit`,
      { content: text },
    );

    await get().sendMessage(text, { parentMessageId: parentMessageId ?? null });
  },

  async sendMessage(text, { parentMessageId } = {}) {
    if (get().generation.phase !== PHASE.IDLE) return;

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
      citations: [],
      parentMessage: userId,
      createdAt: new Date().toISOString(),
    };

    const allMessages = [...get().allMessages, userMsg, assistantMsg];
    const key = parentKey(resolvedParent);
    const branchChoices = { ...get().branchChoices, [key]: userId };
    get()._syncPath(allMessages, branchChoices);
    get()._setGeneration({ phase: PHASE.QUEUED, notice: null, position: 0 });

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

    const handlers = {
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
        } else if (meta.provider) {
          patchById(assistantId, { provider: meta.provider, model: meta.model });
        }

        // Survives a refresh: the page can re-attach to this job on reload.
        if (meta.jobId) {
          get()._setGeneration({ jobId: meta.jobId });
          sessionStorage.setItem(
            `atozas:job:${activeId}`,
            JSON.stringify({ jobId: meta.jobId, assistantId }),
          );
        }
      },

      onQueued: (data) =>
        get()._setGeneration({
          phase: PHASE.QUEUED,
          position: data.position ?? 0,
          queueDepth: data.queueDepth ?? 0,
          activeGenerations: data.activeGenerations ?? 0,
        }),

      // The model is loaded and prefilling; tokens have not started yet.
      onStarted: () => get()._setGeneration({ phase: PHASE.PREPARING, position: 0 }),

      onToken: (t) => {
        if (get().generation.phase !== PHASE.GENERATING) {
          get()._setGeneration({ phase: PHASE.GENERATING });
        }
        const next = get().allMessages.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + t } : m,
        );
        get()._syncPath(next, get().branchChoices);
      },

      onCitations: (sources) => patchById(assistantId, { retrievedSources: sources }),

      onTitle: (title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === activeId ? { ...c, title } : c,
          ),
        })),

      onCompleted: (data) => {
        patchById(assistantId, {
          status: 'complete',
          model: data.model,
          citations: data.citations || [],
          stats: data.stats || null,
        });
        sessionStorage.removeItem(`atozas:job:${activeId}`);
        get()._endGeneration(
          data.truncatedInput
            ? 'Your message was long, so the earlier part was trimmed to fit the model context.'
            : null,
        );
      },

      onCancel: () => {
        patchById(assistantId, { status: 'stopped' });
        sessionStorage.removeItem(`atozas:job:${activeId}`);
        get()._endGeneration();
      },

      onError: (err) => {
        const current = get().allMessages.find((m) => m.id === assistantId);
        patchById(assistantId, {
          status: 'error',
          content: current?.content || '',
          error: err.message,
        });
        sessionStorage.removeItem(`atozas:job:${activeId}`);
        get()._endGeneration(
          err.code === 'QUEUE_FULL' || err.code === 'INFERENCE_UNAVAILABLE'
            ? 'ATOZAS AI is temporarily unavailable. Please try again in a moment.'
            : null,
        );
      },

      // Connection dropped without a terminal event; the worker keeps going.
      onClose: () => {
        if (get().generation.phase === PHASE.IDLE) return;
        patchById(assistantId, { status: 'complete' });
        get()._endGeneration('The connection dropped. Reload to see the finished reply.');
      },
    };

    const stream = streamChat(
      activeId,
      {
        content: text,
        provider: get().selectedProvider,
        model: get().selectedModel || undefined,
        profile: get().selectedProfile,
        clientMessageId,
        // Always sent explicitly so edit siblings land on the right parent.
        parentMessageId: resolvedParent,
      },
      handlers,
    );

    set({ _stream: stream });
  },

  /**
   * Re-attaches to a generation that was running when the page was reloaded.
   * Call once after `openConversation`.
   */
  async resumeActiveGeneration(conversationId) {
    const saved = sessionStorage.getItem(`atozas:job:${conversationId}`);
    if (!saved) return;

    let jobId;
    let assistantId;
    try {
      ({ jobId, assistantId } = JSON.parse(saved));
    } catch {
      sessionStorage.removeItem(`atozas:job:${conversationId}`);
      return;
    }
    if (!jobId || !assistantId) return;

    const patchById = (id, patch) => {
      const next = get().allMessages.map((m) => (m.id === id ? { ...m, ...patch } : m));
      get()._syncPath(next, get().branchChoices);
    };

    get()._setGeneration({ phase: PHASE.GENERATING, jobId });

    // The already-persisted prefix is on screen; replay only what follows it.
    const existing = get().allMessages.find((m) => m.id === assistantId);
    const stream = resumeStream(
      conversationId,
      jobId,
      { lastSeq: 0 },
      {
        onToken: (t) => {
          const next = get().allMessages.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + t } : m,
          );
          get()._syncPath(next, get().branchChoices);
        },
        onCompleted: (data) => {
          patchById(assistantId, {
            status: 'complete',
            citations: data.citations || [],
            stats: data.stats || null,
          });
          sessionStorage.removeItem(`atozas:job:${conversationId}`);
          get()._endGeneration();
        },
        onCancel: () => {
          patchById(assistantId, { status: 'stopped' });
          sessionStorage.removeItem(`atozas:job:${conversationId}`);
          get()._endGeneration();
        },
        onError: () => {
          sessionStorage.removeItem(`atozas:job:${conversationId}`);
          get()._endGeneration();
        },
        onClose: () => get()._endGeneration(),
      },
    );

    // Wipe the optimistic prefix so replayed tokens rebuild it exactly once.
    if (existing) patchById(assistantId, { content: '' });

    set({ _stream: stream });
  },
}));

export default useChat;
