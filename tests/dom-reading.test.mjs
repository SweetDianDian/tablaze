import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';

let server;
let base;
let engine;
const documentFor = (path) => {
  if (path === '/long') return `<!doctype html><style>button{display:block;height:16px;padding:0;line-height:12px}</style>
    <p>Top page evidence</p>${Array.from({ length: 500 }, (_, index) => `<button>Button ${index + 1}</button>`).join('')}
    <section id="tail"><p>Tail section evidence</p><button onclick="this.textContent='Tail action complete'">Button 501</button></section>`;
  if (path === '/lines') return `<!doctype html><div style="white-space:pre;line-height:24px">Top-only evidence\n${'middle line\n'.repeat(100)}Bottom-only evidence</div>`;
  if (path === '/clipping') return `<!doctype html><div style="overflow:hidden;height:30px;width:250px"><span>Visible clipped box</span><div style="height:100px"></div><button>Clipped action</button><span>Clipped hidden text</span></div>`;
  if (path === '/shadow') return `<!doctype html><h1>Composed document</h1><div id="host">
    <span slot="visible">Slotted evidence</span><a slot="visible" href="/slot">Slotted link</a>
    <span slot="concealed">hidden-slot-secret</span><span>unassigned-light-secret</span></div>
    <div id="hidden-host" style="display:none"></div>
    <script>
      const root = document.querySelector('#host').attachShadow({mode:'open'});
      root.innerHTML = '<h2>Shadow heading</h2><slot name="visible"></slot><slot name="concealed" style="display:none"></slot><div id="nested"></div><table id="shadow-table"><tr><th>Place</th><th>Status</th></tr><tr><td>Lisbon</td><td>Available<textarea id="cell-memo">textarea-initial-secret</textarea></td></tr></table><label>Password<input type="password" value="password-secret"></label><input type="hidden" value="hidden-value-secret"><button aria-labelledby="cell-memo">Safe fallback</button>';
      root.querySelector('#cell-memo').value = 'Current memo';
      const nested = root.querySelector('#nested').attachShadow({mode:'open'});
      nested.innerHTML = '<a href="/deep">Nested link</a><button>Deep action</button>';
      nested.querySelector('button').onclick = event => { event.currentTarget.textContent = 'Deep action complete'; };
      document.querySelector('#hidden-host').attachShadow({mode:'open'}).innerHTML = '<a href="/hidden">hidden-host-secret</a>';
    </script>`;
  if (path === '/accessible-name') return `<!doctype html><span hidden id="action-name">Hidden accessible action name<textarea>reference-value-secret</textarea></span><span hidden id="action-description">Hidden accessible description</span><button aria-labelledby="action-name" aria-describedby="action-description" onclick="document.querySelector('#result').textContent='Named action complete'">Visible fallback</button><p id="result">Ready</p>`;
  if (path === '/budgets') return `<!doctype html><div id="long-text">${'padding '.repeat(3500)}<span>Beyond evidence</span><span>boundary marker</span></div>
    <div id="links">${Array.from({ length: 30 }, (_, index) => `<a href="/item-${index}">${'Link label '.repeat(120)}</a>`).join('')}</div>
    <table>${Array.from({ length: 25 }, () => `<tr><td>${'Cell '.repeat(250)}</td><td>${'Other '.repeat(250)}</td></tr>`).join('')}</table>`;
  if (path === '/scan') return `<!doctype html><body>${'<i></i>'.repeat(30001)}<p>After scan limit</p></body>`;
  if (path === '/redacted-controls') return '<!doctype html><label>Empty password <input type="password"></label><label>Existing password <input type="password" value="fixture-private-password"></label><label>Current status <select disabled><option value="active">Active</option></select></label><button>Continue</button>';
  return '<!doctype html><p>Destination</p>';
};

before(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(documentFor(new URL(request.url, 'http://localhost').pathname));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 1000 });
});
after(async () => { await engine?.dispose(); await new Promise(resolve => server.close(resolve)); });

async function open(t, path) {
  const snapshot = await engine.open(`${base}${path}`);
  t.after(async () => { if (engine.list().some(session => session.session_id === snapshot.session_id)) await engine.close(snapshot.session_id); });
  return snapshot;
}

test('redacted password state and disabled select selection remain observable without exposing credentials', async t => {
  const initial = await open(t, '/redacted-controls');
  const empty = initial.elements.find(item => item.name === 'Empty password');
  const existing = initial.elements.find(item => item.name === 'Existing password');
  const status = initial.elements.find(item => item.name === 'Current status');
  assert.equal(empty.value_redacted, true);
  assert.equal(empty.value_filled, false);
  assert.equal(existing.value_redacted, true);
  assert.equal(existing.value_filled, true);
  assert.equal(status.disabled, true);
  assert.equal(status.value, 'active');
  assert.deepEqual(status.options.map(({ label, selected }) => ({ label, selected })), [{ label: 'Active', selected: true }]);
  assert.doesNotMatch(JSON.stringify(initial), /fixture-private-password/);
  const filled = await engine.act(initial.session_id, initial.snapshot_id, [{ type: 'fill', ref: empty.ref, value: 'new-private-password' }], { snapshot: false });
  assert.equal(filled.ok, true);
  const diff = await engine.snapshot(initial.session_id, { mode: 'diff' });
  assert.equal(diff.changed.find(item => item.name === 'Empty password').value_filled, true);
  assert.doesNotMatch(JSON.stringify(diff), /new-private-password|fixture-private-password/);
});

test('viewport observation reaches the 501st button after scrolling a truncated page', async t => {
  const initial = await open(t, '/long');
  const capped = await engine.snapshot(initial.session_id, { maxElements: 500 });
  assert.equal(capped.elements.length, 500);
  assert.equal(capped.truncation.elements, true);
  assert.ok(!capped.elements.some(element => element.name === 'Button 501'));
  assert.equal((await engine.act(capped.session_id, capped.snapshot_id, [{ type: 'scroll', direction: 'down', pixels: 10000 }], { snapshot: false })).ok, true);
  const viewport = await engine.snapshot(initial.session_id, { viewportOnly: true });
  const target = viewport.elements.find(element => element.name === 'Button 501');
  assert.ok(target, JSON.stringify(viewport));
  assert.ok(!viewport.elements.some(element => element.name === 'Button 1'));
  assert.doesNotMatch(viewport.text, /Top page evidence/);
  assert.match(viewport.text, /Tail section evidence/);
  assert.equal((await engine.act(viewport.session_id, viewport.snapshot_id, [{ type: 'click', ref: target.ref }])).ok, true);
  assert.equal((await engine.verify(initial.session_id, [{ kind: 'text', contains: 'Tail action complete' }])).passed, true);
});

test('scoped observation exposes the selected subtree and resets incompatible diff baselines', async t => {
  const initial = await open(t, '/long');
  const scoped = await engine.snapshot(initial.session_id, { selector: '#tail', mode: 'diff' });
  assert.equal(scoped.baseline_snapshot_id, null);
  assert.deepEqual(scoped.added.map(element => element.name), ['Button 501']);
  assert.match(scoped.text, /Tail section evidence/);
  assert.doesNotMatch(scoped.text, /Top page evidence/);
  assert.equal(scoped.truncated, false);
  await assert.rejects(engine.snapshot(initial.session_id, { selector: '.missing-root' }), error => error.code === 'SELECTOR_COUNT');
  await assert.rejects(engine.snapshot(initial.session_id, { selector: 'button' }), error => error.code === 'SELECTOR_COUNT');
});

test('viewport text clips individual offscreen lines within a single text node', async t => {
  const initial = await open(t, '/lines');
  const top = await engine.snapshot(initial.session_id, { viewportOnly: true });
  assert.match(top.text, /Top-only evidence/);
  assert.doesNotMatch(top.text, /Bottom-only evidence/);
  assert.equal((await engine.act(top.session_id, top.snapshot_id, [{ type: 'scroll', direction: 'down', pixels: 10000 }], { snapshot: false })).ok, true);
  const bottom = await engine.snapshot(initial.session_id, { viewportOnly: true });
  assert.match(bottom.text, /Bottom-only evidence/);
  assert.doesNotMatch(bottom.text, /Top-only evidence/);
});

test('viewport observation excludes controls and text clipped by scroll-container ancestry', async t => {
  const initial = await open(t, '/clipping');
  const viewport = await engine.snapshot(initial.session_id, { viewportOnly: true });
  assert.match(viewport.text, /Visible clipped box/);
  assert.doesNotMatch(viewport.text, /Clipped hidden text/);
  assert.ok(!viewport.elements.some(element => element.name === 'Clipped action'));
});

test('snapshots, extraction, verification and guarded actions share open shadow and slot content', async t => {
  const initial = await open(t, '/shadow');
  const text = await engine.extract(initial.session_id, { kind: 'text' });
  assert.equal(text.text, initial.text);
  for (const expected of ['Shadow heading', 'Slotted evidence', 'Slotted link', 'Nested link', 'Lisbon', 'Available']) assert.ok(text.text.includes(expected), text.text);
  assert.equal(text.text.split('Slotted evidence').length - 1, 1, 'Assigned content must be visited once');
  const checks = await engine.verify(initial.session_id, [
    { kind: 'text', contains: 'Shadow heading Slotted evidence' },
    { kind: 'text', contains: 'Nested link Deep action' },
    { kind: 'text', contains: 'Lisbon Available' },
  ]);
  assert.equal(checks.passed, true, JSON.stringify(checks));
  const links = await engine.extract(initial.session_id, { kind: 'links' });
  assert.deepEqual(links.items, [{ text: 'Slotted link', href: `${base}/slot` }, { text: 'Nested link', href: `${base}/deep` }]);
  const table = await engine.extract(initial.session_id, { kind: 'table' });
  assert.deepEqual(table.items, [['Place', 'Status'], ['Lisbon', 'Available']]);
  const scoped = await engine.snapshot(initial.session_id, { selector: '#nested' });
  assert.deepEqual(scoped.elements.map(element => element.name), ['Nested link', 'Deep action']);
  const target = scoped.elements.find(element => element.name === 'Deep action');
  assert.equal((await engine.act(scoped.session_id, scoped.snapshot_id, [{ type: 'click', ref: target.ref }])).ok, true);
  assert.equal((await engine.verify(initial.session_id, [{ kind: 'text', contains: 'Deep action complete' }])).passed, true);
});

test('hidden hosts, hidden slots and raw form values do not leak through composed readers', async t => {
  const initial = await open(t, '/shadow');
  const forbidden = /hidden-slot-secret|unassigned-light-secret|hidden-host-secret|textarea-initial-secret|password-secret|hidden-value-secret/;
  assert.doesNotMatch(JSON.stringify(initial), forbidden);
  for (const kind of ['text', 'links', 'table']) assert.doesNotMatch(JSON.stringify(await engine.extract(initial.session_id, { kind })), forbidden);
  const textarea = await engine.extract(initial.session_id, { kind: 'text', selector: '#cell-memo' });
  assert.equal(textarea.text, '');
  const checks = await engine.verify(initial.session_id, [
    { kind: 'text', contains: 'hidden-slot-secret' },
    { kind: 'text', contains: 'hidden-host-secret' },
    { kind: 'text', contains: 'textarea-initial-secret' },
  ], 100);
  assert.equal(checks.passed, false);
  assert.ok(checks.checks.every(check => !check.pass));
  assert.doesNotMatch(JSON.stringify(checks), forbidden);
});

test('text matching searches beyond bounded evidence and across composed text-node boundaries', async t => {
  const initial = await open(t, '/budgets');
  const text = await engine.extract(initial.session_id, { kind: 'text', selector: '#long-text' });
  assert.equal(text.text.length, 20000);
  assert.equal(text.truncated, true);
  assert.equal(text.scan_truncated, false);
  assert.doesNotMatch(text.text, /Beyond evidence/);
  const verification = await engine.verify(initial.session_id, [{ kind: 'text', contains: 'Beyond evidence boundary marker' }]);
  assert.equal(verification.passed, true, JSON.stringify(verification));
  assert.ok(verification.checks[0].actual.length <= 2000);
});

test('explicit hidden accessibility labels still name guarded controls without leaking form values', async t => {
  const initial = await open(t, '/accessible-name');
  const target = initial.elements.find(element => element.name === 'Hidden accessible action name');
  assert.ok(target, JSON.stringify(initial));
  assert.doesNotMatch(JSON.stringify(initial), /reference-value-secret/);
  assert.doesNotMatch(initial.text, /Hidden accessible/);
  const extraction = await engine.extract(initial.session_id, { kind: 'text' });
  assert.doesNotMatch(extraction.text, /Hidden accessible|reference-value-secret/);
  assert.equal((await engine.act(initial.session_id, initial.snapshot_id, [{ type: 'click', ref: target.ref }])).ok, true);
  assert.equal((await engine.verify(initial.session_id, [{ kind: 'text', contains: 'Named action complete' }])).passed, true);
});

test('link and table extraction report item and character truncation accurately', async t => {
  const initial = await open(t, '/budgets');
  const limited = await engine.extract(initial.session_id, { kind: 'links', maxItems: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.truncated, true);
  for (const kind of ['links', 'table']) {
    const result = await engine.extract(initial.session_id, { kind });
    const characters = result.items.flatMap(item => Array.isArray(item) ? item : [item.text, item.href]).reduce((total, value) => total + value.length, 0);
    assert.ok(characters <= 20000, `${kind}: ${characters}`);
    assert.equal(result.truncated, true);
    assert.equal(result.scan_truncated, false);
  }
});

test('scan-budget exhaustion is explicit in both snapshots and extraction', async t => {
  const initial = await open(t, '/scan');
  assert.equal(initial.truncation.scan, true);
  assert.equal(initial.truncated, true);
  const extracted = await engine.extract(initial.session_id, { kind: 'text' });
  assert.equal(extracted.scan_truncated, true);
  assert.equal(extracted.truncated, true);
  assert.doesNotMatch(extracted.text, /After scan limit/);
});
