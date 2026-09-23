import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';
import { createServer as createMcpServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';
import { startFixture } from './fixture.mjs';

const options = { channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true, recordVideo: true };

test('opt-in recording returns a finalized real WebM artifact when a session closes', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine(options);
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url);
  const destination = opened.elements.find(element => element.name === 'Destination');
  assert.ok(destination);
  const action = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'fill', ref: destination.ref, value: 'Lisbon' }]);
  assert.equal(action.ok, true);
  const closed = await engine.close(opened.session_id);
  assert.equal(closed.ok, true);
  assert.equal(closed.recordings.length, 1);
  const [recording] = closed.recordings;
  assert.equal(recording.session_id, opened.session_id);
  assert.equal(recording.tab_id, opened.tab_id);
  assert.equal(recording.mime_type, 'video/webm');
  const bytes = await readFile(recording.path);
  assert.equal(recording.bytes, bytes.length);
  assert.ok(bytes.length > 100);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3');
  assert.equal(recording.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await stat(recording.path)).mode & 0o777, 0o600);
  assert.deepEqual(engine.recordings(), closed.recordings);
});

test('dispose finalizes recordings for Agent runs that do not call tab_close', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine(options);
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url);
  await engine.dispose();
  const [recording] = engine.recordings();
  assert.equal(recording.session_id, opened.session_id);
  assert.ok((await stat(recording.path)).size > 100);
});

test('MCP tab_close exposes the finalized recording without inline video data', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const runtime = createMcpServer(options);
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); await fixture.close(); });
  const call = async (name, args) => (await connection.client.callTool({ name, arguments: args })).structuredContent;
  const opened = await call('tab_open', { url: fixture.url });
  assert.equal(opened.ok, true);
  const closed = await call('tab_close', { session_id: opened.session_id });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.recordings.length, 1);
  assert.ok((await stat(closed.recordings[0].path)).size > 100);
  assert.equal(JSON.stringify(closed).includes('base64'), false);
});

test('one owned session records each tab separately', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine(options);
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url);
  const second = await engine.tabs(opened.session_id, { action: 'new', url: `${fixture.url}/results?destination=Lisbon` });
  assert.equal(second.ok, true);
  const closed = await engine.close(opened.session_id);
  assert.deepEqual(closed.recordings.map(recording => recording.tab_id).sort(), ['t1', 't2']);
  assert.notEqual(closed.recordings[0].path, closed.recordings[1].path);
  for (const recording of closed.recordings) assert.ok((await stat(recording.path)).size > 100);
});

test('recording is unavailable for attached/persistent contexts and protected secrets', () => {
  assert.throws(() => new BrowserEngine({ cdpUrl: 'http://localhost:9222', recordVideo: true }), { code: 'RECORDING_CONTEXT_UNSUPPORTED' });
  assert.throws(() => new BrowserEngine({ recordVideo: 'yes' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => new BrowserEngine({ profileDir: '/tmp/tablaze-recording-test-profile', recordVideo: true }), { code: 'RECORDING_CONTEXT_UNSUPPORTED' });
  assert.throws(() => new BrowserEngine({ recordVideo: true, secrets: { contextId: 'recording-test', secrets: [] } }), { code: 'SECRET_ARTIFACT_BLOCKED' });
});
