import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';

const content = kind => `<!doctype html><title>Drag controls</title><style>
  body {margin:0;font:16px sans-serif} #source,#destination {position:absolute;top:40px;width:100px;height:70px;display:grid;place-items:center;user-select:none}
  #source {left:30px;background:#acf;z-index:3} #destination {left:280px;background:#cfa} #status {position:absolute;top:180px}
  </style><div id="source" ${kind === 'mouse' ? '' : 'draggable="true"'} aria-label="Drag source"><span>Source</span></div>
  <div id="destination" aria-label="Drop target"><span>Destination</span></div><p id="status">Ready</p>
  <script>
    window.sourceDowns=0; window.drops=0; window.lastButtons=0; window.dragging=false;
    const source=document.querySelector('#source'), destination=document.querySelector('#destination');
    source.addEventListener('mousedown', event=> {window.sourceDowns++; ${kind === 'mouse' ? 'event.preventDefault(); window.dragging=true;' : ''}});
    document.addEventListener('mousemove', event=> {window.lastButtons=event.buttons;
      ${kind === 'mouse' ? 'if(window.dragging){source.style.left=(event.clientX-50)+"px";source.style.top=(event.clientY-35)+"px";}' : ''}
    });
    ${kind === 'mouse' ? `document.addEventListener('mouseup', event=> {if(!window.dragging)return;window.dragging=false;const box=destination.getBoundingClientRect();if(event.clientX>=box.left&&event.clientX<=box.right&&event.clientY>=box.top&&event.clientY<=box.bottom){window.drops++;document.querySelector('#status').textContent='Mouse drag completed';}});` : `
      source.addEventListener('dragstart', event=>event.dataTransfer.setData('text/plain','native payload 你好'));
      destination.addEventListener('dragover', event=>event.preventDefault());
      destination.addEventListener('drop', event=>{event.preventDefault();window.drops++;document.querySelector('#status').textContent='Dropped '+event.dataTransfer.getData('text/plain');});`}
  </script>`;

async function fixture(t, path = '/native') {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/framed') response.end('<!doctype html><iframe title="Outer" src="/outer" style="position:absolute;left:80px;top:40px;width:700px;height:430px;border:8px solid blue;transform:scale(.85);transform-origin:0 0"></iframe>');
    else if (request.url === '/cross') response.end(`<!doctype html><iframe title="Cross origin" src="http://localhost:${server.address().port}/native" style="position:absolute;left:80px;top:40px;width:600px;height:350px;border:8px solid blue"></iframe>`);
    else if (request.url === '/outer') response.end('<!doctype html><iframe title="Inner" src="/native" style="position:absolute;left:20px;top:30px;width:520px;height:280px;border:6px solid gray"></iframe>');
    else response.end(content(request.url === '/mouse' ? 'mouse' : 'native'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 2_000 });
  t.after(async () => { await engine.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let snapshot = await engine.open(`http://127.0.0.1:${server.address().port}${path}`);
  if (path === '/framed' || path === '/cross') {
    await engine.sessions.get(snapshot.session_id).page.waitForLoadState('load');
    snapshot = await engine.snapshot(snapshot.session_id);
    const frame = snapshot.frames.find(frame => frame.url.endsWith('/native'));
    assert.ok(frame, 'Nested frame is observed.');
    snapshot = await engine.snapshot(snapshot.session_id, { frameId: frame.frame_id });
  }
  const session = engine.sessions.get(snapshot.session_id);
  return { engine, snapshot, page: session.page, frame: session.snapshot.frame };
}

function drag(snapshot) {
  const source = snapshot.elements.find(element => element.name === 'Drag source');
  const destination = snapshot.elements.find(element => element.name === 'Drop target');
  assert.ok(source, 'A normal draggable div is referenceable.');
  assert.ok(destination, 'An aria-labeled drop div is referenceable.');
  return [{ type: 'drag', ref: source.ref, targetRef: destination.ref }];
}

async function overlay(page) {
  await page.evaluate(() => {
    window.overlayDowns = 0; window.overlayDrops = 0;
    const cover = document.createElement('div'); cover.id = 'late-overlay';
    Object.assign(cover.style, { position: 'fixed', inset: '0', zIndex: '100000', background: '#8888' });
    cover.addEventListener('mousedown', () => window.overlayDowns++);
    cover.addEventListener('dragover', event => event.preventDefault());
    cover.addEventListener('drop', () => window.overlayDrops++);
    document.body.append(cover);
  });
}

test('ordinary draggable and aria-labeled divs deliver actual native drop payload', { timeout: 30_000 }, async t => {
  const { engine, snapshot, frame } = await fixture(t);
  const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, drag(snapshot));
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(await frame.locator('#status').innerText(), 'Dropped native payload 你好');
  assert.equal(await frame.evaluate(() => window.drops), 1);
});

test('mouse-driven custom drag supports the observed source covering its drop target', { timeout: 30_000 }, async t => {
  const { engine, snapshot, page, frame } = await fixture(t, '/mouse');
  const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, drag(snapshot));
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(await frame.locator('#status').innerText(), 'Mouse drag completed');
  await page.mouse.move(450, 250);
  assert.equal(await frame.evaluate(() => window.lastButtons), 0);
});

test('nested scaled iframe drag maps main-page coordinates and preserves native payload', { timeout: 30_000 }, async t => {
  for (const path of ['/framed', '/cross']) {
    const { engine, snapshot, frame } = await fixture(t, path);
    const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, drag(snapshot));
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(await frame.locator('#status').innerText(), 'Dropped native payload 你好');
  }
});

test('open Shadow DOM drag target hit testing reaches the actual source and destination', { timeout: 30_000 }, async t => {
  const { engine, snapshot, page } = await fixture(t);
  await page.evaluate(() => {
    const host = document.createElement('div'); const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = document.querySelector('style').textContent;
    root.append(style, document.querySelector('#source'), document.querySelector('#destination'));
    document.body.append(host);
  });
  const fresh = await engine.snapshot(snapshot.session_id);
  const outcome = await engine.act(fresh.session_id, fresh.snapshot_id, drag(fresh));
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(await page.locator('#status').innerText(), 'Dropped native payload 你好');
});

test('an overlay appearing after the initial mouse move cannot intercept mousedown', { timeout: 30_000 }, async t => {
  for (const path of ['/native', '/framed']) {
    const { engine, snapshot, page, frame } = await fixture(t, path);
    const originalMove = page.mouse.move.bind(page.mouse); let moved = false;
    page.mouse.move = async (...args) => { await originalMove(...args); if (!moved) { moved = true; await overlay(page); } };
    const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, drag(snapshot));
    assert.equal(moved, true);
    assert.equal(outcome.ok, false, path);
    assert.equal(outcome.failed.error.code, 'DRAG_TARGET_OBSCURED', JSON.stringify(outcome));
    assert.equal(await frame.evaluate(() => window.sourceDowns), 0);
    assert.equal(await page.evaluate(() => window.overlayDowns), 0);
    assert.equal(await page.evaluate(() => window.overlayDrops), 0);
  }
});

test('an overlay appearing during movement cancels the drag before drop and releases the mouse', { timeout: 30_000 }, async t => {
  const { engine, snapshot, page, frame } = await fixture(t);
  const originalMove = page.mouse.move.bind(page.mouse); let moves = 0;
  page.mouse.move = async (...args) => { await originalMove(...args); moves++; if (moves === 2) await overlay(page); };
  const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, drag(snapshot));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failed.error.code, 'DRAG_TARGET_OBSCURED', JSON.stringify(outcome));
  assert.equal(await page.evaluate(() => window.overlayDrops), 0, 'Cleanup must not drop onto the interception overlay.');
  assert.equal(await frame.evaluate(() => window.drops), 0);
  page.mouse.move = originalMove;
  await page.locator('#late-overlay').evaluate(element => element.remove());
  await page.mouse.move(450, 250);
  assert.equal(await frame.evaluate(() => window.lastButtons), 0);
  const fresh = await engine.snapshot(snapshot.session_id);
  const retry = await engine.act(fresh.session_id, fresh.snapshot_id, drag(fresh));
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(await frame.evaluate(() => window.drops), 1);
});

test('mouseup RPC rejection is a failed action even if the release was applied; cleanup releases held input', { timeout: 30_000 }, async t => {
  for (const applied of [false, true]) {
    const { engine, snapshot, page, frame } = await fixture(t);
    const originalUp = page.mouse.up.bind(page.mouse); let ups = 0;
    page.mouse.up = async (...args) => {
      ups++;
      if (ups === 1) { if (applied) await originalUp(...args); throw new Error('Injected mouse-release RPC failure.'); }
      return originalUp(...args);
    };
    const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, drag(snapshot));
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.equal(outcome.completed, 0);
    assert.equal(outcome.failed_action_may_have_side_effects, true);
    assert.equal(ups, 2, 'A rejected release gets cleanup, never a false success.');
    assert.equal(await frame.evaluate(() => window.drops), applied ? 1 : 0, 'An already-applied drop is never repeated.');
    await page.mouse.move(450, 250);
    assert.equal(await frame.evaluate(() => window.lastButtons), 0);
  }
});

test('an unreleasable mouse closes only the owned session and reports input cleanup failure', { timeout: 30_000 }, async t => {
  const { engine, snapshot, page } = await fixture(t);
  const sibling = await engine.open(snapshot.url);
  page.mouse.up = async () => { throw new Error('Persistent release failure.'); };
  const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, drag(snapshot));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failed.error.code, 'INPUT_CLEANUP_FAILED');
  assert.equal(outcome.session_closed, true);
  assert.deepEqual(engine.list().map(session => session.session_id), [sibling.session_id]);
  assert.equal((await engine.verify(sibling.session_id, [{ kind: 'text', contains: 'Ready' }])).passed, true);
});
