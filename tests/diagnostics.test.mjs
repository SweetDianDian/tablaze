import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

function zipEntries(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  assert.ok(end >= 0, 'ZIP central directory must exist.');
  const entries = new Map();
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0, count = bytes.readUInt16LE(end + 10); i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(dataStart, dataStart + compressed);
    entries.set(name, method === 8 ? inflateRawSync(data) : method === 0 ? data : assert.fail(`Unsupported ZIP method ${method}`));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
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
  assert.equal(har.content_mode, 'omit');
  assert.equal(har.har_mode, 'full');
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

test('explicit HAR embed and attach modes retain actual response bodies in private artifacts', { timeout: 30_000 }, async t => {
  const marker = 'TABLAZE_PRIVATE_HAR_BODY_FIXTURE';
  const http = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>HAR mode target</title><p>${marker}</p>`);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  for (const content of ['embed', 'attach']) {
    const engine = new BrowserEngine({ channel, headless: true, recordHar: true, recordHarContent: content, recordHarMode: 'minimal' });
    t.after(() => engine.dispose());
    const opened = await engine.open(`http://127.0.0.1:${http.address().port}/${content}`);
    const closed = await engine.close(opened.session_id);
    const artifact = closed.diagnostics[0];
    assert.equal(artifact.kind, 'har');
    assert.equal(artifact.content_mode, content);
    assert.equal(artifact.har_mode, 'minimal');
    assert.equal(artifact.mime_type, content === 'attach' ? 'application/zip' : 'application/json');
    const bytes = await inspectArtifact(artifact);
    const entries = content === 'attach' ? zipEntries(bytes) : undefined;
    const harFile = entries ? [...entries].find(([name]) => name.endsWith('.har'))?.[1] : undefined;
    if (entries) assert.ok(harFile, 'Attached ZIP must contain a HAR manifest.');
    const har = JSON.parse((harFile ?? bytes).toString('utf8'));
    const response = har.log.entries.find(entry => entry.request.url.endsWith(`/${content}`))?.response;
    assert.equal(response?.status, 200);
    if (content === 'embed') assert.match(response.content.text, new RegExp(marker));
    else {
      const attached = entries.get(response.content._file);
      assert.ok(attached, `HAR response attachment ${response.content._file} must exist in the ZIP.`);
      assert.match(attached.toString('utf8'), new RegExp(marker));
    }
    assert.equal(JSON.stringify(closed).includes(marker), false, 'Body content stays out of tool-visible metadata.');
  }
});

test('CLI stdio MCP exports an attached HAR ZIP without putting response bodies in tool output', { timeout: 30_000 }, async t => {
  const marker = 'TABLAZE_CLI_HAR_BODY_FIXTURE';
  const http = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>CLI HAR target</title><p>${marker}</p>`);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--channel', channel || 'chromium', '--record-har', '--har-content', 'attach', '--har-mode', 'minimal'], stderr: 'pipe' });
  const client = new Client({ name: 'har-mode-cli-test', version: '1' });
  t.after(async () => { await client.close(); await new Promise(resolve => http.close(resolve)); });
  await client.connect(transport);
  const opened = (await client.callTool({ name: 'tab_open', arguments: { url: `http://127.0.0.1:${http.address().port}/cli-har` } })).structuredContent;
  const closed = (await client.callTool({ name: 'tab_close', arguments: { session_id: opened.session_id } })).structuredContent;
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.diagnostics.length, 1);
  assert.equal(closed.diagnostics[0].content_mode, 'attach');
  assert.equal(closed.diagnostics[0].har_mode, 'minimal');
  assert.equal(closed.diagnostics[0].mime_type, 'application/zip');
  assert.equal(JSON.stringify(closed).includes(marker), false);
  const files = zipEntries(await inspectArtifact(closed.diagnostics[0]));
  const manifest = [...files].find(([name]) => name.endsWith('.har'))?.[1];
  assert.ok(manifest);
  const response = JSON.parse(manifest.toString('utf8')).log.entries.find(entry => entry.request.url.endsWith('/cli-har'))?.response;
  assert.equal(response?.status, 200);
  assert.match(files.get(response.content._file).toString('utf8'), new RegExp(marker));
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
  for (const recordHarContent of ['bad', null]) assert.throws(() => new BrowserEngine({ recordHar: true, recordHarContent }), { code: 'INVALID_ARGUMENT' });
  for (const recordHarMode of ['bad', null]) assert.throws(() => new BrowserEngine({ recordHar: true, recordHarMode }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => new BrowserEngine({ recordHarContent: 'embed' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => new BrowserEngine({ recordHarMode: 'minimal' }), { code: 'INVALID_ARGUMENT' });
});

test('CLI doctor reports diagnostic selection and rejects unsupported modes', () => {
  const output = JSON.parse(execFileSync(process.execPath, ['dist/cli.js', 'doctor', '--record-har', '--record-trace'], { encoding: 'utf8' }));
  assert.equal(output.record_har, true);
  assert.equal(output.record_trace, true);
  assert.equal(output.har_content, 'omit');
  assert.equal(output.har_mode, 'full');
  const detailed = JSON.parse(execFileSync(process.execPath, ['dist/cli.js', 'doctor', '--record-har', '--har-content', 'attach', '--har-mode', 'minimal'], { encoding: 'utf8' }));
  assert.equal(detailed.har_content, 'attach');
  assert.equal(detailed.har_mode, 'minimal');
  for (const flags of [
    ['--har-content', 'embed'], ['--har-mode', 'minimal'], ['--record-har', '--har-content', 'bad'], ['--record-har', '--har-mode', 'bad'],
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
