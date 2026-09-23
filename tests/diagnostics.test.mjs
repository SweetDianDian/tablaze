import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';
import { createServer as createMcpServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';
import { startFixture } from './fixture.mjs';

const channel = process.env.TABLAZE_BROWSER_CHANNEL || undefined;
const options = { channel, headless: true, recordHar: true, recordTrace: true };

async function inspectArtifact(artifact) {
  const bytes = await readFile(artifact.path);
  assert.equal(artifact.bytes, bytes.length);
  assert.ok(bytes.length > 100);
  assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
  return bytes;
}

test('owned Chrome session exports a real HAR and Playwright trace after a browser action', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine(options);
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url);
  const destination = opened.elements.find(element => element.name === 'Destination');
  assert.ok(destination);
  const acted = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'fill', ref: destination.ref, value: 'Lisbon' }]);
  assert.equal(acted.ok, true);
  const closed = await engine.close(opened.session_id);
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.diagnostics.map(item => item.kind).sort(), ['har', 'trace']);
  const har = closed.diagnostics.find(item => item.kind === 'har');
  const trace = closed.diagnostics.find(item => item.kind === 'trace');
  assert.equal(har.session_id, opened.session_id);
  assert.equal(har.mime_type, 'application/json');
  const harBytes = await inspectArtifact(har);
  const parsed = JSON.parse(harBytes.toString('utf8'));
  assert.equal(parsed.log.version, '1.2');
  assert.ok(parsed.log.entries.some(entry => entry.request.url === new URL(fixture.url).href && entry.response.status === 200));
  assert.ok(parsed.log.entries.every(entry => !('text' in entry.response.content)), 'HAR must omit response bodies by default');
  assert.equal(trace.mime_type, 'application/zip');
  const traceBytes = await inspectArtifact(trace);
  assert.equal(traceBytes.subarray(0, 4).toString('hex'), '504b0304');
  assert.deepEqual(engine.diagnostics(), closed.diagnostics);
});

test('dispose finalizes diagnostics for an Agent run without tab_close', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine(options);
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url);
  await engine.dispose();
  assert.deepEqual(engine.diagnostics().map(item => item.kind).sort(), ['har', 'trace']);
  for (const artifact of engine.diagnostics()) {
    assert.equal(artifact.session_id, opened.session_id);
    await inspectArtifact(artifact);
  }
});

test('MCP tab_close returns diagnostic metadata without inlining artifact bytes', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const runtime = createMcpServer(options);
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); await fixture.close(); });
  const call = async (name, args) => (await connection.client.callTool({ name, arguments: args })).structuredContent;
  const opened = await call('tab_open', { url: fixture.url });
  const closed = await call('tab_close', { session_id: opened.session_id });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.diagnostics.length, 2);
  assert.equal(JSON.stringify(closed).includes('base64'), false);
  for (const artifact of closed.diagnostics) await inspectArtifact(artifact);
});

test('diagnostics require a fresh owned context and explicit permission with configured secrets', () => {
  for (const option of ['recordHar', 'recordTrace']) {
    assert.throws(() => new BrowserEngine({ [option]: 'yes' }), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => new BrowserEngine({ cdpUrl: 'http://localhost:9222', [option]: true }), { code: 'DIAGNOSTIC_CONTEXT_UNSUPPORTED' });
    assert.throws(() => new BrowserEngine({ profileDir: '/tmp/tablaze-diagnostic-test-profile', [option]: true }), { code: 'DIAGNOSTIC_CONTEXT_UNSUPPORTED' });
    assert.throws(() => new BrowserEngine({ [option]: true, secrets: { contextId: 'diagnostic-test', secrets: [] } }), { code: 'SECRET_ARTIFACT_BLOCKED' });
  }
});

test('CLI doctor reports diagnostic selection and rejects unsupported modes', () => {
  const output = JSON.parse(execFileSync(process.execPath, ['dist/cli.js', 'doctor', '--record-har', '--record-trace'], { encoding: 'utf8' }));
  assert.equal(output.record_har, true);
  assert.equal(output.record_trace, true);
  for (const flags of [
    ['--cdp-url', 'http://localhost:9222', '--record-har'],
    ['--cdp-url', 'http://localhost:9222', '--record-trace'],
    ['--profile-dir', '/tmp/tablaze-diagnostic-test-profile', '--record-har'],
    ['--profile-dir', '/tmp/tablaze-diagnostic-test-profile', '--record-trace'],
  ]) {
    const result = spawnSync(process.execPath, ['dist/cli.js', 'doctor', ...flags], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, flags.join(' '));
    assert.equal(result.stdout, '');
  }
});
