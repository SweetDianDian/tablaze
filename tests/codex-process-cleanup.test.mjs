import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexPlanner } from '../dist/index.js';

// A zombie is no longer executing. Some container PID 1 implementations do not
// promptly reap orphaned descendants, so kill(pid, 0) alone is insufficient.
function running(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim();
    return Boolean(state) && !state.startsWith('Z');
  } catch {
    // A failed ps invocation must not falsely certify cleanup of a live PID.
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}

test('successful Codex leader cannot leave an owned stdio-independent descendant running', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-codex-group-test-'));
  const executable = join(directory, 'fake-codex.mjs');
  const pidPath = join(directory, 'descendant.json');
  const usages = [], diagnostics = [];
  let planner, pid;
  try {
    await writeFile(executable, `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const pidPath = process.argv[2];
const outputPath = process.argv[process.argv.indexOf('--output-last-message') + 1];
const childCode = [
  "const {writeFileSync}=require('node:fs');",
  "process.on('SIGTERM',()=>{});",
  "writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}),{mode:0o600});",
  "setInterval(()=>{},1000);"
].join('');
const descendant = spawn(process.execPath, ['-e', childCode, pidPath], { stdio: 'ignore', detached: false });
descendant.unref();
// Deterministic scheduling: the leader waits for the descendant's installed
// SIGTERM handler and PID file before reporting a valid successful inference.
const deadline = Date.now() + 3000;
while (!existsSync(pidPath)) {
  if (Date.now() > deadline) throw new Error('Fixture descendant did not start');
  await delay(10);
}
writeFileSync(outputPath, JSON.stringify({tool_calls:[{name:'test_ping',arguments_json:'{"value":"ready"}'}]}));
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fake-cleanup'})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.started'})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,output_tokens:7,cached_input_tokens:0}})+'\\n');
`, { mode: 0o600 });

    planner = createCodexPlanner({ model: 'fake-no-model-calls', codexCommand: process.execPath, codexCommandArgs: [executable, pidPath], timeoutMs: 5000, onUsage: value => usages.push(value), onDiagnostic: value => diagnostics.push(value) });
    const decision = await planner({ task: 'Return a fixture decision.', messages: [{ role: 'user', content: 'Return a fixture decision.' }], tools: [{ name: 'test_ping', description: 'No actual browser operation.', inputSchema: { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'] } }], step: 0, signal: new AbortController().signal });
    pid = JSON.parse(await readFile(pidPath, 'utf8')).pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(decision.type, 'tools');
    assert.deepEqual(decision.calls, [{ name: 'test_ping', arguments: { value: 'ready' } }]);
    await planner.close();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].status, 'completed');
    assert.equal(diagnostics[0].exitCode, 0);
    assert.equal(diagnostics[0].terminalEvent, 'turn.completed');
    assert.equal(usages.length, 1);
    assert.equal(usages[0].promptTokens, 11);
    assert.equal(usages[0].completionTokens, 7);
    const deadline = Date.now() + 1500;
    while (running(pid) && Date.now() < deadline) await delay(20);
    assert.equal(running(pid), false, 'Successful inference/close must also retire its owned process group');
  } finally {
    await planner?.close().catch(() => {});
    if (pid === undefined) {
      try { pid = JSON.parse(await readFile(pidPath, 'utf8')).pid; } catch { /* Fixture may have failed before creating a child. */ }
    }
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already cleaned by the planner. */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
