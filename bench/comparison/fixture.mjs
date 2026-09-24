import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const TASKS = Object.freeze([
  { id: 'form', tags: ['forms'], instruction: 'Save a contact named Ada with city Lisbon.' },
  { id: 'pagination', tags: ['navigation', 'pagination'], instruction: 'Find record CEDAR across the result pages and reserve that record.' },
  { id: 'dynamic-menu', tags: ['dynamic_ui', 'wait'], instruction: 'Open the delayed menu and choose Express delivery.' },
  { id: 'popup', tags: ['tabs'], instruction: 'Open the approval tab and approve request 42 there.' },
  { id: 'auth-return', tags: ['authentication', 'tabs', 'cross_origin', 'state'], instruction: 'Connect the account in the provider popup, return to the original app tab, and finish the connection exactly once.' },
  { id: 'network-receipt', tags: ['authentication', 'tabs', 'network', 'extraction'], instruction: 'Connect the account in the provider popup, read the receipt reference from the authenticated network response, and submit that reference exactly once in the original app tab.' },
  { id: 'shadow-form', tags: ['shadow_dom', 'forms'], instruction: 'Save shadow-component note Orion.' },
  { id: 'readonly-listbox', tags: ['forms', 'listbox', 'callback'], instruction: 'Choose Business in the read-only Travel category picker. The application saves through the picker option click; choose it exactly once.' },
  { id: 'iframe-form', tags: ['iframe', 'forms'], instruction: 'Save frame-component note Vega.' },
  { id: 'large-page', tags: ['large_dom', 'targeting'], instruction: 'Find and activate Final target after the long list of decoy controls.' },
  { id: 'virtual-list', tags: ['virtual_list', 'targeting', 'scroll'], instruction: 'Find VIRTUAL-130 in the virtualized results list and reserve that row exactly once. Only nearby rows exist in the DOM.' },
  { id: 'canvas', tags: ['vision', 'coordinates'], instruction: 'Use the canvas to click the blue rectangle once. The canvas displays the target visually.' },
  { id: 'upload', tags: ['files', 'upload'], instruction: 'Upload the supplied document and wait for the received-file receipt.' },
  { id: 'download', tags: ['files', 'download'], instruction: 'Download the quarterly CSV and keep the actual downloaded file as an output artifact.' },
  { id: 'state', tags: ['state', 'navigation'], instruction: 'Remember the session, then open the Check remembered state link and check it. The remembered token must survive navigation.' },
  { id: 'duplicate-write', tags: ['recovery', 'duplicate_writes'], instruction: 'Create exactly one order. The server may report an interrupted response after saving. Inspect the receipt before retrying; do not create a second order.' },
  { id: 'extraction', tags: ['extraction', 'tables'], instruction: 'Read the table and submit the total cost of all rows with quantity times unit price.' },
  { id: 'two-page', tags: ['tabs', 'initial_actions', 'cross_page'], instruction: 'Read the source code from the source page, then enter it on the destination page and submit exactly once.' },
]);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const script = value => JSON.stringify(value).replace(/</g, '\\u003c');

function page(attempt, route) {
  const prefix = `/r/${attempt.id}`;
  const post = `async function save(value){const r=await fetch(${script(prefix + '/save')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});const body=await r.json();document.querySelector('#status').textContent=body.message;}`;
  let body;
  switch (attempt.task.id) {
    case 'form': body = `<label>Name<input id="name"></label><label>City<input id="city"></label><button onclick="save({name:document.querySelector('#name').value,city:document.querySelector('#city').value})">Save contact</button>`; break;
    case 'pagination': {
      const second = route === 'page2';
      body = second ? '<p>Record CEDAR</p><button onclick="save({record:\'CEDAR\'})">Reserve CEDAR</button>' : `<p>Record ASPEN</p><a href="${prefix}/page2">Next results</a>`;
      break;
    }
    case 'dynamic-menu': body = `<button onclick="setTimeout(()=>document.querySelector('#menu').innerHTML=\`<button onclick='save({delivery:&quot;Express&quot;})'>Express delivery</button>\`,100)">Open delivery menu</button><div id="menu"></div>`; break;
    case 'popup': body = route === 'approval' ? '<button onclick="save({approved:42})">Approve request 42</button>' : `<a href="${prefix}/approval" target="_blank">Open approval tab</a>`; break;
    case 'auth-return': body = `<a href="${attempt.authUrl}" target="_blank" rel="opener">Connect account</a><p id="connection">Not connected</p><button id="finish" disabled>Finish connection</button><script>
      document.querySelector('#finish').onclick=()=>save({token:sessionStorage.getItem(${script('authorized-' + attempt.id)})});
      addEventListener('message',event=>{if(event.origin!==${script(attempt.authOrigin)}||event.data?.kind!=='fixture-authorization'||typeof event.data.token!=='string')return;sessionStorage.setItem(${script('authorized-' + attempt.id)},event.data.token);document.querySelector('#connection').textContent='Account connected';document.querySelector('#finish').disabled=false});</script>`; break;
    case 'network-receipt': body = `<a href="${attempt.authUrl}" target="_blank" rel="opener">Connect account</a><p id="connection">Not connected</p><label>Receipt reference<input id="reference" autocomplete="off"></label><button id="submit" disabled>Submit receipt</button><script>
      document.querySelector('#submit').onclick=()=>save({reference:document.querySelector('#reference').value});
      addEventListener('message',async event=>{if(event.origin!==${script(attempt.authOrigin)}||event.data?.kind!=='fixture-authorization'||typeof event.data.token!=='string')return;
        document.querySelector('#connection').textContent='Account connected; receipt API loading';
        const response=await fetch(${script(prefix + '/network.json')},{headers:{'X-Authorization':event.data.token}});
        if(!response.ok){document.querySelector('#connection').textContent='Receipt API denied';return}
        await response.json();document.querySelector('#connection').textContent='Receipt API returned. Read its network response for the reference.';document.querySelector('#submit').disabled=false});</script>`; break;
    case 'shadow-form': body = `<section id="component"></section><script>document.querySelector('#component').attachShadow({mode:'open'}).innerHTML='<label>Shadow note<input id="note"></label><button>Save shadow note</button>';const root=document.querySelector('#component').shadowRoot;root.querySelector('button').onclick=()=>save({note:root.querySelector('input').value});</script>`; break;
    case 'readonly-listbox': body = `<label for="category">Travel category</label><input id="category" readonly aria-controls="category-picker" onclick="document.querySelector('#category-picker').style.display='block'">
      <select id="category-picker" size="5" style="display:none" onclick="document.querySelector('#category').value=this.value;this.style.display='none';save({category:this.value,callback:'native-option-click'})">
      ${attempt.seed % 2 ? '<option value="holiday">Holiday</option><option value="business">Business</option>' : '<option value="business">Business</option><option value="holiday">Holiday</option>'}
      <option value="other">Other</option></select>`; break;
    case 'iframe-form': body = route === 'frame' ? '<label>Frame note<input id="note"></label><button onclick="save({note:document.querySelector(\'#note\').value})">Save frame note</button>' : `<iframe title="Note editor" src="${prefix}/frame" width="600" height="240"></iframe>`; break;
    case 'large-page': body = Array.from({ length: 520 }, (_, i) => `<button>Decoy ${i + 1}</button>`).join('') + `<section id="final"><button onclick="save({target:'final'})">Final target</button></section>`; break;
    case 'virtual-list': body = `<h1>Virtual results</h1><div id="virtual-list" tabindex="0" aria-label="Virtual results" style="height:180px;overflow-y:auto;position:relative;border:1px solid #888"><div style="height:6400px"></div><div id="virtual-rows" style="position:absolute;left:0;right:0;top:0"></div></div><script>
      const list=document.querySelector('#virtual-list'),rows=document.querySelector('#virtual-rows');
      function render(){const start=Math.min(153,Math.floor(list.scrollTop/40));rows.style.top=(start*40)+'px';rows.replaceChildren();for(let i=start;i<Math.min(160,start+7);i++){const button=document.createElement('button');button.textContent='Reserve VIRTUAL-'+i;button.style.cssText='display:block;height:40px;margin:0';button.onclick=()=>save({record:'VIRTUAL-'+i});rows.append(button)}}
      list.addEventListener('scroll',render);render();</script>`; break;
    case 'canvas': body = `<canvas id="canvas" width="500" height="260" style="display:block;border:1px solid black"></canvas><script>const canvas=document.querySelector('#canvas'),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,500,260);ctx.fillStyle='blue';ctx.fillRect(150,80,120,80);canvas.onclick=event=>{const box=canvas.getBoundingClientRect();save({x:event.clientX-box.left-1,y:event.clientY-box.top-1});};</script>`; break;
    case 'upload': body = `<label>Document<input type="file" id="file"></label><script>document.querySelector('#file').onchange=async event=>save({content:await event.target.files[0].text()});</script>`; break;
    case 'download': body = `<a href="${prefix}/report.csv" download>Download quarterly CSV</a><p>The download contains the quarterly report.</p>`; break;
    case 'state': body = route === 'check' ? `<button onclick='save({token:localStorage.getItem(${script('remember-' + attempt.id)})})'>Check remembered state</button>` : `<button onclick='localStorage.setItem(${script('remember-' + attempt.id)},${script(attempt.token)});document.querySelector("#status").textContent="Session remembered"'>Remember session</button><a href="${prefix}/check">Check remembered state</a>`; break;
    case 'duplicate-write': body = route === 'receipt' ? `<p id="receipt">Orders recorded: ${attempt.records.length}</p><p>${attempt.records.length ? 'Order receipt ready' : 'No receipt'}</p>` : `<button onclick="save({order:'one'})">Create order</button><a href="${prefix}/receipt">Inspect receipt</a>`; break;
    case 'extraction': body = `<table><tr><th>Item</th><th>Quantity</th><th>Unit price</th></tr><tr><td>Pencils</td><td>3</td><td>${attempt.price}</td></tr><tr><td>Pads</td><td>2</td><td>7</td></tr></table><label>Total<input id="total"></label><button onclick="save({total:Number(document.querySelector('#total').value)})">Submit total</button>`; break;
    case 'two-page': body = route === 'destination'
      ? `<h1>Destination page</h1><label>Source code<input id="source-code"></label><button onclick="save({code:document.querySelector('#source-code').value})">Submit code</button><a href="${prefix}/source">Source page</a>`
      : `<h1>Source page</h1><p>Source code: <strong>${attempt.sourceCode}</strong></p><a href="${prefix}/destination">Destination page</a>`; break;
    default: throw new Error('Unknown fixture task');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Comparison ${escape(attempt.task.id)}</title><style>body{font:16px sans-serif;margin:8px}label{display:block;margin:8px 0}button,a{margin:4px}table,td,th{border:1px solid #888;padding:5px}</style></head><body><script>${post}</script>${body}<p id="status">Ready</p></body></html>`;
}

async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export async function startTaskService() {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-comparison-fixtures-'));
  const attempts = new Map();
  const authServer = createServer(async (request, response) => {
    try {
      const match = new URL(request.url, 'http://auth-fixture').pathname.match(/^\/r\/([^/]+)\/(.*)$/);
      const attempt = match && attempts.get(match[1]);
      if (!attempt || !['auth-return', 'network-receipt'].includes(attempt.task.id)) { response.writeHead(404); response.end('Unknown authorization'); return; }
      if (match[2] === 'authorize' && request.method === 'POST') {
        attempt.authorizations++;
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ token: attempt.token })); return;
      }
      if (match[2] !== 'auth') { response.writeHead(404); response.end('Unknown authorization route'); return; }
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Provider authorization</title></head><body><h1>Provider authorization</h1><button id="authorize">Authorize account</button><p id="status">Awaiting authorization</p><script>
        document.querySelector('#authorize').onclick=async()=>{const result=await fetch('/r/${attempt.id}/authorize',{method:'POST'});const body=await result.json();window.opener?.postMessage({kind:'fixture-authorization',token:body.token},${script(attempt.appOrigin)});document.querySelector('#status').textContent='Account authorized. Return to the app.';document.querySelector('#authorize').disabled=true};</script></body></html>`);
    } catch { response.writeHead(400); response.end('Invalid authorization request'); }
  });
  const server = createServer(async (request, response) => {
    try {
      const match = new URL(request.url, 'http://fixture').pathname.match(/^\/r\/([^/]+)\/(.*)$/);
      const attempt = match && attempts.get(match[1]);
      if (!attempt) { response.writeHead(404); response.end('Unknown attempt'); return; }
      const route = match[2];
      if (attempt.task.id === 'two-page' && request.method === 'GET') {
        if (route === 'source') attempt.sourceViews++;
        if (route === 'destination') attempt.destinationViews++;
      }
      if (route === 'network.json' && attempt.task.id === 'network-receipt') {
        attempt.receiptRequests++;
        const authorized = request.headers['x-authorization'] === attempt.token && attempt.authorizations === 1;
        const body = JSON.stringify(authorized ? { reference: attempt.receiptReference, status: 'ready' } : { error: 'not authorized' });
        response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
        response.end(body); return;
      }
      if (route === 'save' && request.method === 'POST') {
        const record = await readBody(request); attempt.records.push(record);
        response.writeHead(attempt.task.id === 'duplicate-write' ? 503 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: attempt.task.id === 'duplicate-write' ? 'Response interrupted; inspect the receipt' : 'Saved successfully' })); return;
      }
      if (route === 'report.csv') {
        attempt.downloadRequests++;
        response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="quarterly.csv"' });
        response.end(attempt.csv); return;
      }
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end(page(attempt, route));
    } catch {
      response.writeHead(400); response.end('Invalid fixture request');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => { authServer.once('error', reject); authServer.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const authBase = `http://127.0.0.1:${authServer.address().port}`;
  return {
    async createAttempt(taskId, seed = 1) {
      const task = TASKS.find(task => task.id === taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (!Number.isInteger(seed) || seed < 0 || seed > 1000000) throw new Error('Seed must be an integer from 0 to 1000000');
      const id = randomUUID(), token = hash(`${taskId}:${seed}`).slice(0, 20), price = seed % 10 + 2;
      const receiptReference = `R-${hash(`receipt:${taskId}:${seed}`).slice(0, 10).toUpperCase()}`;
      const uploadContent = `Comparison document seed=${seed}\n`;
      const uploadPath = join(directory, `${id}.txt`);
      if (taskId === 'upload') await writeFile(uploadPath, uploadContent, { mode: 0o600 });
      const attempt = { id, task, seed, token, price, receiptReference, receiptRequests: 0, records: [], downloadRequests: 0, authorizations: 0, sourceCode: `S-${hash(`source:${taskId}:${seed}`).slice(0, 12).toUpperCase()}`, sourceViews: 0, destinationViews: 0, appOrigin: base, authOrigin: authBase, authUrl: `${authBase}/r/${id}/auth`, uploadContent, csv: `quarter,revenue\nQ1,${100 + seed}\n` };
      attempts.set(id, attempt);
      const canonicalPrompt = taskId === 'two-page' ? `${task.instruction}\nSource page: {{SOURCE_URL}}.\nDestination page: {{DESTINATION_URL}}.` : `${task.instruction}\nStart at {{TASK_URL}}.${taskId === 'upload' ? '\nSupplied document: {{UPLOAD_PATH}}.' : ''}`;
      const url = `${base}/r/${id}/${taskId === 'two-page' ? 'source' : ''}`;
      const initialActionUrls = taskId === 'two-page' ? [url, `${base}/r/${id}/destination`] : null;
      const prompt = canonicalPrompt.replace('{{TASK_URL}}', url).replace('{{SOURCE_URL}}', initialActionUrls?.[0]).replace('{{DESTINATION_URL}}', initialActionUrls?.[1]).replace('{{UPLOAD_PATH}}', uploadPath);
      return {
        id, taskId, seed, tags: task.tags, url, initialActionUrls, authUrl: ['auth-return', 'network-receipt'].includes(taskId) ? attempt.authUrl : null, prompt, canonicalPrompt,
        taskHash: hash(JSON.stringify({ task, seed, canonicalPrompt })),
        uploadPath: taskId === 'upload' ? uploadPath : null,
        async judge({ artifactPaths = [] } = {}) {
          const records = structuredClone(attempt.records);
          const record = records[0];
          const exactOne = records.length === 1;
          let passed = false, artifactHashes = [];
          switch (taskId) {
            case 'form': passed = exactOne && record.name === 'Ada' && record.city === 'Lisbon'; break;
            case 'pagination': passed = exactOne && record.record === 'CEDAR'; break;
            case 'dynamic-menu': passed = exactOne && record.delivery === 'Express'; break;
            case 'popup': passed = exactOne && record.approved === 42; break;
            case 'auth-return': passed = exactOne && record.token === token && attempt.authorizations === 1; break;
            case 'network-receipt': passed = exactOne && record.reference === receiptReference && attempt.authorizations === 1 && attempt.receiptRequests >= 1; break;
            case 'shadow-form': passed = exactOne && record.note === 'Orion'; break;
            case 'readonly-listbox': passed = exactOne && record.category === 'business' && record.callback === 'native-option-click'; break;
            case 'iframe-form': passed = exactOne && record.note === 'Vega'; break;
            case 'large-page': passed = exactOne && record.target === 'final'; break;
            case 'virtual-list': passed = exactOne && record.record === 'VIRTUAL-130'; break;
            case 'canvas': passed = exactOne && record.x >= 150 && record.x <= 270 && record.y >= 80 && record.y <= 160; break;
            case 'upload': passed = exactOne && record.content === uploadContent; break;
            case 'download': {
              for (const path of artifactPaths) {
                try { const content = await readFile(path); artifactHashes.push(hash(content)); } catch { artifactHashes.push(null); }
              }
              passed = attempt.downloadRequests >= 1 && artifactHashes.includes(hash(attempt.csv)); break;
            }
            case 'state': passed = exactOne && record.token === token; break;
            case 'duplicate-write': passed = exactOne && record.order === 'one'; break;
            case 'extraction': passed = exactOne && record.total === price * 3 + 14; break;
            case 'two-page': passed = exactOne && record.code === attempt.sourceCode && attempt.sourceViews >= 1 && attempt.destinationViews >= 1; break;
          }
          return { passed, evidence: { records, writeCount: records.length, duplicateWrites: Math.max(0, records.length - 1), downloadRequests: attempt.downloadRequests, authorizations: attempt.authorizations, receiptRequests: attempt.receiptRequests, sourceViews: attempt.sourceViews, destinationViews: attempt.destinationViews, artifactHashes }, judge: 'fixture-server-state-and-artifact-sha256-v1' };
        },
        reset() { attempt.records.length = 0; attempt.downloadRequests = 0; attempt.authorizations = 0; attempt.receiptRequests = 0; attempt.sourceViews = 0; attempt.destinationViews = 0; },
      };
    },
    async close() { server.closeAllConnections(); authServer.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => authServer.close(resolve))]); await rm(directory, { recursive: true, force: true }); },
  };
}
