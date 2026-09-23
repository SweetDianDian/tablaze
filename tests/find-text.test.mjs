import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';
import { createServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';
import { startFixture } from './fixture.mjs';

const containerRef = snapshot => {
  const entry = snapshot.elements.find(item => item.name === 'Virtual results' && item.scrollable?.y);
  assert.ok(entry, JSON.stringify(snapshot.elements));
  return entry.ref;
};

test('find traverses actual virtualized rows and returns a fresh actionable viewport ref', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url + '/virtual');
  const page = engine.sessions.get(opened.session_id).page;
  assert.equal(await page.getByText('VIRTUAL-130').count(), 0, 'the target must not exist in the initial DOM');
  const ref = containerRef(opened);
  const short = await engine.findText(opened.session_id, { text: 'VIRTUAL-130', containerRef: ref, snapshotId: opened.snapshot_id, maxScrolls: 2 });
  assert.equal(short.found, false);
  assert.equal(short.limit_reached, true);
  assert.equal(short.scrolls, 2);
  assert.equal(await page.locator('#virtual-status').textContent(), 'No reservation');
  await assert.rejects(engine.findText(opened.session_id, { text: 'VIRTUAL-130', containerRef: ref, snapshotId: opened.snapshot_id }), { code: 'STALE_SNAPSHOT' });

  const result = await engine.findText(opened.session_id, { text: 'VIRTUAL-130', containerRef: containerRef(short.snapshot), snapshotId: short.snapshot.snapshot_id, maxScrolls: 60 });
  assert.equal(result.found, true, JSON.stringify({ scrolls: result.scrolls, reached_end: result.reached_end }));
  assert.ok(result.scrolls > 0);
  const button = result.snapshot.elements.find(item => item.name === 'Reserve VIRTUAL-130');
  assert.ok(button, 'the returned viewport snapshot must include a usable target ref');
  const clicked = await engine.act(opened.session_id, result.snapshot.snapshot_id, [{ type: 'click', ref: button.ref }]);
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  assert.equal((await engine.verify(opened.session_id, [{ kind: 'text', contains: 'Reserved VIRTUAL-130' }])).passed, true);
});

test('MCP find supports a selected iframe and preserves current snapshot semantics', { timeout: 20_000 }, async t => {
  const fixture = await startFixture();
  const runtime = createServer({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); await fixture.close(); });
  const call = async (name, args) => (await connection.client.callTool({ name, arguments: args })).structuredContent;
  const opened = await call('tab_open', { url: fixture.url + '/lab?token=find-frame' });
  let observed = opened, frame;
  for (let index = 0; index < 20 && !frame; index++) {
    frame = observed.frames.find(item => !item.is_main && item.url.endsWith('/frame'));
    if (!frame) { await new Promise(resolve => setTimeout(resolve, 25)); observed = await call('tab_snapshot', { session_id: opened.session_id }); }
  }
  assert.ok(frame, JSON.stringify(observed.frames));
  const found = await call('tab_find', { session_id: opened.session_id, text: 'Frame action', frame_id: frame.frame_id, max_scrolls: 0 });
  assert.equal(found.found, true, JSON.stringify(found));
  assert.equal(found.snapshot.frame_id, frame.frame_id);
  const target = found.snapshot.elements.find(item => item.name === 'Frame action');
  assert.ok(target);
  const clicked = await call('tab_act', { session_id: opened.session_id, snapshot_id: found.snapshot.snapshot_id, actions: [{ type: 'click', ref: target.ref }] });
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  assert.match(clicked.snapshot.text, /Frame complete/);
});
