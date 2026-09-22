import assert from 'node:assert/strict';
import { createServer as createHTTPServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer, connectAgentTools, runAgent, parseAgentCheckpoint } from '../dist/index.js';

test('explicit initialization and popup following complete a real workflow without executing remaining origin calls', { timeout: 30_000 }, async t => {
  const requestId = randomUUID();
  const records = [];
  let trapWrites = 0;
  const fixture = createHTTPServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/approve') {
      let body = '';
      for await (const part of request) body += part;
      records.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"accepted":true}');
      return;
    }
    if (request.method === 'POST' && request.url === '/trap') {
      trapWrites++;
      response.end('unexpected');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/approval'
      ? `<!doctype html><title>Approval</title><button id="approve">Approve this request</button><p id="status">Pending</p><script>
        document.querySelector('#approve').onclick = async () => {
          await fetch('/approve', { method: 'POST', body: JSON.stringify({ requestId: ${JSON.stringify(requestId)}, approved: true }) });
          document.querySelector('#status').textContent = 'Approval recorded';
        };
      </script>`
      : `<!doctype html><title>Request list</title><a href="/approval" target="_blank">Open request</a><button onclick="fetch('/trap',{method:'POST'})">Origin-only action</button>`);
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
  const runtime = createServer({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 2_000, popupPolicy: 'follow-single' });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); });
  const saved = [];
  const find = (snapshot, name) => {
    const entry = snapshot.elements.find(element => element.name === name);
    assert.ok(entry, `Missing observed control ${name}`);
    return entry.ref;
  };
  let sessionId;
  let originTabId;
  let popupTabId;
  const result = await runAgent({
    task: 'Open the selected request in its approval tab and approve it once.',
    startUrl: `http://127.0.0.1:${fixture.address().port}/`,
    tools: connection.tools,
    maxSteps: 4,
    maxToolCalls: 4,
    timeoutMs: 15_000,
    onCheckpoint: async checkpoint => { saved.push(structuredClone(checkpoint)); },
    validateCompletion: ({ evidence }) => records.length === 1 && records[0].requestId === requestId && records[0].approved === true && trapWrites === 0 && evidence.some(item => item.arguments.checks.some(check => check.kind === 'text' && check.contains === 'Approval recorded')),
    planner: async ({ step, messages }) => {
      const outputs = messages.filter(message => message.role === 'tool');
      if (step === 1) {
        assert.equal(outputs.length, 1);
        assert.equal(outputs[0].name, 'tab_open');
        const snapshot = outputs[0].result.structuredContent;
        sessionId = snapshot.session_id;
        originTabId = snapshot.tab_id;
        return { type: 'tools', calls: [
          { name: 'tab_act', arguments: { session_id: sessionId, snapshot_id: snapshot.snapshot_id, actions: [{ type: 'click', ref: find(snapshot, 'Open request') }] } },
          { name: 'tab_act', arguments: { session_id: sessionId, snapshot_id: snapshot.snapshot_id, actions: [{ type: 'click', ref: find(snapshot, 'Origin-only action') }] } },
        ] };
      }
      if (step === 2) {
        const previous = outputs.at(-1);
        assert.equal(previous.result.structuredContent.error.code, 'CALL_SKIPPED');
        const changed = outputs.at(-2).result.structuredContent;
        assert.equal(changed.replan_required, true);
        assert.equal(changed.ok, true);
        const snapshot = changed.snapshot;
        popupTabId = snapshot.tab_id;
        assert.notEqual(popupTabId, originTabId);
        return { type: 'tools', calls: [{ name: 'tab_act', arguments: { session_id: sessionId, snapshot_id: snapshot.snapshot_id, actions: [{ type: 'click', ref: find(snapshot, 'Approve this request') }] } }] };
      }
      if (step === 3) return { type: 'tools', calls: [{ name: 'tab_verify', arguments: { session_id: sessionId, checks: [{ kind: 'text', contains: 'Approval recorded' }], timeout_ms: 2_000 } }] };
      return { type: 'finish', summary: 'The selected request was approved once.', evidence: [outputs.at(-1).toolCallId] };
    },
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.steps, 4);
  assert.equal(result.plannerCalls, 4);
  assert.equal(result.toolCalls, 4, 'One initialization plus three dispatched browser calls');
  assert.equal(result.events.filter(event => event.type === 'tool_result' && event.skipped).length, 1);
  assert.deepEqual(records, [{ requestId, approved: true }]);
  assert.equal(trapWrites, 0);
  assert.equal(runtime.engine.list()[0].tab_id, popupTabId);
  assert.ok(saved.length > 0);
  for (const checkpoint of saved) assert.doesNotThrow(() => parseAgentCheckpoint(checkpoint));
});
