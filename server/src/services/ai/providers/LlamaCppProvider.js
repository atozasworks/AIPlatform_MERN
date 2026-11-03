import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { env } from '../../../config/env.js';
import { getModelRecord, resolveEnabledChatModelIds } from '../modelRegistry.js';
import { logger } from '../../../config/logger.js';

/**
 * The production inference engine: `llama-server` running in router mode, bound
 * to 127.0.0.1 on the ATOZAS VPS. CPU-only, no GPU, no external egress.
 *
 * Router mode is what allows a model picker on modest hardware. One router
 * process owns the port and spawns a child server per model on demand, evicting
 * the least-recently-used one past `--models-max`. The `model` field of each
 * request selects the target, so switching models is a field in the payload
 * rather than a redeploy — but the first request after a switch pays the model
 * load, which is why `requestTimeoutMs` is generous.
 *
 * Per-model quirks (Qwen3's thinking switch, Gemma 3's missing system turn)
 * live in modelRegistry.js and are handed to the transport as `modelRuntimes`.
 */
export class LlamaCppProvider extends OpenAICompatibleProvider {
  constructor() {
    const cfg = env.ai.llamacpp;
    const enabledIds = resolveEnabledChatModelIds();

    const modelRuntimes = {};
    const models = enabledIds.map((id) => {
      const record = getModelRecord(id);
      const runtime = record?.runtime || {};

      modelRuntimes[id] = {
        contextWindow: runtime.contextWindow ?? cfg.contextWindow,
        // The operator can force reasoning back on globally; per-model extras
        // (Qwen3's enable_thinking=false) only apply when it stays off.
        extraBody: cfg.thinking ? {} : runtime.extraBody || {},
      };

      return {
        id,
        name: record?.name || id,
        label: runtime.label || record?.name || id,
        description: runtime.blurb || '',
        capabilities: ['chat'],
        contextWindow: runtime.contextWindow ?? cfg.contextWindow,
        vision: false,
        fileAnalysis: true,
        webSearch: false,
        imageGeneration: false,
        speed: 'local-cpu',
        costPer1kTokens: 0,
        license: record?.license || 'unknown',
        licenseNotes: record?.licenseNotes || '',
        selfHosted: true,
      };
    });

    super({
      id: 'llamacpp',
      label: 'ATOZAS local (llama.cpp)',
      apiKey: cfg.apiKey,
      baseUrl: `${cfg.baseUrl}/v1`,
      defaultModel: enabledIds.includes(cfg.defaultModel) ? cfg.defaultModel : enabledIds[0],
      contextWindow: cfg.contextWindow,
      requestTimeoutMs: cfg.requestTimeoutMs,
      models,
      modelRuntimes,
    });

    this.enabled = cfg.enabled;
    // Root URL (no /v1) for llama-server's native /health, /props, /tokenize.
    this.nativeBaseUrl = cfg.baseUrl;

    /**
     * Ids the router actually reports. `null` means "not probed yet", which is
     * treated as optimistic: every configured model is offered until the router
     * tells us otherwise, so a slow first probe cannot empty the picker.
     * @type {Set<string>|null}
     */
    this.servedModels = null;
    this.catalogFetchedAt = 0;
    this.catalogInFlight = null;
  }

  /**
   * Marks each configured model with whether the router is actually serving it.
   * A model whose GGUF is missing from the host stays selectable in the API
   * response but flagged unavailable, which is what lets the client grey it out
   * with an honest reason instead of failing at generation time.
   */
  getAvailableModels() {
    const engineUp = this.isAvailable();
    return this.models.map((m) => ({
      ...m,
      provider: this.id,
      available: engineUp && (this.servedModels?.has(m.id) ?? true),
      // Distinguishes "engine down" from "this model has no weights on disk".
      unavailableReason:
        !engineUp
          ? 'engine-offline'
          : this.servedModels && !this.servedModels.has(m.id)
            ? 'weights-missing'
            : null,
    }));
  }

  /**
   * Refreshes the served-model snapshot from the router's /v1/models.
   * Cached for `catalogTtlMs`; concurrent callers share one in-flight request.
   */
  async refreshCatalog({ force = false } = {}) {
    if (!this.isAvailable()) return this.servedModels;

    const fresh = Date.now() - this.catalogFetchedAt < env.ai.llamacpp.catalogTtlMs;
    if (!force && fresh && this.servedModels) return this.servedModels;
    if (this.catalogInFlight) return this.catalogInFlight;

    this.catalogInFlight = this.#fetchCatalog().finally(() => {
      this.catalogInFlight = null;
    });
    return this.catalogInFlight;
  }

  async #fetchCatalog({ timeoutMs = 4000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: controller.signal,
      });
      if (!res.ok) return this.servedModels;

      const body = await res.json();
      const ids = (body?.data || []).map((m) => m.id).filter(Boolean);
      if (!ids.length) return this.servedModels;

      this.servedModels = new Set(ids);
      this.catalogFetchedAt = Date.now();

      const missing = this.models.filter((m) => !this.servedModels.has(m.id)).map((m) => m.id);
      if (missing.length) {
        logger.warn({ missing }, 'Configured chat models are not served by llama-server');
      }
      return this.servedModels;
    } catch {
      // Leave the previous snapshot in place; checkHealth reports the outage.
      return this.servedModels;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads llama-server's runtime configuration. Surfaces the actual context
   * size and slot count so the admin endpoint reports what is really loaded
   * rather than what the .env claims.
   *
   * In router mode /props belongs to the child process currently serving, so
   * this reflects the most recently used model and is null when none is loaded.
   */
  async getServerProps({ timeoutMs = 3000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.nativeBaseUrl}/props`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = await res.json();
      return {
        contextSize: body.default_generation_settings?.n_ctx ?? null,
        slots: body.total_slots ?? null,
        modelPath: body.model_path ?? body.default_generation_settings?.model ?? null,
        chatTemplate: typeof body.chat_template === 'string' ? 'loaded' : null,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export default LlamaCppProvider;
