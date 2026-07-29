import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { env } from '../../../config/env.js';

/**
 * OpenAI provider. Uses the shared OpenAI-compatible transport with OpenAI's
 * endpoint, key, and model catalog.
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: 'openai',
      label: 'OpenAI',
      apiKey: env.ai.openai.apiKey,
      baseUrl: env.ai.openai.baseUrl,
      defaultModel: env.ai.openai.defaultModel,
      models: [
        {
          id: 'gpt-4o-mini',
          name: 'GPT-4o mini',
          capabilities: ['chat', 'vision'],
          contextWindow: 128000,
          vision: true,
          fileAnalysis: true,
          webSearch: false,
          imageGeneration: false,
          speed: 'fast',
          costPer1kTokens: 0.0006,
        },
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: ['chat', 'vision'],
          contextWindow: 128000,
          vision: true,
          fileAnalysis: true,
          webSearch: false,
          imageGeneration: false,
          speed: 'medium',
          costPer1kTokens: 0.005,
        },
      ],
    });
  }
}

export default OpenAIProvider;
