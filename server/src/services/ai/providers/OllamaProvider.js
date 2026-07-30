import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { env } from '../../../config/env.js';

/**
 * Ollama provider — runs YOUR OWN open-source model locally / on your own server
 * (no third-party API, no per-token cost, fully private). Ollama exposes an
 * OpenAI-compatible endpoint at {baseUrl}/v1, so it reuses the shared transport.
 *
 * Availability is gated by OLLAMA_ENABLED so the platform doesn't advertise the
 * provider until you've installed Ollama and pulled a model.
 */
export class OllamaProvider extends OpenAICompatibleProvider {
  constructor() {
    const models = (env.ai.ollama.models.length ? env.ai.ollama.models : [env.ai.ollama.model]).map(
      (id) => ({
        id,
        name: id,
        capabilities: ['chat'],
        contextWindow: env.ai.ollama.contextWindow,
        vision: false,
        fileAnalysis: true,
        webSearch: false,
        imageGeneration: false,
        speed: 'local',
        costPer1kTokens: 0,
      }),
    );

    super({
      id: 'ollama',
      label: 'Local (Ollama)',
      // Ollama ignores auth, but the shared transport sends a Bearer header;
      // a non-empty dummy keeps that code path uniform.
      apiKey: 'ollama',
      baseUrl: `${env.ai.ollama.baseUrl.replace(/\/$/, '')}/v1`,
      defaultModel: env.ai.ollama.model,
      models,
    });

    this.enabled = env.ai.ollama.enabled;
  }

  // Local server needs no API key; availability is controlled by the flag.
  isAvailable() {
    return this.enabled;
  }
}

export default OllamaProvider;
