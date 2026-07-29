import { BaseProvider } from '../BaseProvider.js';
import { AppError } from '../../../utils/AppError.js';

/**
 * Generic adapter for any provider that speaks the OpenAI Chat Completions API
 * (OpenAI, Groq, DeepSeek, OpenRouter, Ollama, etc.). Concrete providers supply
 * their id/label/apiKey/baseUrl/models via config, keeping the transport logic
 * in one place (coding rule: avoid duplicated logic).
 *
 * The API key lives only in backend env and is never returned to clients (§3, §21).
 */
export class OpenAICompatibleProvider extends BaseProvider {
  /**
   * @param {{ id:string, label:string, apiKey:string, baseUrl:string,
   *           defaultModel:string, models:Array<object> }} config
   */
  constructor(config) {
    super({ id: config.id, label: config.label });
    this.apiKey = config.apiKey || '';
    this.baseUrl = (config.baseUrl || '').replace(/\/$/, '');
    this.defaultModel = config.defaultModel;
    this.models = config.models || [];
  }

  isAvailable() {
    return Boolean(this.apiKey);
  }

  getAvailableModels() {
    const available = this.isAvailable();
    return this.models.map((m) => ({ ...m, provider: this.id, available }));
  }

  #ensureAvailable() {
    if (!this.isAvailable()) {
      throw new AppError(503, `${this.label} provider is not configured (missing API key)`, {
        code: 'PROVIDER_UNAVAILABLE',
      });
    }
  }

  #payload(model, messages, options, stream) {
    return {
      model: model || this.defaultModel,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
      ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
    };
  }

  #headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async sendMessage({ model, messages, options = {} }) {
    this.#ensureAvailable();
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(this.#payload(model, messages, options, false)),
      signal: options.signal,
    });
    if (!res.ok) throw await this.#toError(res);
    const data = await res.json();
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || '',
      model: data.model || model,
      usage: normalizeUsage(data.usage),
    };
  }

  async *streamResponse({ model, messages, options = {} }) {
    this.#ensureAvailable();
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(this.#payload(model, messages, options, true)),
      signal: options.signal,
    });
    if (!res.ok || !res.body) throw await this.#toError(res);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usedModel = model || this.defaultModel;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          yield { type: 'done', model: usedModel, usage: { prompt: 0, completion: 0, total: 0 } };
          return;
        }
        try {
          const json = JSON.parse(payload);
          if (json.model) usedModel = json.model;
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield { type: 'token', text: delta };
        } catch {
          // Ignore keep-alive / partial fragments.
        }
      }
    }
    yield { type: 'done', model: usedModel, usage: { prompt: 0, completion: 0, total: 0 } };
  }

  async #toError(res) {
    let message = `${this.label} request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      // ignore parse errors
    }
    const status = res.status === 429 ? 429 : res.status >= 500 ? 502 : 400;
    return new AppError(status, message, { code: 'PROVIDER_ERROR' });
  }
}

function normalizeUsage(usage) {
  if (!usage) return { prompt: 0, completion: 0, total: 0 };
  return {
    prompt: usage.prompt_tokens || 0,
    completion: usage.completion_tokens || 0,
    total: usage.total_tokens || 0,
  };
}

export default OpenAICompatibleProvider;
