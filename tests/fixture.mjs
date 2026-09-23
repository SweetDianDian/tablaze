import http from 'node:http';
import { once } from 'node:events';

const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function document(title, content, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
  <style>body{font:18px system-ui;max-width:760px;margin:40px auto;padding:0 20px}label{display:block;margin:16px 0}input,select,button{font:inherit;padding:8px}button{cursor:pointer}article{border:1px solid #999;border-radius:12px;padding:18px;margin:16px 0}#overlay{position:fixed;inset:0;background:#222e;color:white;display:grid;place-items:center;z-index:10000}iframe{width:100%;height:160px}</style></head>
  <body><main>${content}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

const hotel = () => document('Tablaze hotel search', `
  <h1>Find your next stay</h1><p>A deterministic local browser fixture. No bookings or external services.</p>
  <form action="/results" method="get">
    <label>Destination <input id="destination" name="destination" autocomplete="off" required></label>
    <label>Nights <select id="nights" name="nights"><option value="1">1 night</option><option value="3">3 nights</option><option value="7">7 nights</option></select></label>
    <label><input id="flexible" name="flexible" type="checkbox" value="yes"> Free cancellation</label>
    <input type="hidden" id="internal" value="hidden-fixture-secret">
    <label>Private note <input type="password" id="private-note" value="password-fixture-secret"></label>
    <button type="submit">Search stays</button>
  </form><p><a href="/lab?token=manual">Interaction lab</a></p>`);

function results(search) {
  const destination = search.get('destination') || '';
  const nights = search.get('nights') || '1';
  const flexible = search.get('flexible') === 'yes';
  const matches = destination.trim().toLowerCase() === 'lisbon';
  return document('Hotel results — Tablaze', `<h1>Stays in ${escape(destination)}</h1>
    <p id="applied-filters">${escape(nights)} nights · ${flexible ? 'Free cancellation' : 'Any cancellation policy'}</p>
    <form><label>Destination <input id="destination" value="${escape(destination)}"></label></form>
    <section id="results" aria-label="Search results">${matches ? `<article data-hotel="casa-flora"><h2>Casa Flora</h2><p>Lisbon · Design hotel · ${flexible ? 'Free cancellation' : 'Standard rate'}</p><a href="/hotel/casa-flora?${escape(search.toString())}">View Casa Flora</a></article>` : '<p>No stays found.</p>'}</section>
    <table><caption>Available stays</caption><thead><tr><th>Property</th><th>City</th><th>Nights</th></tr></thead><tbody>${matches ? `<tr><td>Casa Flora</td><td>Lisbon</td><td>${escape(nights)}</td></tr>` : ''}</tbody></table>
    <a href="/">New search</a>`);
}

function lab(token) {
  return document('Tablaze interaction lab', `
    <h1>Interaction lab</h1>
    <label>Memo <input id="memo" value="initial"></label>
    <button id="target">Target action</button><button id="tail">Tail action</button>
    <button id="add">Add item</button><button id="remove">Remove item</button>
    <a id="relative-link" href="target">Relative destination</a><p id="link-count">Link count: 0</p>
    <p id="target-count">Target count: 0</p><p id="tail-count">Tail count: 0</p><p id="gate">Gate is closed</p>
    <div id="items"></div><div id="shadow-host"></div>
    <iframe title="Nested controls" src="/frame"></iframe>`, `
    let targetCount = 0, tailCount = 0, linkCount = 0;
    const base = document.createElement('base'); base.href = '/safe/'; document.head.append(base);
    document.querySelector('#relative-link').onclick = (event) => { event.preventDefault(); document.querySelector('#link-count').textContent = 'Link count: ' + ++linkCount; };
    const bindTarget = () => document.querySelector('#target').onclick = () => document.querySelector('#target-count').textContent = 'Target count: ' + ++targetCount;
    bindTarget();
    document.querySelector('#tail').onclick = () => document.querySelector('#tail-count').textContent = 'Tail count: ' + ++tailCount;
    document.querySelector('#add').onclick = () => { const b = document.createElement('button'); b.id = 'dynamic'; b.textContent = 'Dynamic item'; document.querySelector('#items').append(b); };
    document.querySelector('#remove').onclick = () => document.querySelector('#dynamic')?.remove();
    const root = document.querySelector('#shadow-host').attachShadow({mode:'open'});
    root.innerHTML = '<button id="shadow-button">Shadow action</button><p id="shadow-result">Shadow idle</p>';
    root.querySelector('button').onclick = () => root.querySelector('p').textContent = 'Shadow complete';
    const events = new EventSource('/events?token=' + encodeURIComponent(${JSON.stringify(token)}));
    events.onmessage = async ({data}) => {
      const {action, sequence} = JSON.parse(data);
      if (action === 'replace') { document.querySelector('#target').replaceWith(document.querySelector('#target').cloneNode(true)); bindTarget(); }
      if (action === 'rename') document.querySelector('#target').textContent = 'Changed action';
      if (action === 'cover') { const overlay = document.createElement('div'); overlay.id = 'overlay'; overlay.textContent = 'Modal covers the page'; document.body.append(overlay); }
      if (action === 'uncover') document.querySelector('#overlay')?.remove();
      if (action === 'rename-and-uncover') { document.querySelector('#target').textContent = 'Changed action'; document.querySelector('#overlay')?.remove(); }
      if (action === 'change-base') base.href = '/changed/';
      if (action === 'release') document.querySelector('#gate').textContent = 'Gate released';
      if (action === 'memo') document.querySelector('#memo').value = 'changed externally';
      if (action === 'arm-sensitive-race') {
        const original = document.querySelector('#memo');
        // Reproduce a selector re-resolution race after a field-type read.
        // The replacement runs after the current page evaluation completes.
        Object.defineProperty(original, 'type', { configurable:true, get() {
          queueMicrotask(() => { if (!original.isConnected) return; const replacement = document.createElement('input'); replacement.id = 'memo'; replacement.type = 'password'; replacement.value = 'dynamic-password-must-not-leak'; original.replaceWith(replacement); });
          return 'text';
        }});
      }
      await fetch('/ack?token=' + encodeURIComponent(${JSON.stringify(token)}) + '&sequence=' + sequence, {method:'POST'});
    };`);
}

function virtualList() {
  return document('Virtual results', '<h1>Virtual results</h1><div id="virtual-list" tabindex="0" aria-label="Virtual results" style="height:180px;overflow-y:auto;position:relative;border:1px solid #888"><div style="height:6400px"></div><div id="virtual-rows" style="position:absolute;left:0;right:0;top:0"></div></div><p id="virtual-status">No reservation</p>', `
    const list = document.querySelector('#virtual-list'), rows = document.querySelector('#virtual-rows');
    function render() {
      const start = Math.min(153, Math.floor(list.scrollTop / 40));
      rows.style.top = (start * 40) + 'px';
      rows.replaceChildren();
      for (let index = start; index < Math.min(160, start + 7); index++) {
        const button = document.createElement('button');
        button.textContent = 'Reserve VIRTUAL-' + index;
        button.style.cssText = 'display:block;height:40px;margin:0';
        button.onclick = () => document.querySelector('#virtual-status').textContent = 'Reserved VIRTUAL-' + index;
        rows.append(button);
      }
    }
    list.addEventListener('scroll', render); render();`);
}

/** A public, local-only fixture. Controls mutate real DOM without engine internals. */
export async function startFixture() {
  const streams = new Map();
  const acknowledgements = new Map();
  let sequence = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      response.write(': ready\n\n');
      const token = url.searchParams.get('token');
      streams.set(token, response);
      request.on('close', () => { if (streams.get(token) === response) streams.delete(token); });
      return;
    }
    if (url.pathname === '/ack') {
      acknowledgements.get(`${url.searchParams.get('token')}:${url.searchParams.get('sequence')}`)?.();
      response.writeHead(204).end();
      return;
    }
    let html;
    if (url.pathname === '/' || url.pathname === '/hotel') html = hotel();
    else if (url.pathname === '/results') html = results(url.searchParams);
    else if (url.pathname === '/hotel/casa-flora') html = document('Casa Flora — Tablaze', `<h1>Casa Flora</h1><p id="summary">Lisbon · ${escape(url.searchParams.get('nights') || '1')} nights · ${url.searchParams.get('flexible') === 'yes' ? 'Free cancellation' : 'Standard rate'}</p>`);
    else if (url.pathname === '/lab') html = lab(url.searchParams.get('token') || 'default');
    else if (url.pathname === '/frame') html = document('Nested frame', '<button id="frame-button">Frame action</button><p id="frame-result">Frame idle</p>', "document.querySelector('button').onclick=()=>document.querySelector('p').textContent='Frame complete';");
    else if (url.pathname === '/long') html = document('Long page', '<h1>Long page</h1>' + Array.from({ length: 80 }, (_, index) => `<button>Choice ${index}</button><p>${'Visible fixture prose. '.repeat(10)}</p>`).join(''));
    else if (url.pathname === '/virtual') html = virtualList();
    else if (url.pathname === '/state') html = document('Isolated state', '<button id="remember">Remember this session</button><p id="state"></p>', "const show=()=>document.querySelector('#state').textContent=localStorage.getItem('remembered')?'Remembered':'Fresh session';show();document.querySelector('button').onclick=()=>{localStorage.setItem('remembered','yes');show()};");
    else { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async mutate(token, action) {
      const deadline = Date.now() + 3_000;
      while (!streams.has(token)) {
        if (Date.now() > deadline) throw new Error(`Fixture event stream unavailable: ${token}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const id = ++sequence;
      const key = `${token}:${id}`;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { acknowledgements.delete(key); reject(new Error(`Fixture mutation was not acknowledged: ${action}`)); }, 3_000);
        acknowledgements.set(key, () => { clearTimeout(timer); acknowledgements.delete(key); resolve(); });
        streams.get(token).write(`data: ${JSON.stringify({ action, sequence: id })}\n\n`);
      });
    },
    async close() {
      for (const stream of streams.values()) stream.end();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
