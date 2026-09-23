import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BrowserEngine } from '../dist/browser.js';

const execFileAsync = promisify(execFile);
const browserModule = new URL('../dist/browser.js', import.meta.url).href;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = join(projectRoot, 'dist/cli.js');

async function fixture() {
  let writes = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/login/a' || path === '/login/b') {
      const user = path.at(-1).toUpperCase();
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `user=${user}; Path=/; SameSite=Lax; Max-Age=3600` });
      response.end(`<script>
        localStorage.setItem('user','${user}');
        const request=indexedDB.open('tablaze-profile-test',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('identity');
        request.onsuccess=()=>{const transaction=request.result.transaction('identity','readwrite');transaction.objectStore('identity').put('${user}','user');transaction.oncomplete=()=>document.body.insertAdjacentHTML('beforeend','<p>IDB saved</p>')};
      </script><p>Logged in ${user}</p>`);
    } else if (path === '/whoami') {
      const cookie = /(?:^|;\s*)user=([^;]+)/.exec(request.headers.cookie ?? '')?.[1] ?? 'none';
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<p>Cookie ${cookie}</p><p id="local"></p><p id="idb">IDB pending</p><script>
        document.querySelector('#local').textContent='Local '+(localStorage.getItem('user')||'none');
        const request=indexedDB.open('tablaze-profile-test',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('identity');
        request.onsuccess=()=>{const lookup=request.result.transaction('identity').objectStore('identity').get('user');lookup.onsuccess=()=>document.querySelector('#idb').textContent='IDB '+(lookup.result||'none')};
      </script>`);
    } else if (path === '/write') {
      writes++;
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('wrote');
    } else { response.writeHead(404); response.end('missing'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, writes: () => writes, close: () => new Promise(resolve => server.close(resolve)) };
}

const engineFor = (directory, expectedProfileId) => new BrowserEngine({ profileDir: directory, expectedProfileId, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true });

test('owned profile survives a cold browser restart, rejects concurrent use, and isolates same-origin users', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tablaze-owned-profile-'));
  const site = await fixture();
  const pathA = join(root, 'a'), pathB = join(root, 'b');
  const first = engineFor(pathA);
  try {
    const login = await first.open(`${site.base}/login/a`);
    assert.equal(login.session_mode, 'persistent_profile');
    assert.match(login.profile_id, /^[0-9a-f-]{36}$/);
    assert.equal((await first.verify(login.session_id, [{ kind: 'text', contains: 'IDB saved' }], 5000)).passed, true);
    const busy = engineFor(pathA, login.profile_id);
    try { await assert.rejects(busy.open(`${site.base}/write`), error => error.code === 'PROFILE_BUSY'); }
    finally { await busy.dispose(); }
    assert.equal(site.writes(), 0);
    await first.close(login.session_id);
    await first.dispose();

    const missingId = engineFor(pathA);
    try { await assert.rejects(missingId.open(`${site.base}/write`), error => error.code === 'PROFILE_ID_REQUIRED'); }
    finally { await missingId.dispose(); }
    const wrongId = engineFor(pathA, '00000000-0000-4000-8000-000000000000');
    try { await assert.rejects(wrongId.open(`${site.base}/write`), error => error.code === 'PROFILE_ID_MISMATCH'); }
    finally { await wrongId.dispose(); }
    assert.equal(site.writes(), 0, 'a mismatched profile must not navigate to a write URL');

    const childCode = `import { BrowserEngine } from ${JSON.stringify(browserModule)};
      const engine = new BrowserEngine({ profileDir: process.env.PROFILE_DIR, expectedProfileId: process.env.PROFILE_ID, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
      try { const opened = await engine.open(process.env.FIXTURE_URL); const checked = await engine.verify(opened.session_id,[{ kind:'text', contains:'IDB A' }],5000); const fresh = await engine.snapshot(opened.session_id,{}); console.log(JSON.stringify({ text: fresh.text, profileId: opened.profile_id, idbPassed: checked.passed })); await engine.close(opened.session_id); }
      finally { await engine.dispose(); }`;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', childCode], {
      env: { ...process.env, PROFILE_DIR: pathA, PROFILE_ID: login.profile_id, FIXTURE_URL: `${site.base}/whoami` }, timeout: 30_000,
    });
    const who = JSON.parse(stdout.trim());
    assert.equal(who.profileId, login.profile_id);
    assert.equal(who.idbPassed, true);
    assert.match(who.text, /Cookie A/);
    assert.match(who.text, /Local A/);
    assert.match(who.text, /IDB A/);

    const other = engineFor(pathB);
    try {
      const who = await other.open(`${site.base}/whoami`);
      assert.notEqual(who.profile_id, login.profile_id);
      assert.match(JSON.stringify(who), /Cookie none/);
      assert.match(JSON.stringify(who), /Local none/);
      assert.equal((await other.verify(who.session_id, [{ kind: 'text', contains: 'IDB none' }], 5000)).passed, true);
      await other.close(who.session_id);
    } finally { await other.dispose(); }
  } finally { await first.dispose(); await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('an existing unrelated browser directory is never adopted as a Tablaze profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tablaze-foreign-profile-'));
  const directory = join(root, 'other');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'Cookies'), 'other browser data');
  const engine = engineFor(directory);
  try {
    await assert.rejects(engine.open('http://127.0.0.1:1/'), error => error.code === 'PROFILE_UNOWNED');
    assert.equal(await readFile(join(directory, 'Cookies'), 'utf8'), 'other browser data');
  } finally { await engine.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('a failed Chrome launch leaves the profile reusable without exposing its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tablaze-profile-launch-error-'));
  const directory = join(root, 'profile');
  const missingExecutable = join(root, 'PRIVATE-NO-BROWSER');
  const failed = new BrowserEngine({ profileDir: directory, executablePath: missingExecutable });
  const site = await fixture();
  try {
    await assert.rejects(failed.open(`${site.base}/whoami`), error => error.code === 'BROWSER_LAUNCH_FAILED' && !error.message.includes(root));
    await failed.dispose();
    const marker = JSON.parse(await readFile(join(directory, '.tablaze-profile.json'), 'utf8'));
    const recovered = engineFor(directory, marker.id);
    try { const opened = await recovered.open(`${site.base}/whoami`); assert.equal(opened.ok, true); await recovered.close(opened.session_id); }
    finally { await recovered.dispose(); }
  } finally { await failed.dispose(); await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('stdio MCP can reopen its owned profile with an operator-supplied identity', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tablaze-mcp-profile-'));
  const site = await fixture();
  const directory = join(root, 'profile');
  const connect = async id => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [cli, '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--profile-dir', directory, ...(id ? ['--profile-id', id] : [])],
      cwd: projectRoot, env: process.env, stderr: 'pipe' });
    const client = new Client({ name: 'owned-profile-test', version: '1' });
    await client.connect(transport);
    return client;
  };
  const call = async (client, name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  let first, second;
  try {
    first = await connect();
    const login = await call(first, 'tab_open', { url: `${site.base}/login/a` });
    assert.equal(login.ok, true, JSON.stringify(login));
    assert.equal(login.session_mode, 'persistent_profile');
    assert.equal((await call(first, 'tab_verify', { session_id: login.session_id, checks: [{ kind: 'text', contains: 'IDB saved' }] })).passed, true);
    await call(first, 'tab_close', { session_id: login.session_id });
    await first.close(); first = undefined;
    second = await connect(login.profile_id);
    const resumed = await call(second, 'tab_open', { url: `${site.base}/whoami` });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.profile_id, login.profile_id);
    assert.match(resumed.text, /Cookie A/);
    assert.match(resumed.text, /Local A/);
    await call(second, 'tab_close', { session_id: resumed.session_id });
  } finally { await Promise.allSettled([first?.close(), second?.close()]); await site.close(); await rm(root, { recursive: true, force: true }); }
});
