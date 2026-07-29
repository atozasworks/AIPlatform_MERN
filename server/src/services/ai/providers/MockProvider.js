import { BaseProvider } from '../BaseProvider.js';

/**
 * Zero-cost provider used for local development and automated tests (§27).
 * It streams a deterministic, context-aware response token-by-token so the full
 * streaming pipeline can be exercised without any external API spend.
 */
export class MockProvider extends BaseProvider {
  constructor() {
    super({ id: 'mock', label: 'Mock (Development)' });
  }

  isAvailable() {
    return true;
  }

  getAvailableModels() {
    return [
      {
        id: 'mock-basic',
        provider: 'mock',
        name: 'Mock Basic',
        capabilities: ['chat'],
        contextWindow: 8192,
        vision: false,
        fileAnalysis: false,
        webSearch: false,
        imageGeneration: false,
        speed: 'fast',
        costPer1kTokens: 0,
        available: true,
      },
    ];
  }

  #buildReply(messages) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser?.content?.trim() || '';
    return (
      `**Mock assistant** (development mode)\n\n` +
      `You said: "${prompt.slice(0, 500)}"\n\n` +
      `This is a simulated streaming response. Set a real provider key ` +
      `(e.g. \`OPENAI_API_KEY\`) in \`server/.env\` to use a live model. ` +
      `The full pipeline — auth, persistence, and token-by-token streaming — is working.`
    );
  }

  async sendMessage({ messages }) {
    const content = this.#buildReply(messages);
    return {
      content,
      model: 'mock-basic',
      usage: { prompt: 0, completion: 0, total: 0 },
    };
  }

  async *streamResponse({ messages, options = {} }) {
    const content = this.#buildReply(messages);
    const tokens = content.match(/\S+\s*/g) || [content];
    for (const token of tokens) {
      if (options.signal?.aborted) return;
      // Simulate network/generation latency for a realistic stream.
      // eslint-disable-next-line no-await-in-loop
      await delay(20);
      yield { type: 'token', text: token };
    }
    yield {
      type: 'done',
      model: 'mock-basic',
      usage: { prompt: 0, completion: tokens.length, total: tokens.length },
    };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default MockProvider;
