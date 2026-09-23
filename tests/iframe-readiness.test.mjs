import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';

test('initial open observes a delayed child frame without a second model round', { timeout: 30_000 }, async t => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/frame') {
      setTimeout(() => response.end('<!doctype html><label>Frame note<input id="note"></label><button onclick="document.querySelector(\'#status\').textContent=\'Saved \'+document.querySelector(\'#note\').value">Save note</button><p id="status">Ready</p>'), 250);
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
  assert.equal(opened.frame_id, frame.frame_id, JSON.stringify(opened));
  assert.equal(opened.frame_selection.reason, 'single_actionable_child');
  assert.ok(opened.elements.some(item => item.name === 'Frame note'), JSON.stringify(opened.elements));
  assert.ok(opened.elements.some(item => item.name === 'Save note'));
  const input = opened.elements.find(item => item.name === 'Frame note');
  const button = opened.elements.find(item => item.name === 'Save note');
  const acted = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'fill', ref: input.ref, value: 'Vega' }, { type: 'click', ref: button.ref }]);
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal(acted.snapshot.frame_id, frame.frame_id);
  assert.match(acted.snapshot.text, /Saved Vega/);
});

test('initial frame selection stays on the parent when it has controls or children are ambiguous or hidden', { timeout: 30_000 }, async t => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/frame') response.end('<!doctype html><label>Child field<input></label>');
    else if (request.url === '/button') response.end('<!doctype html><button>Child action</button>');
    else if (request.url === '/main-control') response.end('<!doctype html><button>Main action</button><iframe src="/frame"></iframe>');
    else if (request.url === '/two') response.end('<!doctype html><iframe src="/frame"></iframe><iframe src="/frame"></iframe>');
    else if (request.url === '/button-only') response.end('<!doctype html><iframe src="/button"></iframe>');
    else response.end('<!doctype html><iframe src="/frame" style="display:none"></iframe>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true });
  t.after(async () => { await engine.dispose(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/main-control', '/two', '/hidden', '/button-only']) {
    const opened = await engine.open(origin + path);
    assert.equal(opened.frame_id, 'f0', path);
    assert.equal(opened.frame_selection, undefined, path);
    if (path === '/main-control') assert.ok(opened.elements.some(item => item.name === 'Main action'));
  }
});
