import { create } from 'zustand';
import { api } from '../lib/api.js';
import { streamPublicChat } from '../lib/publicStream.js';

/**
 * Pre-login guest chat store. Sessions belong to this browser's guest cookie —
 * visitors do not share one global thread.
 */

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

function mapMessage(m) {
  return {
    id: m.id,
    role: m.role,
    content: m.content || '',
    status: m.status || 'complete',
    model: m.model,
    provider: m.provider,
    createdAt: m.createdAt,
    error: m.error,
  };
}

export const usePublicChat = create((set, get) => ({
  messages: [],
  sessions: [],
  activeId: null,
  session: null,
  selectedProvider: 'llamacpp',
  selectedModel: '',
  selectedProfile: 'balanced',
  generation: { ...emptyGeneration },
  isStreaming: false,
  loadingHistory: true,
  historyError: null,
  searchQuery: '',
  _stream: null,

  _setGeneration(patch) {
    set((s) => {
      const generation = { ...s.generation, ...patch };
      return { generation, isStreaming: generation.phase !== PHASE.IDLE };
    });
  },

  _endGeneration(notice = null) {
    set({ generation: { ...emptyGeneration, notice }, isStreaming: false, _stream: null });
  },

  setSearchQuery(searchQuery) {
    set({ searchQuery });
  },

  async loadModels() {
    try {
      const [{ models }, profileData] = await Promise.all([
        api.get('/public/models'),
        api.get('/public/profiles').catch(() => ({ profiles: [], default: 'balanced' })),
      ]);
      const firstAvailable = models.find((m) => m.available);
      set({
        selectedProvider: firstAvailable?.provider || 'llamacpp',
        selectedModel: firstAvailable?.id || '',
        selectedProfile: profileData.default || 'balanced',
      });
    } catch {
      // Non-fatal: stream endpoints resolve the default engine themselves.
    }
  },

  async loadSessions(q) {
    const query = q !== undefined ? q : get().searchQuery;
    set({ loadingHistory: true, historyError: null });
    try {
      const qs = query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      const { sessions } = await api.get(`/public/sessions${qs}`);
      set({ sessions: sessions || [], loadingHistory: false });
    } catch (err) {
      set({
        loadingHistory: false,
        historyError: err.message || 'Could not load chat history.',
      });
    }
  },

  async newSession() {
    const stream = get()._stream;
    if (stream) {
      try {
        await stream.cancel();
      } catch {
        /* ignore */
      }
    }
    get()._endGeneration();
    set({
      activeId: null,
      session: null,
      messages: [],
    });
  },

  async openSession(id) {
    if (!id) return;
    const stream = get()._stream;
    if (stream) {
      try {
        await stream.cancel();
      } catch {
        /* ignore */
      }
    }
    get()._endGeneration();
    set({ loadingHistory: true, historyError: null, activeId: id, messages: [] });
    try {
      const { session, messages } = await api.get(`/public/sessions/${id}`);
      if (get().activeId !== id) return;
      set({
        session,
        activeId: session.id,
        messages: (messages || []).map(mapMessage),
        loadingHistory: false,
      });
    } catch (err) {
      set({
        loadingHistory: false,
        historyError: err.message || 'Could not open chat.',
        activeId: null,
        session: null,
        messages: [],
      });
    }
  },

  async deleteSession(id) {
    await api.delete(`/public/sessions/${id}`);
    set((s) => ({
      sessions: s.sessions.filter((c) => c.id !== id),
      ...(s.activeId === id
        ? { activeId: null, session: null, messages: [] }
        : {}),
    }));
  },

  async _ensureSession() {
    let activeId = get().activeId;
    if (activeId) return activeId;

    const { session } = await api.post('/public/sessions', {
      provider: get().selectedProvider,
      model: get().selectedModel || undefined,
      profile: get().selectedProfile,
    });
    set((s) => ({
      session,
      activeId: session.id,
      sessions: [session, ...s.sessions.filter((c) => c.id !== session.id)],
    }));
    return session.id;
  },

  async stopStreaming() {
    const stream = get()._stream;
    if (!stream) return;
    await stream.cancel();
  },

  dismissNotice() {
    get()._setGeneration({ notice: null });
  },

  async sendMessage(text) {
    const content = text.trim();
    if (!content || get().generation.phase !== PHASE.IDLE) return;

    const activeId = await get()._ensureSession();

    const clientMessageId = crypto.randomUUID();
    let userId = `tmp-user-${clientMessageId}`;
    let assistantId = `tmp-assistant-${clientMessageId}`;

    const userMsg = {
      id: userId,
      role: 'user',
      content,
      status: 'complete',
      createdAt: new Date().toISOString(),
    };
    const assistantMsg = {
      id: assistantId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      provider: null,
      model: null,
      createdAt: new Date().toISOString(),
    };

    set((s) => ({ messages: [...s.messages, userMsg, assistantMsg] }));
    get()._setGeneration({ phase: PHASE.QUEUED, notice: null, position: 0 });

    const patchById = (id, patch) => {
      set((s) => ({
        messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      }));
    };

    const renameId = (prevId, nextId, extra = {}) => {
      set((s) => ({
        messages: s.messages.map((m) => (m.id === prevId ? { ...m, id: nextId, ...extra } : m)),
      }));
    };

    const handlers = {
      onMeta: (meta) => {
        const prevUserId = userId;
        const prevAssistantId = assistantId;
        if (meta.userMessageId) userId = meta.userMessageId;
        if (meta.assistantMessageId) assistantId = meta.assistantMessageId;

        if (prevUserId !== userId) renameId(prevUserId, userId);
        if (prevAssistantId !== assistantId) {
          renameId(prevAssistantId, assistantId, {
            provider: meta.provider,
            model: meta.model,
          });
        } else if (meta.provider) {
          patchById(assistantId, { provider: meta.provider, model: meta.model });
        }

        if (meta.jobId) get()._setGeneration({ jobId: meta.jobId });

        if (meta.title || meta.sessionId) {
          set((s) => ({
            sessions: s.sessions.map((c) =>
              c.id === (meta.sessionId || activeId)
                ? {
                    ...c,
                    title: meta.title || c.title,
                    lastMessageAt: new Date().toISOString(),
                  }
                : c,
            ),
            session:
              s.session && s.session.id === (meta.sessionId || activeId)
                ? { ...s.session, title: meta.title || s.session.title }
                : s.session,
          }));
        }
      },

      onQueued: (data) =>
        get()._setGeneration({
          phase: PHASE.QUEUED,
          position: data.position ?? 0,
          queueDepth: data.queueDepth ?? 0,
          activeGenerations: data.activeGenerations ?? 0,
        }),

      onStarted: () => get()._setGeneration({ phase: PHASE.PREPARING, position: 0 }),

      onToken: (t) => {
        if (get().generation.phase !== PHASE.GENERATING) {
          get()._setGeneration({ phase: PHASE.GENERATING });
        }
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + t } : m,
          ),
        }));
      },

      onCompleted: (data) => {
        patchById(assistantId, {
          status: 'complete',
          model: data.model,
        });
        // Ensure the session appears in history after the first real turn.
        get().loadSessions();
        get()._endGeneration(
          data.truncatedInput
            ? 'Your message was long, so the earlier part was trimmed to fit the model context.'
            : null,
        );
      },

      onCancel: () => {
        patchById(assistantId, { status: 'stopped' });
        get()._endGeneration();
      },

      onError: (err) => {
        const current = get().messages.find((m) => m.id === assistantId);
        patchById(assistantId, {
          status: 'error',
          content: current?.content || '',
          error: err.message,
        });
        get()._endGeneration(
          err.code === 'QUEUE_FULL' || err.code === 'INFERENCE_UNAVAILABLE'
            ? 'ATOZAS AI is temporarily unavailable. Please try again in a moment.'
            : null,
        );
      },

      onClose: () => {
        if (get().generation.phase === PHASE.IDLE) return;
        patchById(assistantId, { status: 'complete' });
        get()._endGeneration('The connection dropped.');
      },
    };

    const payload = {
      content,
      provider: get().selectedProvider,
      model: get().selectedModel || undefined,
      profile: get().selectedProfile,
      clientMessageId,
    };

    const stream = streamPublicChat(activeId, payload, handlers);
    set({ _stream: stream });
  },
}));

export default usePublicChat;
