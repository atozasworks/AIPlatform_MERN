import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { env } from '../../../config/env.js';
import { getModelRecord } from '../modelRegistry.js';

/**
 * The production inference engine: Qwen3-4B-Q4_K_M served by `llama-server`
 * bound to 127.0.0.1 on the ATOZAS VPS. CPU-only, no GPU, no external egress.
 *
 * Non-thinking mode is the default. Qwen3 accepts `chat_template_kwargs` to
 * disable reasoning; `/no_think` in the prompt is the fallback for builds that
 * predate that flag. Either way `OpenAICompatibleProvider` strips any <think>
 * block that still appears, so hidden reasoning cannot reach the browser.
 */
export class LlamaCppProvider extends OpenAICompatibleProvider {
  constructor() {
    const cfg = env.ai.llamacpp;
    const record = getModelRecord(cfg.model);

    super({
      id: 'llamacpp',
      label: 'ATOZAS local (llama.cpp)',
      apiKey: cfg.apiKey,
      baseUrl: `${cfg.baseUrl}/v1`,
      defaultModel: cfg.model,
      contextWindow: cfg.contextWindow,
      requestTimeoutMs: cfg.requestTimeoutMs,
      extraBody: cfg.thinking ? {} : { chat_template_kwargs: { enable_thinking: false } },
      models: [
        {
          id: cfg.model,
          name: record?.name || cfg.model,
          capabilities: ['chat'],
          contextWindow: cfg.contextWindow,
          vision: false,
          fileAnalysis: true,
          webSearch: false,
          imageGeneration: false,
          speed: 'local-cpu',
          costPer1kTokens: 0,
          license: record?.license || 'unknown',
          selfHosted: true,
        },
      ],
    });

    this.enabled = cfg.enabled;
    // Root URL (no /v1) for llama-server's native /health, /props, /tokenize.
    this.nativeBaseUrl = cfg.baseUrl;
  }

  /**
   * Reads llama-server's runtime configuration. Surfaces the actual context
   * size and slot count so the admin endpoint reports what is really loaded
   * rather than what the .env claims.
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
