import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * End-to-end test of the generation pipeline.
 *
 * Covers the path a real request takes: HTTP → admission control → BullMQ →
 * worker → llama-server → Redis stream bus → SSE relay → browser.
 *
 * llama-server is replaced by a mock that speaks the same OpenAI SSE wire
 * format. That keeps the test fast and deterministic while still exercising
 * every piece of our own code, including the <think> filter and cancellation.
 *
 * Requires MongoDB and Redis to be running.
 * Run with:  npm run test:e2e
 */

const RUN_ID = crypto.randomBytes(4).toString('hex');
// Ephemeral port: a fixed one collides with a previous run that has not yet
// exited, which fails the suite for an unrelated reason.
const MOCK_PORT = await reservePort();

/** Finds a free localhost port by binding and immediately releasing one. */
async function reservePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// env.js snapshots process.env at import time, so configuration must be set
// before any application module is loaded.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = `mongodb://127.0.0.1:27017/atozas_e2e_${RUN_ID}`;
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.REDIS_PREFIX = `atozas-e2e-${RUN_ID}`;
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret';
process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.LLAMACPP_MODEL = 'qwen3-4b-instruct';
process.env.LLAMACPP_ENABLED = 'true';
// Embeddings are exercised separately; retrieval degrades to keyword-only.
process.env.EMBEDDING_ENABLED = 'false';
process.env.RAG_ENABLED = 'false';
process.env.LLM_WORKER_CONCURRENCY = '2';
process.env.MAX_REQUESTS_PER_MINUTE = '4';
process.env.MAX_ACTIVE_REQUESTS_PER_USER = '1';
process.env.SSE_HEARTBEAT_MS = '1000';

let mockLlama;
let apiServer;
let baseUrl;
let mongoose;
let closeRedis;
let stopLlmWorker;
let closeQueue;
let cookies = '';

/** Tokens the mock emits, including a <think> block that must never surface. */
const MOCK_TOKENS = ['<think>', 'hidden ', 'reasoning', '</think>', 'Hello', ' from', ' ATOZAS'];
const EXPECTED_TEXT = 'Hello from ATOZAS';

/** Minimal llama-server stand-in: /health, /props and streaming completions. */
function startMockLlama() {
  return new Promise((resolve) => {
    let slowMode = false;

    const server = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok' }));
      }

      if (req.url === '/props') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 8192 } }));
      }

      if (req.url === '/control/slow') {
        slowMode = true;
        res.writeHead(200);
        return res.end('ok');
      }

      if (req.url.endsWith('/chat/completions')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        let aborted = false;
        req.on('close', () => {
          aborted = true;
        });

        // Slow mode gives the cancellation test time to land mid-stream.
        const delay = slowMode ? 400 : 5;
        const tokens = slowMode ? Array(40).fill('tick ') : MOCK_TOKENS;

        for (const token of tokens) {
          if (aborted) return res.end();
          await new Promise((r) => setTimeout(r, delay));
          res.write(
            `data: ${JSON.stringify({
              model: 'qwen3-4b-instruct',
              choices: [{ index: 0, delta: { content: token } }],
            })}\n\n`,
          );
        }

        res.write(
          `data: ${JSON.stringify({
            model: 'qwen3-4b-instruct',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: tokens.length, total_tokens: 20 + tokens.length },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** Collects SSE frames from a POST/GET until the stream closes. */
async function readSse(response) {
  const frames = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const raw of parts) {
      let event = 'message';
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      try {
        frames.push({ event, data: JSON.parse(dataLines.join('\n')) });
      } catch {
        /* ignore malformed frame */
      }
    }
  }

  return frames;
}

const api = (path, options = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Cookie: cookies, ...(options.headers || {}) },
  });

before(async () => {
  mockLlama = await startMockLlama();

  const [{ createApp }, dbModule, redisModule, workerModule, queueModule, mongooseModule] =
    await Promise.all([
      import('../../src/app.js'),
      import('../../src/config/db.js'),
      import('../../src/config/redis.js'),
      import('../../src/services/queue/llmWorker.js'),
      import('../../src/services/queue/llmQueue.js'),
      import('mongoose'),
    ]);

  mongoose = mongooseModule.default;
  closeRedis = redisModule.closeRedis;
  stopLlmWorker = workerModule.stopLlmWorker;
  closeQueue = queueModule.closeQueue;

  await dbModule.connectDatabase();
  workerModule.startLlmWorker();

  apiServer = http.createServer(createApp());
  apiServer.requestTimeout = 0;
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${apiServer.address().port}`;

  // Auth is passwordless (email OTP / Google), so seed a user directly and mint
  // session cookies with the token helper rather than driving the OTP email flow.
  const [{ User }, tokens] = await Promise.all([
    import('../../src/models/User.js'),
    import('../../src/utils/tokens.js'),
  ]);

  const user = await User.create({
    email: `e2e-${RUN_ID}@atozasai.com`,
    name: 'E2E Tester',
    emailVerified: true,
  });

  cookies = [
    `${tokens.COOKIE_NAMES.access}=${tokens.signAccessToken(user)}`,
    `${tokens.COOKIE_NAMES.refresh}=${tokens.signRefreshToken(user)}`,
  ].join('; ');
  assert.ok(cookies.length > 0, 'expected auth cookies');
});

after(async () => {
  await stopLlmWorker?.().catch(() => {});
  await closeQueue?.().catch(() => {});
  await new Promise((resolve) => apiServer?.close(resolve));
  mockLlama?.close();
  await mongoose?.connection.dropDatabase().catch(() => {});
  await mongoose?.disconnect().catch(() => {});
  await closeRedis?.().catch(() => {});
});

async function newConversation() {
  const res = await api('/api/v1/conversations', { method: 'POST', body: JSON.stringify({}) });
  // Read the body once: a template literal in the assertion message would
  // consume the stream even when the assertion passes.
  const body = await res.json();
  assert.equal(res.status, 201, `create conversation failed: ${JSON.stringify(body)}`);
  return body.data.conversation.id;
}

test('readiness reports the stack is serviceable', async () => {
  const res = await fetch(`${baseUrl}/api/health/ready`);
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body.data?.checks));
  assert.equal(body.data.ready, true);
  assert.equal(body.data.checks.mongo.ok, true);
  assert.equal(body.data.checks.redis.ok, true);
  assert.equal(body.data.checks.inference.ok, true);
});

test('the gateway exposes only self-hosted engines', async () => {
  const res = await api('/api/v1/ai/models');
  const { data } = await res.json();

  assert.ok(data.models.length > 0);
  for (const model of data.models) {
    assert.equal(model.selfHosted, true, `${model.id} is not marked self-hosted`);
    assert.equal(model.costPer1kTokens, 0);
    assert.ok(['llamacpp', 'gpu'].includes(model.provider), `unexpected provider ${model.provider}`);
  }
});

test('a full generation streams queued → started → token → completed', async () => {
  const conversationId = await newConversation();

  const res = await api(`/api/v1/conversations/${conversationId}/stream`, {
    method: 'POST',
    body: JSON.stringify({ content: 'Say hello', clientMessageId: crypto.randomUUID() }),
  });
  assert.equal(res.status, 200);

  const frames = await readSse(res);
  const events = frames.map((f) => f.event);

  assert.ok(events.includes('meta'), 'missing meta');
  assert.ok(events.includes('queued'), 'missing queued');
  assert.ok(events.includes('started'), 'missing started');
  assert.ok(events.includes('token'), 'missing token');
  assert.ok(events.includes('completed'), 'missing completed');

  // Ordering: the client must learn its position before generation begins.
  assert.ok(events.indexOf('queued') < events.indexOf('started'));
  assert.ok(events.indexOf('started') < events.indexOf('token'));

  const text = frames.filter((f) => f.event === 'token').map((f) => f.data.text).join('');
  assert.equal(text, EXPECTED_TEXT);
  // The critical assertion: reasoning must never reach the client.
  assert.ok(!text.includes('hidden'), 'think-block content leaked to the client');
  assert.ok(!text.includes('<think>'), 'think tag leaked to the client');

  const completed = frames.find((f) => f.event === 'completed');
  assert.equal(completed.data.model, 'qwen3-4b-instruct');
  assert.ok(completed.data.stats.totalMs >= 0);
});

test('the assistant reply is persisted with the sanitized text', async () => {
  const conversationId = await newConversation();

  const res = await api(`/api/v1/conversations/${conversationId}/stream`, {
    method: 'POST',
    body: JSON.stringify({ content: 'Persist this', clientMessageId: crypto.randomUUID() }),
  });
  await readSse(res);

  const messagesRes = await api(`/api/v1/conversations/${conversationId}/messages`);
  const { data } = await messagesRes.json();
  const assistant = data.messages.find((m) => m.role === 'assistant');

  assert.ok(assistant, 'assistant message was not persisted');
  assert.equal(assistant.status, 'complete');
  assert.equal(assistant.content, EXPECTED_TEXT);
  assert.ok(!assistant.content.includes('hidden'));
});

test('the same clientMessageId does not produce a duplicate user message', async () => {
  const conversationId = await newConversation();
  const clientMessageId = crypto.randomUUID();

  for (let i = 0; i < 2; i += 1) {
    const res = await api(`/api/v1/conversations/${conversationId}/stream`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Idempotent send', clientMessageId }),
    });
    await readSse(res);
  }

  const messagesRes = await api(`/api/v1/conversations/${conversationId}/messages`);
  const { data } = await messagesRes.json();
  const userMessages = data.messages.filter((m) => m.role === 'user');

  assert.equal(userMessages.length, 1, 'retry created a duplicate user message');
});

test('stop generation cancels the running job', async () => {
  // Switch the mock into slow mode so cancellation lands mid-stream.
  await fetch(`http://127.0.0.1:${MOCK_PORT}/control/slow`);

  const conversationId = await newConversation();
  const res = await api(`/api/v1/conversations/${conversationId}/stream`, {
    method: 'POST',
    body: JSON.stringify({ content: 'Long answer please', clientMessageId: crypto.randomUUID() }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let jobId = null;
  let sawToken = false;

  // Read until tokens are flowing, then ask the server to stop.
  while (!sawToken || !jobId) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const metaMatch = /"jobId":"(gen-[^"]+)"/.exec(buffer);
    if (metaMatch) jobId = metaMatch[1];
    if (buffer.includes('event: token')) sawToken = true;
  }

  assert.ok(jobId, 'never received a jobId');
  assert.ok(sawToken, 'never received a token');

  const cancelRes = await api(`/api/v1/conversations/${conversationId}/stream/${jobId}/cancel`, {
    method: 'POST',
  });
  assert.equal(cancelRes.status, 200);
  const cancelBody = await cancelRes.json();
  assert.equal(cancelBody.data.cancelled, true);

  // Drain the rest of the stream and confirm it terminated as cancelled.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  assert.ok(buffer.includes('event: cancelled'), 'stream did not end with a cancelled event');

  const messagesRes = await api(`/api/v1/conversations/${conversationId}/messages`);
  const { data } = await messagesRes.json();
  const assistant = data.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.status, 'stopped', 'partial reply was not marked stopped');
});

test('per-minute rate limiting returns 429 once the quota is spent', async () => {
  const conversationId = await newConversation();
  let sawRateLimit = false;

  // MAX_REQUESTS_PER_MINUTE is 4 for this run; the earlier tests already
  // consumed part of the window, so a handful of attempts is enough.
  for (let i = 0; i < 8; i += 1) {
    const res = await api(`/api/v1/conversations/${conversationId}/stream`, {
      method: 'POST',
      body: JSON.stringify({ content: `Burst ${i}`, clientMessageId: crypto.randomUUID() }),
    });

    if (res.status === 429) {
      const body = await res.json();
      assert.equal(body.error.code, 'RATE_LIMITED');
      sawRateLimit = true;
      break;
    }
    // Consume the stream so the active-request slot is released.
    await readSse(res);
  }

  assert.ok(sawRateLimit, 'expected a 429 after exceeding the per-minute quota');
});

// Runs last: it takes llama-server away for good.
test('an inference outage is refused with 503 before anything is queued', async () => {
  const conversationId = await newConversation();

  // closeAllConnections first, otherwise close() waits on undici's pooled
  // keep-alive sockets and never resolves.
  mockLlama.closeAllConnections?.();
  await new Promise((resolve) => mockLlama.close(resolve));
  mockLlama = null;

  // Drop the cached healthy verdict so the gate re-probes immediately instead
  // of making the test sit out the TTL.
  const { resetInferenceAvailability } = await import('../../src/services/health/probes.js');
  resetInferenceAvailability();

  const res = await api(`/api/v1/conversations/${conversationId}/stream`, {
    method: 'POST',
    body: JSON.stringify({ content: 'Anyone home?', clientMessageId: crypto.randomUUID() }),
  });

  assert.equal(res.status, 503, 'an outage must be refused, not turned into a broken stream');
  const body = await res.json();
  assert.equal(body.error.code, 'INFERENCE_UNAVAILABLE');

  // A request that was never admitted must not leave rows behind.
  const messagesRes = await api(`/api/v1/conversations/${conversationId}/messages`);
  const { data } = await messagesRes.json();
  assert.equal(data.messages.length, 0, 'a refused request persisted orphan messages');

  // Readiness must agree with what the chat endpoint just told the user.
  const readyRes = await fetch(`${baseUrl}/api/health/ready`);
  assert.equal(readyRes.status, 503);
});
