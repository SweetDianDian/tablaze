import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createCodexTransport } from './codex-transport.mjs';

/** Both adapters use this gateway so the recorded inference settings are equal. */
export async function startModelGateway(config) {
  const codex = config.transport === 'codex' ? createCodexTransport(config) : null;
  const endpoint = codex ? null : new URL(config.endpoint);
  if (endpoint && (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)) throw new Error('Use an HTTP(S) endpoint without URL credentials, query, or fragment');
  const metrics = { calls: 0, failedCalls: 0, timeMs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usageComplete: true, cachedUsageComplete: true, transportRequests: [], errors: [] };
  const pending = new Set(), controllers = new Set();
  const recordUsage = usage => {
    if (Number.isInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) {
      metrics.inputTokens += usage.prompt_tokens;
      metrics.outputTokens += usage.completion_tokens;
      if (Number.isInteger(usage.prompt_tokens_details?.cached_tokens)) metrics.cachedTokens += usage.prompt_tokens_details.cached_tokens;
      else metrics.cachedUsageComplete = false;
    } else metrics.usageComplete = false;
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    const start = performance.now();
    let dispatched = false;
    const abort = new AbortController();
    controllers.add(abort);
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    pending.add(done);
    response.once('close', () => { if (!response.writableEnded) abort.abort(); });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error('Model request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      body.model = config.model;
      body.stream = false;
      // Keep framework prompts and response schemas, but equalize inference and
      // token ceilings at the wire. Neither adapter can silently select a model.
      for (const key of ['temperature', 'reasoning_effort', 'frequency_penalty', 'presence_penalty', 'top_p', 'seed', 'service_tier', 'max_tokens', 'max_completion_tokens']) delete body[key];
      if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
      else body.temperature = config.temperature ?? 0;
      body.max_completion_tokens = config.maxOutputTokens ?? 4096;
      if (!metrics.usageComplete && config.tokenBudget || metrics.inputTokens + metrics.outputTokens >= (config.tokenBudget ?? Infinity)) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Run token budget reached or usage is unavailable for further enforcement.' } })); return;
      }
      metrics.calls++;
      dispatched = true;
      let raw, status, contentType;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.timeoutMs ?? 120000)]);
      if (codex) {
        const { comparison_transport, ...completion } = await codex.complete(body, { signal });
        metrics.transportRequests.push(comparison_transport);
        raw = JSON.stringify(completion); status = 200; contentType = 'application/json';
      } else {
        const upstream = await fetch(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
          body: JSON.stringify(body), signal,
        });
        raw = await upstream.text(); status = upstream.status; contentType = upstream.headers.get('content-type') ?? 'application/json';
      }
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('Model response too large');
      if (status < 200 || status >= 300) metrics.failedCalls++;
      let usage;
      try { usage = JSON.parse(raw).usage; } catch { /* Preserve provider error payload. */ }
      recordUsage(usage);
      response.writeHead(status, { 'content-type': contentType });
      response.end(raw);
    } catch (error) {
      metrics.failedCalls++;
      if (dispatched) recordUsage(error.usage);
      metrics.errors.push({ code: typeof error.code === 'string' ? error.code : 'GATEWAY_FAILED', ...(error.metadata ? { metadata: error.metadata } : {}) });
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Benchmark model gateway failed; see attempt metrics.', code: typeof error.code === 'string' ? error.code : 'GATEWAY_FAILED' } }));
    } finally { metrics.timeMs += performance.now() - start; controllers.delete(abort); pending.delete(done); settle(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    metrics,
    async close() { for (const abort of controllers) abort.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...pending]); },
  };
}
