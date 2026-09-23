import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { createServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';

test('failed post-check feedback keeps the operated child frame for immediate replanning', { timeout: 30_000 }, async t => {
  const http = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/frame') {
      response.end('<!doctype html><label>Frame note<input id="note"></label><button onclick="document.querySelector(\'#status\').textContent=\'Saved successfully\'">Save note</button><p id="status">Ready</p>');
      return;
    }
    response.end('<!doctype html><iframe title="Editor" src="/frame"></iframe>');
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const runtime = createServer({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); await new Promise(resolve => http.close(resolve)); });
  const call = async (name, args) => (await connection.client.callTool({ name, arguments: args })).structuredContent;
  const origin = `http://127.0.0.1:${http.address().port}`;
  const opened = await call('tab_open', { url: `${origin}/` });
  const frame = opened.frames.find(item => item.url === `${origin}/frame`);
  assert.ok(frame, JSON.stringify(opened.frames));
  const observed = await call('tab_snapshot', { session_id: opened.session_id, frame_id: frame.frame_id });
  const note = observed.elements.find(item => item.name === 'Frame note');
  const save = observed.elements.find(item => item.name === 'Save note');
  assert.ok(note && save);
  const acted = await call('tab_act', { session_id: opened.session_id, snapshot_id: observed.snapshot_id, actions: [{ type: 'fill', ref: note.ref, value: 'Vega' }, { type: 'click', ref: save.ref }], post_checks: [{ kind: 'value', ref: note.ref, value: 'Vega' }, { kind: 'text', contains: 'Saved successfully' }, { kind: 'text', contains: 'Vega' }], verify_timeout_ms: 100, include_snapshot: true });
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal(acted.verification.passed, false);
  assert.deepEqual(acted.verification.checks.map(check => check.pass), [true, true, false]);
  assert.equal(acted.replan_required, true);
  assert.equal(acted.action_frame_id, frame.frame_id);
  assert.equal(acted.snapshot.frame_id, frame.frame_id);
  assert.ok(acted.snapshot.elements.some(item => item.name === 'Frame note'));
  assert.match(acted.snapshot.text, /Saved successfully/);
});
