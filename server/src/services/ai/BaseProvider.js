import { AppError } from '../../utils/AppError.js';

/**
 * Common AI provider interface (§3). Every concrete provider extends this class
 * and implements the subset of capabilities it supports. Callers depend only on
 * this contract, so the platform is never tightly coupled to one vendor.
 *
 * Capability methods that a provider does not support throw a clear 501-style
 * AppError rather than silently failing.
 */
export class BaseProvider {
  /** @param {{ id: string, label: string }} meta */
  constructor(meta) {
    this.id = meta.id;
    this.label = meta.label;
  }

  /** @returns {boolean} whether the provider is configured/available. */
  isAvailable() {
    return true;
  }

  /**
   * Non-streaming completion.
   * @returns {Promise<{ content: string, model: string, usage: object }>}
   */
  // eslint-disable-next-line no-unused-vars
  async sendMessage({ model, messages, options }) {
    throw this._unsupported('sendMessage');
  }

  /**
   * Streaming completion. Async generator yielding delta chunks:
   *   { type: 'token', text } | { type: 'done', usage, model }
   */
  // eslint-disable-next-line no-unused-vars, require-yield
  async *streamResponse({ model, messages, options }) {
    throw this._unsupported('streamResponse');
  }

  // eslint-disable-next-line no-unused-vars
  async generateImage({ model, prompt, options }) {
    throw this._unsupported('generateImage');
  }

  // eslint-disable-next-line no-unused-vars
  async analyzeImage({ model, images, prompt }) {
    throw this._unsupported('analyzeImage');
  }

  // eslint-disable-next-line no-unused-vars
  async createEmbedding({ model, input }) {
    throw this._unsupported('createEmbedding');
  }

  // eslint-disable-next-line no-unused-vars
  async countTokens({ model, messages }) {
    // Rough heuristic fallback (~4 chars/token). Providers override when possible.
    const text = (messages || []).map((m) => m.content || '').join(' ');
    return Math.ceil(text.length / 4);
  }

  // eslint-disable-next-line no-unused-vars
  async moderateContent({ input }) {
    return { flagged: false, categories: {} };
  }

  /** @returns {Array<object>} model descriptors this provider exposes. */
  getAvailableModels() {
    return [];
  }

  _unsupported(method) {
    return new AppError(501, `Provider "${this.id}" does not support ${method}()`, {
      code: 'CAPABILITY_UNSUPPORTED',
    });
  }
}

export default BaseProvider;
