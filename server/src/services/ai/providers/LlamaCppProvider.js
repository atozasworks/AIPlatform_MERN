import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { env } from '../../../config/env.js';

/**
 * llama.cpp provider — runs YOUR OWN open-source GGUF model locally via
 * `llama-server` (part of llama.cpp). No third-party API, no per-token cost,
 * fully private. `llama-server` exposes an OpenAI-compatible endpoint at
 * {baseUrl}/v1, so it reuses the shared transport.
 *
 * Start the server, for example:
 *   llama-server -m ./models/Llama-3.2-3B-Instruct-Q4_K_M.gguf --port 8080
 *
 * Availability is gated by LLAMACPP_ENABLED so the platform doesn't advertise
 * the provider until you've built llama.cpp and loaded a model.
 */
export class LlamaCppProvider extends OpenAICompatibleProvider {
  constructor() {
    const models = (
      env.ai.llamacpp.models.length ? env.ai.llamacpp.models : [env.ai.llamacpp.model]
    ).map((id) => ({
      id,
      name: id,
      capabilities: ['chat'],
      contextWindow: env.ai.llamacpp.contextWindow,
      vision: false,
      fileAnalysis: true,
      webSearch: false,
      imageGeneration: false,
      speed: 'local',
      costPer1kTokens: 0,
    }));

    super({
      id: 'llamacpp',
      label: 'Local (llama.cpp)',
      // llama-server ignores auth by default, but the shared transport sends a
      // Bearer header; a non-empty value keeps that code path uniform.
      apiKey: env.ai.llamacpp.apiKey,
      baseUrl: `${env.ai.llamacpp.baseUrl.replace(/\/$/, '')}/v1`,
      defaultModel: env.ai.llamacpp.model,
      defaultMaxTokens: env.ai.llamacpp.maxTokens,
      models,
    });

    this.enabled = env.ai.llamacpp.enabled;
  }

  // Local server needs no API key; availability is controlled by the flag.
  isAvailable() {
    return this.enabled;
  }
}

export default LlamaCppProvider;
