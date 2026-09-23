import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';

test('initial open observes a delayed child frame without a second model round', { timeout: 30_000 }, async t => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/frame') {
      setTimeout(() => response.end('<!doctype html><label>Frame note<input id="note"></label><button>Save note</button>'), 250);
      return;
    }
    response.end('<!doctype html><title>Frame host</title><iframe title="Editor" src="/frame"></iframe>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true });
  t.after(async () => { await engine.dispose(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const opened = await engine.open(`${origin}/`);
  const frame = opened.frames.find(item => item.url === `${origin}/frame`);
  assert.ok(frame, JSON.stringify(opened.frames));
  const child = await engine.snapshot(opened.session_id, { frameId: frame.frame_id });
  assert.ok(child.elements.some(item => item.name === 'Frame note'), JSON.stringify(child.elements));
  assert.ok(child.elements.some(item => item.name === 'Save note'));
});
