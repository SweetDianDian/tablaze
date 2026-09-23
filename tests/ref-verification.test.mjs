import assert from 'node:assert/strict';
import { createServer as createHTTPServer } from 'node:http';
import { after, before, test } from 'node:test';
import Ajv from 'ajv';
import { createServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';

let fixture, runtime, connection, base;
const page = (nested = false) => `<!doctype html><meta charset="utf-8"><title>Ref verification fixture</title>
<style>label{display:block;margin:8px}input,textarea,select,button{font:16px sans-serif}iframe{width:700px;height:600px}</style>
<label>Name <input id="name" value="initial"></label><label>City <input id="city" value=""></label>
<label>Memo <textarea id="memo">raw textarea seed</textarea></label>
<label>Choice <select id="choice"><option value="">Choose</option><option value="2">Two</option></select></label>
<label>Password <input id="password" type="password" value="private-password-sentinel"></label>
<input id="hidden" type="hidden" value="private-hidden-sentinel"><div id="host"></div>
<button id="save">Save</button><button id="replace">Replace name</button><button id="rename">Rename name</button>
<button id="hide">Hide name</button><button id="late-replace">Replace later</button><button id="late-navigate">Navigate later</button>
<button id="late-value">Change value later</button>
<button id="navigate">Navigate now</button><button id="detach">Detach frame</button><button id="update">Update later</button>
<button id="long">Set long value</button><p id="status">Ready</p>
${nested ? '' : '<iframe title="Nested form" src="/frame"></iframe>'}
<script>
const field = () => document.querySelector('#name');
const status = message => document.querySelector('#status').textContent = message;
document.querySelector('#host').attachShadow({mode:'open'}).innerHTML = '<label>Shadow note <input value="shadow initial"></label>';
document.querySelector('#save').onclick = () => status('Saved successfully');
document.querySelector('#replace').onclick = () => field().replaceWith(field().cloneNode(true));
document.querySelector('#rename').onclick = () => field().setAttribute('aria-label', 'Different identity');
document.querySelector('#hide').onclick = () => field().hidden = true;
document.querySelector('#late-replace').onclick = () => setTimeout(() => { field().replaceWith(field().cloneNode(true)); status('Late replacement done'); }, 120);
document.querySelector('#late-navigate').onclick = () => setTimeout(() => location.href = '/landed', 120);
document.querySelector('#late-value').onclick = () => setTimeout(() => { field().value = 'wrong final value'; status('Late value change done'); }, 120);
document.querySelector('#navigate').onclick = () => location.href = '/landed';
document.querySelector('#detach').onclick = () => frameElement?.remove();
document.querySelector('#update').onclick = () => setTimeout(() => { field().value = 'queued result'; status('Update complete'); }, 120);
document.querySelector('#long').onclick = () => field().value = 'x'.repeat(100000);
</script>`;

before(async () => {
  fixture = createHTTPServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/landed' ? '<p>Navigation landed</p><label>Name <input value="initial"></label>' : page(request.url === '/frame'));
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${fixture.address().port}`;
  runtime = createServer({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 1000 });
  connection = await connectAgentTools(runtime.server);
});
after(async () => { await connection?.close(); await runtime?.dispose(); fixture?.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
const engine = () => runtime.engine;
const call = (name, args) => connection.client.callTool({ name, arguments: args });
const data = result => result.structuredContent;
const ref = (snapshot, name) => {
  const entry = snapshot.elements.find(element => element.name === name);
  assert.ok(entry, `Missing ${name}: ${JSON.stringify(snapshot.elements)}`);
  return entry.ref;
};
async function open(t, path = '/') {
  const snapshot = await engine().open(base + path);
  t.after(async () => { if (engine().list().some(session => session.session_id === snapshot.session_id)) await engine().close(snapshot.session_id); });
  return snapshot;
}
const verifyRef = (snapshot, name, value, timeout = 300, extra = []) => engine().verify(snapshot.session_id, [{ kind: 'value', ref: ref(snapshot, name), value }, ...extra], timeout, snapshot.snapshot_id);
const act = (snapshot, actions, options = { snapshot: false }) => engine().act(snapshot.session_id, snapshot.snapshot_id, actions, options);

test('real MCP form fill/save verifies current refs and visible status without another snapshot', async t => {
  const initial = await open(t);
  const acted = data(await call('tab_act', { session_id: initial.session_id, snapshot_id: initial.snapshot_id, actions: [
    { type: 'fill', ref: ref(initial, 'Name'), value: 'Ada' },
    { type: 'fill', ref: ref(initial, 'City'), value: 'Lisbon' },
    { type: 'click', ref: ref(initial, 'Save') },
  ] }));
  assert.equal(acted.ok, true, JSON.stringify(acted));
  const current = acted.snapshot;
  const result = await call('tab_verify', { session_id: current.session_id, snapshot_id: current.snapshot_id, checks: [
    { kind: 'value', ref: ref(current, 'Name'), value: 'Ada' },
    { kind: 'value', ref: ref(current, 'City'), value: 'Lisbon' },
    { kind: 'text', contains: 'Saved successfully' },
  ] });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(data(result).passed, true);
  assert.equal(data(result).snapshot_id, current.snapshot_id);
  assert.equal((await engine().verify(current.session_id, [{ kind: 'value', selector: '#name', value: 'Ada' }])).passed, true);
  assert.equal((await engine().verify(current.session_id, [{ kind: 'text', contains: 'Ada' }], 100)).passed, false, 'Form values are not page text');
});

test('post-checks never certify an action batch that failed before input', async t => {
  const initial = await open(t);
  const result = data(await call('tab_act', { session_id: initial.session_id, snapshot_id: initial.snapshot_id,
    actions: [{ type: 'click', ref: 'r-does-not-exist' }],
    post_checks: [{ kind: 'text', contains: 'Ready' }], verify_timeout_ms: 100 }));
  assert.equal(result.batch_complete, false);
  assert.equal(result.completed, 0);
  assert.equal(result.verification, undefined, 'An already-visible status cannot certify a failed action');
});

test('read-only ref checks preserve actionability and can read a consumed current revision', async t => {
  const initial = await open(t);
  assert.equal((await verifyRef(initial, 'Name', 'initial')).passed, true);
  assert.equal((await act(initial, [{ type: 'fill', ref: ref(initial, 'Name'), value: 'changed' }])).ok, true);
  assert.equal((await verifyRef(initial, 'Name', 'changed')).passed, true);
  assert.equal((await verifyRef(initial, 'Name', 'changed')).passed, true);
  const repeated = await act(initial, [{ type: 'fill', ref: ref(initial, 'Name'), value: 'must not repeat' }]);
  assert.equal(repeated.failed.error.code, 'STALE_SNAPSHOT');
});

test('ref checks support textarea, select, empty values and open shadow controls', async t => {
  const initial = await open(t);
  assert.equal((await act(initial, [
    { type: 'fill', ref: ref(initial, 'Memo'), value: 'memo edited' },
    { type: 'select', ref: ref(initial, 'Choice'), values: ['2'] },
    { type: 'fill', ref: ref(initial, 'Shadow note'), value: 'shadow edited' },
  ])).ok, true);
  const result = await engine().verify(initial.session_id, [
    { kind: 'value', ref: ref(initial, 'Memo'), value: 'memo edited' },
    { kind: 'value', ref: ref(initial, 'Choice'), value: '2' },
    { kind: 'value', ref: ref(initial, 'City'), value: '' },
    { kind: 'value', ref: ref(initial, 'Shadow note'), value: 'shadow edited' },
  ], 300, initial.snapshot_id);
  assert.equal(result.passed, true, JSON.stringify(result));
});

test('MCP and engine reject missing/ambiguous targets and a ref without snapshot_id', async t => {
  const initial = await open(t);
  const catalog = (await connection.client.listTools()).tools.find(tool => tool.name === 'tab_verify');
  const validate = new Ajv({ strict: false }).compile(catalog.inputSchema);
  const baseArgs = { session_id: initial.session_id, snapshot_id: initial.snapshot_id };
  for (const check of [
    { kind: 'value', value: '' },
    { kind: 'value', selector: '#name', ref: ref(initial, 'Name'), value: 'initial' },
    { kind: 'value', ref: '', value: '' },
  ]) {
    assert.equal(validate({ ...baseArgs, checks: [check] }), false, 'Published schema must reject invalid target combinations');
    assert.equal((await call('tab_verify', { ...baseArgs, checks: [check] })).isError, true);
    await assert.rejects(engine().verify(initial.session_id, [check], 100, initial.snapshot_id), { code: 'INVALID_ARGUMENT' });
  }
  const check = { kind: 'value', ref: ref(initial, 'Name'), value: 'initial' };
  assert.equal(data(await call('tab_verify', { session_id: initial.session_id, checks: [check] })).error.code, 'INVALID_ARGUMENT');
  await assert.rejects(engine().verify(initial.session_id, [check], 100), { code: 'INVALID_ARGUMENT' });
  assert.equal(validate({ ...baseArgs, checks: [check] }), true);
});

test('new observations and other sessions reject old snapshot identities; unknown refs fail', async t => {
  const first = await open(t);
  const other = await open(t);
  await assert.rejects(engine().verify(other.session_id, [{ kind: 'value', ref: ref(first, 'Name'), value: 'initial' }], 100, first.snapshot_id), { code: 'STALE_SNAPSHOT' });
  const unknown = await engine().verify(first.session_id, [{ kind: 'value', ref: 'never-observed', value: '' }], 100, first.snapshot_id);
  assert.equal(unknown.checks[0].error.code, 'UNKNOWN_REFERENCE');
  await engine().snapshot(first.session_id);
  await assert.rejects(verifyRef(first, 'Name', 'initial'), { code: 'STALE_SNAPSHOT' });
});

test('replaced, renamed, hidden and navigated targets are rejected without selector fallback', async t => {
  for (const button of ['Replace name', 'Rename name', 'Hide name', 'Navigate now']) {
    const initial = await open(t);
    await act(initial, [{ type: 'click', ref: ref(initial, button) }]);
    const result = await verifyRef(initial, 'Name', 'initial');
    assert.equal(result.passed, false, button);
    assert.equal(result.checks[0].error.code, 'STALE_REFERENCE', JSON.stringify(result));
    assert.equal(result.checks[0].actual, undefined);
  }
});

test('parallel status waits cannot preserve ref evidence from a replaced node or old document', async t => {
  for (const [button, status] of [['Replace later', 'Late replacement done'], ['Navigate later', 'Navigation landed']]) {
    const initial = await open(t);
    await act(initial, [{ type: 'click', ref: ref(initial, button) }]);
    const result = await verifyRef(initial, 'Name', 'initial', 1000, [{ kind: 'text', contains: status }]);
    assert.equal(result.checks[1].pass, true, JSON.stringify(result));
    assert.equal(result.passed, false);
    assert.equal(result.checks[0].error.code, 'STALE_REFERENCE');
    assert.equal(result.checks[0].actual, undefined);
  }
});

test('a later status cannot keep a previously matching value after the same node changes', async t => {
  const initial = await open(t);
  await act(initial, [{ type: 'click', ref: ref(initial, 'Change value later') }]);
  const result = await verifyRef(initial, 'Name', 'initial', 1000, [{ kind: 'text', contains: 'Late value change done' }]);
  assert.equal(result.checks[1].pass, true);
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].actual, 'wrong final value');
  assert.equal(result.checks[0].error, undefined, 'Value changes do not invalidate the node identity');
});

test('iframe refs retain their frame identity and reject detached frame evidence', async t => {
  const initial = await open(t);
  let observed = initial;
  for (let n = 0; !observed.frames.some(frame => frame.url === base + '/frame') && n < 40; n++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    observed = await engine().snapshot(initial.session_id);
  }
  const frame = observed.frames.find(frame => frame.url === base + '/frame');
  assert.ok(frame);
  const nested = await engine().snapshot(initial.session_id, { frameId: frame.frame_id });
  await act(nested, [{ type: 'fill', ref: ref(nested, 'Name'), value: 'inside frame' }]);
  assert.equal((await verifyRef(nested, 'Name', 'inside frame')).passed, true);
  const current = await engine().snapshot(initial.session_id, { frameId: frame.frame_id });
  await act(current, [{ type: 'click', ref: ref(current, 'Detach frame') }]);
  const detached = await verifyRef(current, 'Name', 'inside frame');
  assert.equal(detached.checks[0].error.code, 'STALE_REFERENCE');
  const main = await engine().snapshot(initial.session_id);
  assert.equal((await verifyRef(main, 'Name', 'initial')).passed, true, 'The main document field was not substituted for the iframe ref');
});

test('sensitive and non-form targets fail without leaking values; evidence remains bounded', async t => {
  const initial = await open(t);
  const sensitive = await engine().verify(initial.session_id, [
    { kind: 'value', ref: ref(initial, 'Password'), value: 'wrong' },
    { kind: 'value', selector: '#hidden', value: 'wrong' },
    { kind: 'value', ref: ref(initial, 'Save'), value: 'wrong' },
  ], 100, initial.snapshot_id);
  assert.deepEqual(sensitive.checks.map(check => check.error.code), ['SENSITIVE_VALUE', 'SENSITIVE_VALUE', 'NOT_FORM_CONTROL']);
  assert.doesNotMatch(JSON.stringify(sensitive), /private-password-sentinel|private-hidden-sentinel/);
  await act(initial, [{ type: 'click', ref: ref(initial, 'Set long value') }]);
  const long = await verifyRef(initial, 'Name', 'short', 100);
  assert.equal(long.passed, false);
  assert.equal(long.checks[0].actual.length, 2000);
});

test('queued verification waits for the action batch and shares the original readonly revision', async t => {
  const initial = await open(t);
  const action = act(initial, [{ type: 'click', ref: ref(initial, 'Update later') }, { type: 'wait', text: 'Update complete', timeoutMs: 1000 }]);
  const checking = verifyRef(initial, 'Name', 'queued result', 100);
  assert.equal((await action).ok, true);
  assert.equal((await checking).passed, true);
});
