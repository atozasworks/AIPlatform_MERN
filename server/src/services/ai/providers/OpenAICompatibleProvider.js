import { BaseProvider } from '../BaseProvider.js';
import { AppError } from '../../../utils/AppError.js';
import { createThinkFilter, stripThinking } from '../../../utils/sanitizeText.js';
import { assertSelfHosted } from '../../../config/env.js';

/**
 * Transport for engines that speak the OpenAI Chat Completions wire format.
 *
 * "OpenAI-compatible" here refers to the request/response shape only. The base
 * URL is validated by `assertSelfHosted()` in the constructor, so this class
 * can only ever talk to ATOZAS-controlled endpoints (`llama-server` on
 * loopback today, an ATOZAS GPU node on a private address later).
 *
 * Responsibilities kept in one place: sampling parameters, request timeouts,
 * abort propagation, SSE parsing, and stripping hidden <think> reasoning from
 * the token stream before it reaches any caller.
 */
export class OpenAICompatibleProvider extends BaseProvider {
  /**
   * @param {{ id:string, label:string, apiKey?:string, baseUrl:string,
   *           defaultModel:string, contextWindow:number, requestTimeoutMs?:number,
   *           models?:Array<object>, extraBody?:object }} config
   */
  constructor(config) {
    super({ id: config.id, label: config.label });

    this.baseUrl = assertSelfHosted(`${config.id} baseUrl`, config.baseUrl).replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.defaultModel = config.defaultModel;
    this.contextWindow = config.contextWindow;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 300000;
    this.models = config.models || [];
    // Engine-specific fields merged into every payload (e.g. Qwen3 thinking off).
    this.extraBody = config.extraBody || {};
    this.enabled = true;
  }

  isAvailable() {
    return this.enabled;
  }

  getAvailableModels() {
    const available = this.isAvailable();
    return this.models.map((m) => ({ ...m, provider: this.id, available }));
  }

  #ensureAvailable() {
    if (!this.isAvailable()) {
      throw new AppError(503, `${this.label} is not available`, { code: 'PROVIDER_UNAVAILABLE' });
    }
  }

  #headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /**
   * @param {object} options Sampling settings resolved from a prompt profile.
   */
  #payload(model, messages, options, stream) {
    const sampling = options.sampling || {};
    return {
      model: model || this.defaultModel,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(sampling.temperature != null ? { temperature: sampling.temperature } : {}),
      ...(sampling.topP != null ? { top_p: sampling.topP } : {}),
      ...(sampling.repeatPenalty != null ? { repeat_penalty: sampling.repeatPenalty } : {}),
      ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
      ...(options.stop ? { stop: options.stop } : {}),
      ...this.extraBody,
    };
  }

  /**
   * Combines the caller's abort signal with this provider's wall-clock timeout.
   * Returns the signal plus a cleanup function the caller must always invoke.
   */
  #withTimeout(callerSignal) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('inference timeout')),
      this.requestTimeoutMs,
    );

    const onAbort = () => controller.abort(callerSignal.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onAbort, { once: true });
    }

    return {
      signal: controller.signal,
      cleanup() {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onAbort);
      },
      timedOut: () => controller.signal.aborted && !callerSignal?.aborted,
    };
  }

  async sendMessage({ model, messages, options = {} }) {
    this.#ensureAvailable();
    const { signal, cleanup } = this.#withTimeout(options.signal);

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(this.#payload(model, messages, options, false)),
        signal,
      });
      if (!res.ok) throw await this.#toError(res);

      const data = await res.json();
      const choice = data.choices?.[0];
      return {
        content: stripThinking(choice?.message?.content || ''),
        model: data.model || model,
        finishReason: choice?.finish_reason || 'stop',
        usage: normalizeUsage(data.usage),
      };
    } finally {
      cleanup();
    }
  }

  /**
   * Streams deltas as:
   *   { type: 'token', text }
   *   { type: 'done', model, usage, finishReason }
   */
  async *streamResponse({ model, messages, options = {} }) {
    this.#ensureAvailable();
    const { signal, cleanup, timedOut } = this.#withTimeout(options.signal);

    let reader;
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(this.#payload(model, messages, options, true)),
        signal,
      });
      if (!res.ok || !res.body) throw await this.#toError(res);

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      const think = createThinkFilter();

      let buffer = '';
      let usedModel = model || this.defaultModel;
      let usage = { prompt: 0, completion: 0, total: 0 };
      let finishReason = 'stop';

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
            const tail = think.flush();
            if (tail) yield { type: 'token', text: tail };
            yield { type: 'done', model: usedModel, usage, finishReason };
            return;
          }

          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // keep-alive or partial fragment
          }

          if (json.model) usedModel = json.model;
          if (json.usage) usage = normalizeUsage(json.usage);

          const choice = json.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;

          const delta = choice?.delta?.content;
          if (!delta) continue;

          const safe = think.push(delta);
          if (safe) yield { type: 'token', text: safe };
        }
      }

      const tail = think.flush();
      if (tail) yield { type: 'token', text: tail };
      yield { type: 'done', model: usedModel, usage, finishReason };
    } catch (err) {
      if (timedOut()) {
        throw new AppError(504, `${this.label} timed out while generating`, {
          code: 'INFERENCE_TIMEOUT',
        });
      }
      throw err;
    } finally {
      // Release the socket promptly when a consumer breaks out of the loop.
      reader?.cancel().catch(() => {});
      cleanup();
    }
  }

  /** Liveness probe used by health checks and the circuit breaker. */
  async checkHealth({ timeoutMs = 3000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/v1$/, '')}/health`, {
        headers: this.#headers(),
        signal: controller.signal,
      });
      return { ok: res.ok, status: res.status, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async #toError(res) {
    let message = `${this.label} request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error?.message) message = `${this.label}: ${body.error.message}`;
    } catch {
      // Non-JSON error body (e.g. a proxy error page); keep the generic message.
    }

    if (res.status === 404) {
      message += ` — no OpenAI-compatible endpoint at ${this.baseUrl}. Check that llama-server is running on this port.`;
    }

    const status = res.status === 429 ? 429 : res.status >= 500 ? 503 : 400;
    return new AppError(status, message, { code: 'PROVIDER_ERROR' });
  }
}

function normalizeUsage(usage) {
  if (!usage) return { prompt: 0, completion: 0, total: 0 };
  return {
    prompt: usage.prompt_tokens || 0,
    completion: usage.completion_tokens || 0,
    total: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
  };
}

export default OpenAICompatibleProvider;
