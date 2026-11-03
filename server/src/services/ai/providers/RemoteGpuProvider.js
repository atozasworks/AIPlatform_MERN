import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { env } from '../../../config/env.js';
import { getModelRecord } from '../modelRegistry.js';

/**
 * Migration target: an ATOZAS-owned GPU server running vLLM, TGI, SGLang or
 * llama.cpp with CUDA, exposing the OpenAI Chat Completions wire format.
 *
 * "OpenAI-compatible" describes the request shape only. `GPU_BASE_URL` is
 * validated by `assertSelfHosted()` in the base class, so this provider can
 * only address loopback, an RFC1918 private address, or a hostname the
 * operator explicitly allowlisted via SELF_HOSTED_ALLOWED_HOSTS. Pointing it
 * at a commercial vendor fails at startup.
 *
 * Because it shares the gateway contract with LlamaCppProvider, cutting over is
 * an environment change only:
 *
 *   GPU_ENABLED=true
 *   GPU_BASE_URL=http://10.0.0.20:8000
 *   GPU_MODEL=qwen3-14b-instruct
 *   DEFAULT_AI_PROVIDER=gpu
 *
 * No frontend, queue or business-logic change is required.
 */
export class RemoteGpuProvider extends OpenAICompatibleProvider {
  constructor() {
    const cfg = env.ai.gpu;
    const record = getModelRecord(cfg.model);

    super({
      id: 'gpu',
      label: 'ATOZAS GPU node',
      apiKey: cfg.apiKey,
      // Disabled deployments keep a loopback placeholder so construction stays
      // side-effect free; the self-hosted assertion still applies when enabled.
      baseUrl: `${cfg.baseUrl || 'http://127.0.0.1:8000'}/v1`,
      defaultModel: cfg.model || 'gpu-model',
      contextWindow: cfg.contextWindow,
      requestTimeoutMs: cfg.requestTimeoutMs,
      models: cfg.model
        ? [
            {
              id: cfg.model,
              name: record?.name || cfg.model,
              capabilities: ['chat'],
              contextWindow: cfg.contextWindow,
              vision: false,
              fileAnalysis: true,
              webSearch: false,
              imageGeneration: false,
              speed: 'gpu',
              costPer1kTokens: 0,
              license: record?.license || 'unknown',
              selfHosted: true,
            },
          ]
        : [],
    });

    this.enabled = cfg.enabled && Boolean(cfg.baseUrl && cfg.model);
  }
}

export default RemoteGpuProvider;
