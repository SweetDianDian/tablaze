import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const toolNames = ["tab_act", "tab_capture", "tab_click_named", "tab_close", "tab_dialog", "tab_downloads", "tab_extract", "tab_extract_structured", "tab_find", "tab_list", "tab_navigate", "tab_open", "tab_pdf", "tab_snapshot", "tab_state", "tab_tabs", "tab_verify"];

async function connect(args = []) {
  const env = {};
  for (const key of ["TABLAZE_BROWSER_CHANNEL", "TABLAZE_EXECUTABLE_PATH", "PLAYWRIGHT_BROWSERS_PATH"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ...args], cwd: root, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: "tablaze-protocol-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

function data(response) {
  assert.ok(response.structuredContent, "tool response carries structured content");
  const text = response.content.find(item => item.type === "text");
  assert.ok(text, "tool response includes a JSON text fallback");
  assert.deepEqual(JSON.parse(text.text), response.structuredContent);
  return response.structuredContent;
}

test("stdio handshake exposes the bounded browser tools and structured session errors", { timeout: 20_000 }, async t => {
  const connection = await connect();
  t.after(() => connection.client.close());
  const listed = await connection.client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), toolNames);
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.equal(tool.annotations.readOnlyHint, !["tab_open", "tab_act", "tab_click_named", "tab_close", "tab_find", "tab_navigate", "tab_tabs", "tab_dialog", "tab_state", "tab_pdf"].includes(tool.name));
  }
  const list = data(await connection.client.callTool({ name: "tab_list", arguments: {} }));
  assert.equal(list.ok, true);
  assert.deepEqual(list.sessions, []);
  const missing = await connection.client.callTool({ name: "tab_snapshot", arguments: { session_id: "does-not-exist" } });
  assert.equal(missing.isError, true);
  const missingData = data(missing);
  assert.equal(missingData.ok, false);
  assert.equal(typeof missingData.error.code, "string");
  assert.ok(missingData.error.code.length > 0);
  const invalidRequests = [
    { name: "tab_open", arguments: { url: 42 } },
    { name: "tab_snapshot", arguments: { session_id: "x", max_elements: 501 } },
    { name: "tab_snapshot", arguments: { session_id: "x", surprise: true } },
    { name: "tab_find", arguments: { session_id: "x", text: "", max_scrolls: 101 } },
    { name: "tab_act", arguments: { session_id: "x", snapshot_id: "s", actions: [] } },
    { name: "tab_act", arguments: { session_id: "x", snapshot_id: "s", actions: Array.from({ length: 21 }, () => ({ type: "click", ref: "r1" })) } },
    { name: "tab_act", arguments: { session_id: "x", snapshot_id: "s", actions: [{ type: "evaluate", script: "alert(1)" }] } },
    { name: "tab_act", arguments: { session_id: "x", snapshot_id: "s", actions: [{ type: "click", ref: "r1" }], timeout_ms: 60_001 } },
    { name: "tab_verify", arguments: { session_id: "x", checks: [{ kind: "text", contains: "hi" }], timeout_ms: 60_001 } },
  ];
  for (const request of invalidRequests) {
    const response = await connection.client.callTool(request);
    assert.equal(response.isError, true, `invalid ${request.name} input is rejected`);
  }
  assert.equal(connection.stderr(), "", "normal MCP calls do not log arguments or non-protocol noise");
});

test("stdio tools drive isolated Chromium and return browser evidence", { timeout: 60_000 }, async t => {
  const fixture = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>Tablaze protocol fixture</title></head><body>
      <h1>Protocol fixture</h1><label>Name <input aria-label="Name" id="name"></label>
      <button id="save" onclick="document.querySelector('#status').textContent = 'Saved ' + document.querySelector('#name').value">Save</button>
      <p id="status" role="status">Ready</p><a href="/details">Details</a>
      <table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>2</td></tr></tbody></table>
      </body></html>`);
  });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const connection = await connect();
  t.after(() => connection.client.close());
  const call = (name, args) => connection.client.callTool({ name, arguments: args });
  const opened = await call("tab_open", { url: `http://127.0.0.1:${fixture.address().port}/` });
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  const snapshot = data(opened);
  assert.equal(typeof snapshot.session_id, "string");
  assert.equal(typeof snapshot.snapshot_id, "string");
  const input = snapshot.elements.find(element => element.role === "textbox" && element.name === "Name");
  const save = snapshot.elements.find(element => element.role === "button" && element.name === "Save");
  assert.ok(input, "snapshot exposes the input reference");
  assert.ok(save, "snapshot exposes the button reference");
  const acted = data(await call("tab_act", { session_id: snapshot.session_id, snapshot_id: snapshot.snapshot_id, actions: [{ type: "fill", ref: input.ref, value: "Ada" }, { type: "click", ref: save.ref }], include_snapshot: true }));
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal(acted.completed, 2);
  assert.ok(acted.snapshot);
  const verified = data(await call("tab_verify", { session_id: snapshot.session_id, checks: [{ kind: "title", contains: "Tablaze protocol" }, { kind: "text", contains: "Saved Ada" }, { kind: "value", selector: "#name", value: "Ada" }], timeout_ms: 2_000 }));
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.passed, true);
  assert.equal(verified.checks.length, 3);
  const extracted = data(await call("tab_extract", { session_id: snapshot.session_id, kind: "links", max_items: 5 }));
  assert.equal(extracted.ok, true);
  assert.ok(extracted.items.length >= 1);
  const captured = await call("tab_capture", { session_id: snapshot.session_id, full_page: false });
  const metadata = data(captured);
  const image = captured.content.find(item => item.type === "image");
  assert.ok(image);
  assert.equal(metadata.mime_type, image.mimeType);
  assert.equal(Buffer.from(image.data, "base64").byteLength, metadata.bytes);
  assert.ok(metadata.bytes > 100);
  const closed = data(await call("tab_close", { session_id: snapshot.session_id }));
  assert.notEqual(closed.ok, false);
  assert.deepEqual(data(await call("tab_list", {})).sessions, []);
  assert.equal(connection.stderr(), "");
});

test("SDK cancellation stops the browser batch before its later side effect", { timeout: 20_000 }, async t => {
  let tailClicks = 0;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const streams = new Set();
  const fixture = createHttpServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(": connected\n\n");
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    if (request.url === "/started") { response.end("started"); startedResolve(); return; }
    if (request.url === "/tail") { tailClicks++; response.end("tail"); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Cancellation fixture</title>
      <button onclick="fetch('/started')">Start batch</button><p id="gate">Waiting</p>
      <button onclick="fetch('/tail')">Tail side effect</button>
      <script>const events = new EventSource('/events'); events.onmessage = () => document.querySelector('#gate').textContent = 'Continue gate';</script>`);
  });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => { fixture.closeAllConnections(); return new Promise(resolve => fixture.close(resolve)); });
  const connection = await connect();
  t.after(() => connection.client.close());
  const snapshot = data(await connection.client.callTool({ name: "tab_open", arguments: { url: `http://127.0.0.1:${fixture.address().port}/` } }));
  const start = snapshot.elements.find(element => element.name === "Start batch");
  const tail = snapshot.elements.find(element => element.name === "Tail side effect");
  assert.ok(start && tail);
  const controller = new AbortController();
  const inFlight = connection.client.callTool({ name: "tab_act", arguments: {
    session_id: snapshot.session_id, snapshot_id: snapshot.snapshot_id,
    actions: [{ type: "click", ref: start.ref }, { type: "wait", text: "Continue gate", timeout_ms: 10_000 }, { type: "click", ref: tail.ref }], timeout_ms: 15_000,
  } }, undefined, { signal: controller.signal, timeout: 16_000 });
  const cancellation = assert.rejects(inFlight, /cancel|abort/i);
  let startedTimer;
  try {
    await Promise.race([started, new Promise((_, reject) => { startedTimer = setTimeout(() => reject(new Error("The batch did not start")), 5_000); })]);
  } finally { clearTimeout(startedTimer); }
  controller.abort(new Error("Cancel this browser batch"));
  await cancellation;
  // stdio ordering ensures the cancellation notification precedes this ping.
  await connection.client.ping();
  for (const stream of streams) if (!stream.destroyed) stream.write("data: go\n\n");
  const deadline = Date.now() + 3_000;
  let sessions = [];
  do {
    sessions = data(await connection.client.callTool({ name: "tab_list", arguments: {} })).sessions;
    if (!sessions.some(session => session.session_id === snapshot.session_id)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.ok(!sessions.some(session => session.session_id === snapshot.session_id), "cancellation closes and removes the owned session");
  assert.equal(tailClicks, 0, "a cancelled batch never runs its later click");
  assert.equal(connection.stderr(), "");
});

test("CDP connection errors never return endpoint credentials", { timeout: 10_000 }, async t => {
  const fixture = createHttpServer((_request, response) => { response.writeHead(403); response.end("Forbidden"); });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => { fixture.closeAllConnections(); return new Promise(resolve => fixture.close(resolve)); });
  const endpoint = `http://user:cdp-password@127.0.0.1:${fixture.address().port}/?token=cdp-query-secret`;
  const connection = await connect(["--cdp-url", endpoint, "--timeout-ms", "1000"]);
  t.after(() => connection.client.close());
  const response = await connection.client.callTool({ name: "tab_open", arguments: { url: "https://example.com" } });
  assert.equal(response.isError, true);
  assert.equal(data(response).error.code, "BROWSER_LAUNCH_FAILED");
  assert.doesNotMatch(JSON.stringify(response) + connection.stderr(), /cdp-password|cdp-query-secret/);
});

test("a total batch budget ends a longer individual wait and reports skipped work", { timeout: 15_000 }, async t => {
  let tailClicks = 0;
  const fixture = createHttpServer((request, response) => {
    if (request.url === "/tail") { tailClicks++; response.end("tail"); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><title>Budget fixture</title><p>Ready</p><button onclick="fetch(\'/tail\')">Tail side effect</button>');
  });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => { fixture.closeAllConnections(); return new Promise(resolve => fixture.close(resolve)); });
  const connection = await connect();
  t.after(() => connection.client.close());
  const snapshot = data(await connection.client.callTool({ name: "tab_open", arguments: { url: `http://127.0.0.1:${fixture.address().port}/` } }));
  const tail = snapshot.elements.find(element => element.name === "Tail side effect");
  assert.ok(tail);
  const started = performance.now();
  const response = await connection.client.callTool({ name: "tab_act", arguments: {
    session_id: snapshot.session_id, snapshot_id: snapshot.snapshot_id,
    actions: [{ type: "wait", text: "Never appears", timeout_ms: 10_000 }, { type: "click", ref: tail.ref }], timeout_ms: 200,
  } });
  const output = data(response);
  assert.equal(response.isError, true);
  assert.equal(output.failed.error.code, "BATCH_TIMEOUT");
  assert.equal(output.session_closed, true);
  assert.equal(output.completed, 0);
  assert.deepEqual(output.results.map(result => result.status), ["failed", "skipped"]);
  assert.ok(performance.now() - started < 4_000, "the total budget bounds a 10-second step");
  assert.equal(tailClicks, 0);
  assert.deepEqual(data(await connection.client.callTool({ name: "tab_list", arguments: {} })).sessions, []);
});

test("CLI help, version and doctor are usable without launching a browser", () => {
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 10_000 });
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Tablaze/);
  assert.match(help.stdout, /闪页/);
  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "0.1.0");
  const diagnostic = run(["doctor", "--cdp-url", "http://user:s3cret@127.0.0.1:1/?token=do-not-print"]);
  assert.equal(diagnostic.status, 0);
  const report = JSON.parse(diagnostic.stdout);
  assert.equal(report.mode, "cdp");
  assert.equal(report.ready, null);
  assert.doesNotMatch(diagnostic.stdout + diagnostic.stderr, /s3cret|do-not-print/);
  const bad = run(["--timeout-ms", "0"]);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /timeout-ms/);
});
