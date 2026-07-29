import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { env } from '../../../config/env.js';

/**
 * Groq provider. Groq exposes an OpenAI-compatible Chat Completions endpoint,
 * so it reuses the shared transport. Known for very low latency inference on
 * open models (Llama, etc.).
 */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: 'groq',
      label: 'Groq',
      apiKey: env.ai.groq.apiKey,
      baseUrl: env.ai.groq.baseUrl,
      defaultModel: env.ai.groq.defaultModel,
      models: [
        {
          id: 'llama-3.3-70b-versatile',
          name: 'Llama 3.3 70B Versatile',
          capabilities: ['chat'],
          contextWindow: 128000,
          vision: false,
          fileAnalysis: true,
          webSearch: false,
          imageGeneration: false,
          speed: 'very-fast',
          costPer1kTokens: 0.0005,
        },
        {
          id: 'llama-3.1-8b-instant',
          name: 'Llama 3.1 8B Instant',
          capabilities: ['chat'],
          contextWindow: 128000,
          vision: false,
          fileAnalysis: false,
          webSearch: false,
          imageGeneration: false,
          speed: 'very-fast',
          costPer1kTokens: 0.00005,
        },
      ],
    });
  }
}

export default GroqProvider;
