import { LlamaCppProvider } from './providers/LlamaCppProvider.js';
import { RemoteGpuProvider } from './providers/RemoteGpuProvider.js';
import { AppError } from '../../utils/AppError.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Single entry point for inference.
 *
 * Two deliberate differences from the previous implementation:
 *
 *  1. Only ATOZAS-controlled engines are registered. Groq, OpenAI and every
 *     other hosted vendor have been removed from the codebase entirely, so
 *     there is nothing to fall back to even by accident.
 *
 *  2. There is no silent fallback of any kind. When the configured engine is
 *     down, `resolve()` raises a 503. The previous behaviour — quietly
 *     substituting another provider or a mock — could have masked an outage or,
 *     with an API key present, routed user prompts off ATOZAS infrastructure.
 */
class AIGateway {
  constructor() {
    /** @type {Map<string, import('./BaseProvider.js').BaseProvider>} */
    this.providers = new Map();
    this.#register(new LlamaCppProvider());
    this.#register(new RemoteGpuProvider());
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

  /** Every model across registered engines, annotated with availability. */
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
   * Resolves the engine and model for a request.
   *
   * @throws {AppError} 503 when the requested (or default) engine is offline.
   *                    Callers surface this to the user rather than rerouting.
   */
  resolve({ provider, model } = {}) {
    const id = !provider || provider === 'auto' ? env.ai.defaultProvider : provider;
    const target = this.getProvider(id);

    if (!target.isAvailable()) {
      logger.error({ provider: id }, 'Configured inference engine is unavailable');
      throw new AppError(
        503,
        'The ATOZAS inference engine is temporarily unavailable. Please try again shortly.',
        { code: 'INFERENCE_UNAVAILABLE' },
      );
    }

    const supported = target.getAvailableModels().map((m) => m.id);
    const resolvedModel = model && supported.includes(model) ? model : supported[0];

    if (!resolvedModel) {
      throw new AppError(503, 'No model is currently loaded on the inference engine.', {
        code: 'INFERENCE_UNAVAILABLE',
      });
    }

    return { provider: target, model: resolvedModel };
  }

  /** Health of every registered engine, for readiness probes and admin status. */
  async healthReport() {
    const entries = await Promise.all(
      [...this.providers.values()].map(async (p) => {
        if (!p.isAvailable()) {
          return [p.id, { enabled: false, ok: false, reason: 'disabled by configuration' }];
        }
        const health = await p.checkHealth();
        return [p.id, { enabled: true, ...health }];
      }),
    );
    return Object.fromEntries(entries);
  }
}

export const aiGateway = new AIGateway();
export default aiGateway;
