import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';
import { startTaskService } from '../bench/comparison/fixture.mjs';

test('a canvas-only first observation includes a usable MCP image without a second capture call', { timeout: 30_000 }, async t => {
  const service = await startTaskService();
  const canvas = await service.createAttempt('canvas', 82);
  const form = await service.createAttempt('form', 82);
  const runtime = createServer({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); await service.close(); });

  const visual = await connection.client.callTool({ name: 'tab_open', arguments: { url: canvas.url } });
  const opened = visual.structuredContent;
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(opened.visual_content, { canvas_in_viewport: true });
  assert.deepEqual(opened.elements, []);
  const image = visual.content.find(item => item.type === 'image');
  assert.ok(image, 'The image must be delivered as an MCP image block.');
  assert.equal(image.mimeType, 'image/jpeg');
  const bytes = Buffer.from(image.data, 'base64');
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.equal(opened.initial_capture.bytes, bytes.length);
  assert.equal(opened.initial_capture.coordinate_space, 'viewport-css');
  assert.equal(opened.initial_capture.tab_id, opened.tab_id);
  assert.equal(opened.initial_capture.url, opened.url);
  const acted = (await connection.client.callTool({ name: 'tab_act', arguments: { session_id: opened.session_id, snapshot_id: opened.snapshot_id, actions: [{ type: 'click_xy', x: 220, y: 130 }] } })).structuredContent;
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal((await canvas.judge()).passed, true, 'A viewport-CSS click derived from this image must reach the real canvas target.');

  const ordinary = await connection.client.callTool({ name: 'tab_open', arguments: { url: form.url } });
  assert.equal(ordinary.structuredContent.ok, true);
  assert.ok(ordinary.structuredContent.elements.length > 0);
  assert.equal(ordinary.content.some(item => item.type === 'image'), false, 'Ordinary forms do not incur an automatic screenshot.');
  assert.equal(ordinary.structuredContent.initial_capture, undefined);
});

test('cancelling the automatic first image closes only its opening session', { timeout: 30_000 }, async t => {
  const service = await startTaskService();
  const canvas = await service.createAttempt('canvas', 83);
  const runtime = createServer({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true });
  const connection = await connectAgentTools(runtime.server);
  let releaseCapture;
  const released = new Promise(resolve => { releaseCapture = resolve; });
  t.after(async () => { releaseCapture(); await connection.close(); await runtime.dispose(); await service.close(); });
  const sibling = await runtime.engine.open((await service.createAttempt('form', 83)).url);
  const original = runtime.engine.screenshot.bind(runtime.engine);
  let enteredCapture;
  const entered = new Promise(resolve => { enteredCapture = resolve; });
  runtime.engine.screenshot = async (...args) => { const image = await original(...args); enteredCapture(); await released; return image; };
  const controller = new AbortController();
  const pending = connection.client.callTool({ name: 'tab_open', arguments: { url: canvas.url } }, undefined, { signal: controller.signal });
  const rejection = assert.rejects(pending, /abort|cancel/i);
  await entered;
  controller.abort();
  await rejection;
  releaseCapture();
  const deadline = Date.now() + 3000;
  while (runtime.engine.list().length !== 1 && Date.now() < deadline) await delay(10);
  assert.deepEqual(runtime.engine.list().map(item => item.session_id), [sibling.session_id]);
});
