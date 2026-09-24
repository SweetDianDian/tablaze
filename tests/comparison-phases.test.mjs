import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { completionAxes, parseArgs, runComparison, summarizeAttempts } from '../bench/comparison/runner.mjs';

const execute = promisify(execFile);
const fakeModuleDriver = `import asyncio,importlib.util,json,sys,types
from pathlib import Path
config=json.loads(sys.argv[1])
class History:
 def __init__(self): self.done=False;self.success=None;self.items=[]
 def is_done(self): return self.done
 def is_successful(self): return self.success if self.done else None
 def number_of_steps(self): return len(self.items)
 def action_results(self): return self.items
 def final_result(self): return 'Observed done' if self.done else None
class Browser:
 def __init__(self,**kwargs):
  self.downloaded_files=[]
  if config['fixture']=='download_cleanup':
   artifact=Path(kwargs['downloads_path'])/'actual.csv';artifact.write_text('actual downloaded contents');self.downloaded_files.append(str(artifact))
  async def version(): return {'product':'Chrome/fake'}
  self.cdp_client=types.SimpleNamespace(send=types.SimpleNamespace(Browser=types.SimpleNamespace(getVersion=version)))
 async def start(self): pass
 async def kill(self):
  if config['fixture']=='cleanup_timeout': await asyncio.sleep(10)
  self.downloaded_files.clear()
class ChatOpenAI:
 def __init__(self,**kwargs): pass
 async def ainvoke(self,*args,**kwargs):
  if config['fixture']=='judge_timeout': await asyncio.sleep(10)
  if config['fixture']=='judge_error': raise RuntimeError('synthetic judge failure')
  usage=None if config['fixture']=='judge_missing_usage' else types.SimpleNamespace(prompt_tokens=101,completion_tokens=17,prompt_cached_tokens=23,total_tokens=118)
  return types.SimpleNamespace(completion={'verdict':True},usage=usage)
class Agent:
 def __init__(self,**kwargs): self.options=kwargs;self.history=History()
 def save_history(self,path): Path(path).write_text(json.dumps({'history':self.history.items,'done':self.history.done,'use_judge':self.options['use_judge']}))
 async def run(self,max_steps,on_step_end):
  self.history.items.append({'actual_action':'fixture-action'})
  if config['fixture']=='before_done_timeout': await asyncio.sleep(10)
  self.history.done=True;self.history.success=True
  await on_step_end(self)
  if config['fixture']=='after_done_error': raise RuntimeError('synthetic failure after done')
  if self.options['use_judge']: await self.options['judge_llm'].ainvoke([])
  if config['fixture']=='finalization_timeout': await asyncio.sleep(10)
  return self.history
sys.modules['browser_use']=types.SimpleNamespace(Agent=Agent,Browser=Browser,ChatOpenAI=ChatOpenAI)
spec=importlib.util.spec_from_file_location('adapter','bench/comparison/browser-use-adapter.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
result=asyncio.run(module.execute(config))
print(json.dumps(result))`;

async function fakeBrowserUse(t, fixture, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-fake-bu-phases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { fixture, workDirectory: directory, model: 'no-model-calls', gatewayEndpoint: 'http://127.0.0.1:1/v1/chat/completions', executablePath: 'never-launched', prompt: 'Synthetic fake module test', timeoutMs: 150, cleanupTimeoutMs: 30, ...extra };
  const { stdout } = await execute('python3', ['-B', '-c', fakeModuleDriver, JSON.stringify(config)], { timeout: 5000 });
  return { result: JSON.parse(stdout), directory };
}

test('Browser Use retains done, true counts, portable history and judge phase when post-task judge times out', async t => {
  const { result, directory } = await fakeBrowserUse(t, 'judge_timeout');
  assert.equal(result.agentStatus, 'limit_reached');
  assert.equal(result.steps, 1);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.claimedSuccess, true);
  assert.equal(result.completion.agentDoneObserved, true);
  assert.equal(result.completion.agentSuccessObserved, true);
  assert.equal(result.completion.agentRunReturned, false);
  assert.equal(result.completion.timeoutPhase, 'judge_model');
  assert.equal(result.completion.judgeModelCalls, 1);
  assert.equal(result.completion.judgeUsage.inputTokens, null);
  assert.equal(result.trace.judgeCalls[0].outcome, 'interrupted');
  assert.equal(result.completion.cleanup.status, 'completed');
  assert.equal(result.trace.history.history[0].actual_action, 'fixture-action');
  const done = result.trace.phaseEvents.findIndex(event => event.type === 'agent_done_observed');
  const judge = result.trace.phaseEvents.findIndex(event => event.type === 'judge_model_start');
  assert.ok(done >= 0 && judge > done, 'Public done callback is observed before judge model invocation');
  const persisted = JSON.parse(await readFile(join(directory, 'adapter-progress.json'), 'utf8'));
  assert.equal(persisted.completion.agentDoneObserved, true);
  assert.equal(persisted.toolCalls, 1);
});

test('explicit judge false is preserved and ordinary full return stays distinct from cleanup', async t => {
  assert.equal(parseArgs([]).browserUseJudge, true);
  assert.equal(parseArgs(['--browser-use-judge', 'false']).browserUseJudge, false);
  assert.throws(() => parseArgs(['--browser-use-judge', 'no']));
  const { result } = await fakeBrowserUse(t, 'judge_timeout', { browserUseJudge: false });
  assert.equal(result.agentStatus, 'succeeded');
  assert.equal(result.completion.agentRunReturned, true);
  assert.equal(result.completion.browserUseJudge, false);
  assert.equal(result.completion.judgeModelCalls, 0);
  assert.equal(result.completion.judgeUsage.inputTokens, 0);
  assert.equal(result.trace.history.use_judge, false);
  assert.equal(result.trace.phaseEvents.some(event => event.type === 'judge_model_start'), false);
  assert.equal(completionAxes(result, 100, 150).runReturnedBeforeDeadline, true);
  assert.equal(completionAxes(result, 151, 150).runReturnedBeforeDeadline, false);
});

test('judge usage contains only reported public response values, and judge exceptions retain their original phase', async t => {
  const completed = (await fakeBrowserUse(t, 'ordinary')).result;
  assert.equal(completed.completion.judgeModelCalls, 1);
  assert.equal(completed.completion.judgeUsage.inputTokens, 101);
  assert.equal(completed.completion.judgeUsage.outputTokens, 17);
  assert.equal(completed.completion.judgeUsage.cachedTokens, 23);
  assert.equal(completed.completion.judgeUsage.totalTokens, 118);
  assert.equal(completed.trace.judgeCalls[0].usage.prompt_cache_creation_tokens, null);
  const unknown = (await fakeBrowserUse(t, 'judge_missing_usage')).result;
  assert.equal(unknown.completion.judgeUsage.inputTokens, null);
  const error = (await fakeBrowserUse(t, 'judge_error')).result;
  assert.equal(error.completion.errorPhase, 'judge_model');
  assert.equal(error.trace.error_type, 'RuntimeError');
  assert.equal(error.completion.judgeUsage.inputTokens, null);
});

test('pre-done timeout, post-done exception and non-judge finalization timeout preserve distinct observed phases', async t => {
  const before = (await fakeBrowserUse(t, 'before_done_timeout')).result;
  assert.equal(before.completion.agentDoneObserved, false);
  assert.equal(before.completion.agentSuccessObserved, null);
  assert.equal(before.completion.timeoutPhase, 'agent_run');
  assert.equal(before.toolCalls, 1);
  const crashed = (await fakeBrowserUse(t, 'after_done_error')).result;
  assert.equal(crashed.agentStatus, 'failed');
  assert.equal(crashed.completion.agentDoneObserved, true);
  assert.equal(crashed.trace.error_type, 'RuntimeError');
  assert.equal(crashed.trace.history.history.length, 1);
  const finalizing = (await fakeBrowserUse(t, 'finalization_timeout')).result;
  assert.equal(finalizing.completion.timeoutPhase, 'post_done_processing');
  assert.ok(finalizing.trace.phaseEvents.some(event => event.type === 'judge_model_end' && event.outcome === 'returned'));
  assert.match(finalizing.completion.postDonePhaseMeaning, /inferred/);
});

test('owned cleanup has a bounded outcome and cannot silently count as a completed run', async t => {
  const { result } = await fakeBrowserUse(t, 'cleanup_timeout');
  assert.equal(result.completion.agentRunReturned, true);
  assert.equal(result.completion.cleanup.status, 'timeout');
  assert.equal(completionAxes(result, 100, 150).runReturnedBeforeDeadline, false);
});

test('Browser Use retains observed download paths when public kill resets browser metadata', async t => {
  const { result } = await fakeBrowserUse(t, 'download_cleanup');
  assert.equal(result.completion.cleanup.status, 'completed');
  assert.equal(result.artifactPaths.length, 1);
  assert.equal(await readFile(result.artifactPaths[0], 'utf8'), 'actual downloaded contents');
});

test('runner reports independent business success, observed agent done, and full return as separate axes after adapter failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-phase-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const python = join(directory, 'fake-python');
  await writeFile(python, `#!${process.execPath}
import {writeFile} from 'node:fs/promises';import{join}from'node:path';
if(process.argv.includes('--preflight'))console.log(JSON.stringify({status:'ready',version:'fake'}));
else{let raw='';for await(const part of process.stdin)raw+=part;const c=JSON.parse(raw);
const url=c.prompt.match(/http:\\/\\/127\\.0\\.0\\.1:[0-9]+\\/r\\/[^\\s]+\\//)[0];
await fetch(url+'save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Ada',city:'Lisbon'})});
const result={agentStatus:'limit_reached',claimedSuccess:true,steps:2,toolCalls:3,artifactPaths:[],completion:{agentDoneObserved:true,agentSuccessObserved:true,agentRunReturned:false,timedOut:true,timeoutPhase:'judge_model',cleanup:{status:'completed'}},trace:{history:[{actual_action:'saved'}],phaseEvents:[{type:'agent_done_observed',atMs:1},{type:'judge_model_start',atMs:2}]}};
await writeFile(join(c.workDirectory,'adapter-progress.json'),JSON.stringify(result));process.stderr.write('misleading stderr: no actual outcome may be parsed here');process.exitCode=3;}
`, { mode: 0o700 });
  const output = join(directory, 'report');
  const { report } = await runComparison({ engine: 'browser-use', tasks: ['form'], python, executablePath: process.execPath, model: 'fake', endpoint: 'http://127.0.0.1:1/never-called', allowAnonymous: true, output, timeoutMs: 3000 });
  const record = report.attempts[0];
  assert.equal(record.businessPassed, true);
  assert.equal(record.outcome, 'passed');
  assert.equal(record.agentDoneObserved, true);
  assert.equal(record.agentSuccessObserved, true);
  assert.equal(record.runReturnedBeforeDeadline, false);
  assert.equal(record.steps, 2);
  assert.equal(record.toolCalls, 3);
  assert.equal(record.modelCalls, 0);
  assert.deepEqual(record.engineOptions, { useJudge: true });
  assert.deepEqual(report.environment.engineOptions.tablaze, { initializeUrl: false, directOpenTaskUrl: false, popupPolicy: 'stay' });
  assert.match(report.environment.deadlineScope, /common absolute deadline/);
  assert.equal(report.environment.historicalTimingComparable, false);
  assert.equal(report.summary['browser-use'].passed, 1);
  assert.equal(report.summary['browser-use'].completedAndPassed, 0);
  assert.equal(report.summary['browser-use'].allAxesPassed, 0);
  const portable = JSON.parse(await readFile(record.tracePath, 'utf8'));
  assert.deepEqual(portable.history, [{ actual_action: 'saved' }]);
  assert.equal(portable.comparisonOutcome.runFailureClass, 'adapter_process_failed');
  await assert.rejects(runComparison({ engine: 'tablaze-scripted', tasks: ['form'], output }), /already contains results/);
});

test('summary retains legacy completedAndPassed while adding explicit axes', () => {
  const summary = summarizeAttempts([{ outcome: 'passed', agentStatus: 'succeeded', businessPassed: true, agentDoneObserved: true, agentSuccessObserved: true, runReturnedBeforeDeadline: false }]);
  assert.equal(summary.passed, 1);
  assert.equal(summary.completedAndPassed, 1);
  assert.equal(summary.allAxesPassed, 0);
});

test('Tablaze flags reach the official SDK, and proposed finish stays distinct from accepted completion', async t => {
  assert.equal(parseArgs([]).tablazeInitializeUrl, false);
  assert.equal(parseArgs([]).tablazeDirectOpenTaskUrl, false);
  assert.equal(parseArgs([]).tablazePopupPolicy, 'stay');
  assert.equal(parseArgs(['--tablaze-initialize-url', 'true']).tablazeInitializeUrl, true);
  assert.equal(parseArgs(['--tablaze-direct-open-task-url', 'true']).tablazeDirectOpenTaskUrl, true);
  assert.equal(parseArgs(['--tablaze-popup-policy', 'follow-single']).tablazePopupPolicy, 'follow-single');
  assert.throws(() => parseArgs(['--tablaze-initialize-url', 'auto']));
  assert.throws(() => parseArgs(['--tablaze-direct-open-task-url', 'auto']));
  assert.throws(() => parseArgs(['--tablaze-initialize-url', 'true', '--tablaze-direct-open-task-url', 'true']));
  assert.throws(() => parseArgs(['--tablaze-popup-policy', 'all']));
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-fake-sdk-phases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Replace only the adapter's SDK imports in an isolated child process. No
  // browser or planner request is made; the real adapter and cleanup run.
  const serverSource = `export function createServer(options){globalThis.serverOptions=options;return{server:{},engine:{browserPromise:Promise.resolve({version:()=>"fake",close:async()=>{}})},dispose:()=>process.env.FAKE_PHASE==='cleanup'?new Promise(()=>{}):Promise.resolve()}}`;
  const agentSource = `export async function connectAgentTools(){return{tools:{listTools:async()=>[],callTool:async()=>{throw Error("not called")}},close:async()=>{}}}
export function createOpenAICompatiblePlanner(){return async()=>({type:'finish',summary:'proposal only',evidence:['fake']})}
export async function runAgent(options){await options.planner({messages:[]});options.onEvent({type:'feedback',step:1,code:'FIXTURE',message:'fake SDK boundary'});return{status:process.env.FAKE_PHASE==='planner_failure'?'failed':process.env.FAKE_PHASE==='rejected'?'limit_reached':'succeeded',...(process.env.FAKE_PHASE==='planner_failure'?{failure:{phase:'planner',code:'PLANNER_HTTP_ERROR',retryable:true,httpStatus:502}}:{}),reason:'Fixture result',steps:1,toolCalls:0,events:[],sdkOptions:{startUrl:options.startUrl??null,directOpenTaskUrl:options.directOpenTaskUrl,popupPolicy:globalThis.serverOptions.popupPolicy}}}`;
  const loader = join(directory, 'loader.mjs');
  await writeFile(loader, `const replacements=${JSON.stringify({ '/dist/server.js': serverSource, '/dist/agent.js': agentSource })};export async function resolve(specifier,context,next){for(const[key,source]of Object.entries(replacements)){if(specifier.endsWith(key))return{url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true}}return next(specifier,context)}`);
  const driver = `import {runTablaze} from './bench/comparison/tablaze-adapter.mjs';const config=JSON.parse(process.argv[1]);console.log(JSON.stringify(await runTablaze({url:'http://127.0.0.1:1/trusted-fixture/',prompt:'Task text contains a different untrusted URL http://example.invalid/'},config)))`;
  const run = async (fixture, extra = {}) => {
    const { stdout } = await execute(process.execPath, ['--no-warnings', '--loader', loader, '--input-type=module', '-e', driver, JSON.stringify({ mode: 'model', timeoutMs: 1000, workDirectory: directory, cleanupTimeoutMs: 10, ...extra })], { env: { ...process.env, FAKE_PHASE: fixture }, timeout: 3000 });
    return JSON.parse(stdout);
  };
  const defaults = await run('ordinary');
  assert.deepEqual(defaults.trace.sdkOptions, { startUrl: null, directOpenTaskUrl: false, popupPolicy: 'stay' });
  assert.equal(defaults.completion.agentDoneObserved, true);
  assert.equal(defaults.completion.agentSuccessObserved, true);
  assert.equal(completionAxes(defaults, 100, 1000).runReturnedBeforeDeadline, true);
  const rejected = await run('rejected', { tablazeInitializeUrl: true, tablazePopupPolicy: 'follow-single' });
  assert.deepEqual(rejected.trace.sdkOptions, { startUrl: 'http://127.0.0.1:1/trusted-fixture/', directOpenTaskUrl: false, popupPolicy: 'follow-single' });
  const taskUrl = await run('ordinary', { tablazeDirectOpenTaskUrl: true });
  assert.deepEqual(taskUrl.trace.sdkOptions, { startUrl: null, directOpenTaskUrl: true, popupPolicy: 'stay' });
  assert.equal(rejected.completion.proposedReport.type, 'finish');
  assert.equal(rejected.completion.agentDoneObserved, false);
  assert.equal(rejected.completion.agentSuccessObserved, null);
  const failed = await run('planner_failure');
  assert.equal(failed.agentStatus, 'failed');
  assert.deepEqual(failed.failure, { phase: 'planner', code: 'PLANNER_HTTP_ERROR', retryable: true, httpStatus: 502 });
  assert.equal(failed.trace.comparison.errorType, null, 'A failed AgentResult is not an adapter exception');
  assert.equal(failed.completion.agentRunReturned, true);
  assert.equal(failed.completion.agentDoneObserved, false);
  const cleanup = await run('cleanup');
  assert.equal(cleanup.completion.cleanup.status, 'timeout');
  assert.equal(cleanup.completion.agentDoneObserved, true);
  assert.equal(completionAxes(cleanup, 100, 1000).runReturnedBeforeDeadline, false);
});
