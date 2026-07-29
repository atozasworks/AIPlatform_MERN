import { MockProvider } from './providers/MockProvider.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { GroqProvider } from './providers/GroqProvider.js';
import { AppError } from '../../utils/AppError.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * The AI Gateway is the single entry point the rest of the app uses to talk to
 * any provider. It owns provider registration, model discovery, and (in later
 * phases) retry/fallback/circuit-breaking. Providers are swappable without
 * touching callers (§3, §22).
 */
class AIGateway {
  constructor() {
    /** @type {Map<string, import('./BaseProvider.js').BaseProvider>} */
    this.providers = new Map();
    this.#register(new MockProvider());
    this.#register(new GroqProvider());
    this.#register(new OpenAIProvider());
  }

  #register(provider) {
    this.providers.set(provider.id, provider);
  }

  getProvider(id) {
    const provider = this.providers.get(id);
    if (!provider) {
      throw AppError.badRequest(`Unknown AI provider: ${id}`, { code: 'UNKNOWN_PROVIDER' });
    }
    return provider;
  }

  /** All models across available providers, annotated with availability. */
  listModels({ onlyAvailable = false } = {}) {
    const models = [];
    for (const provider of this.providers.values()) {
      const available = provider.isAvailable();
      if (onlyAvailable && !available) continue;
      for (const m of provider.getAvailableModels()) {
        models.push({ ...m, available: available && m.available !== false });
      }
    }
    return models;
  }

  /**
   * Resolves the provider+model to use, applying defaults and "auto" selection.
   * Falls back to the Mock provider when the requested provider is unavailable so
   * development never hard-fails (§4, §22).
   */
  resolve({ provider, model } = {}) {
    if (!provider || provider === 'auto') {
      return this.#autoSelect(model);
    }
    const p = this.getProvider(provider);
    if (!p.isAvailable()) {
      logger.warn({ provider }, 'Requested provider unavailable, falling back to mock');
      return { provider: this.getProvider('mock'), model: 'mock-basic' };
    }
    const resolvedModel = model || p.getAvailableModels()[0]?.id;
    return { provider: p, model: resolvedModel };
  }

  #autoSelect(preferredModel) {
    // Phase 1: prefer configured default, then first available real provider,
    // else Mock. Later phases weigh capability/cost/speed/subscription.
    const configured = this.providers.get(env.ai.defaultProvider);
    if (configured?.isAvailable()) {
      return { provider: configured, model: preferredModel || env.ai.defaultModel };
    }
    for (const p of this.providers.values()) {
      if (p.id !== 'mock' && p.isAvailable()) {
        return { provider: p, model: preferredModel || p.getAvailableModels()[0]?.id };
      }
    }
    return { provider: this.getProvider('mock'), model: 'mock-basic' };
  }
}

export const aiGateway = new AIGateway();
export default aiGateway;
