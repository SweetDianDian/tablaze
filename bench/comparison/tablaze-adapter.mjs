import { performance } from 'node:perf_hooks';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const call = (name, args = {}) => ({ type: 'tools', calls: [{ name, arguments: args }] });
const payload = result => result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);

/** A fixture-aware script validates the harness and tools, never model ability. */
export function scriptedPlanner(attempt, { initialized = false } = {}) {
  let initialPage;
  function* workflow() {
    let page = initialized ? initialPage : (yield call('tab_open', { url: attempt.url })).data;
    const find = name => {
      const element = page.elements?.find(element => element.name === name);
      if (!element) throw new Error(`Script fixture control unavailable: ${name}`);
      return element.ref;
    };
    function* act(actions) {
      const result = yield call('tab_act', { session_id: page.session_id, snapshot_id: page.snapshot_id, actions });
      if (result.data.ok === false) throw new Error('Scripted action failed; inspect tool trace');
      page = result.data.snapshot ?? page;
      return result.data;
    }
    function* click(name) { return yield* act([{ type: 'click', ref: find(name) }]); }
    function* wait(text) { return yield* act([{ type: 'wait', text, timeout_ms: 5000 }]); }
    let checks = [{ kind: 'text', contains: 'Saved successfully' }];
    switch (attempt.taskId) {
      case 'form':
        yield* act([{ type: 'fill', ref: find('Name'), value: 'Ada' }, { type: 'fill', ref: find('City'), value: 'Lisbon' }, { type: 'click', ref: find('Save contact') }]); break;
      case 'pagination': yield* click('Next results'); yield* click('Reserve CEDAR'); break;
      case 'dynamic-menu': yield* click('Open delivery menu'); yield* wait('Express delivery'); yield* click('Express delivery'); break;
      case 'popup': {
        yield* click('Open approval tab');
        const tabs = (yield call('tab_tabs', { session_id: page.session_id, action: 'list' })).data.tabs;
        const popup = tabs.find(tab => tab.url === `${attempt.url}approval`);
        if (!popup) throw new Error('Script fixture approval tab unavailable');
        page = (yield call('tab_tabs', { session_id: page.session_id, action: 'switch', tab_id: popup.tab_id })).data;
        yield* click('Approve request 42'); break;
      }
      case 'shadow-form': yield* act([{ type: 'fill', ref: find('Shadow note'), value: 'Orion' }, { type: 'click', ref: find('Save shadow note') }]); break;
      case 'iframe-form':
        page = (yield call('tab_snapshot', { session_id: page.session_id, frame_id: page.frames.find(frame => !frame.is_main).frame_id })).data;
        yield* act([{ type: 'fill', ref: find('Frame note'), value: 'Vega' }, { type: 'click', ref: find('Save frame note') }]); break;
      case 'large-page':
        page = (yield call('tab_snapshot', { session_id: page.session_id, selector: '#final' })).data;
        yield* click('Final target'); break;
      case 'virtual-list': {
        const container = page.elements.find(element => element.scrollable?.y && element.name === 'Virtual results');
        if (!container) throw new Error('Script fixture virtual container unavailable');
        const found = (yield call('tab_find', { session_id: page.session_id, snapshot_id: page.snapshot_id, container_ref: container.ref, text: 'VIRTUAL-130', max_scrolls: 80 })).data;
        if (!found.found) throw new Error('Script fixture virtual target not found');
        page = found.snapshot;
        yield* click('Reserve VIRTUAL-130');
        break;
      }
      case 'canvas':
        yield call('tab_capture', { session_id: page.session_id });
        // This fixed fixture coordinate is explicitly scripted, not a vision model result.
        yield* act([{ type: 'click_xy', x: 220, y: 130 }]); break;
      case 'upload': yield* act([{ type: 'upload', ref: find('Document'), files: [attempt.uploadPath] }]); break;
      case 'download': {
        yield* click('Download quarterly CSV');
        const listed = (yield call('tab_downloads', { session_id: page.session_id })).data;
        yield call('tab_downloads', { session_id: page.session_id, download_id: listed.downloads[0].id, timeout_ms: 5000 });
        checks = [{ kind: 'text', contains: 'The download contains the quarterly report.' }]; break;
      }
      case 'state': yield* click('Remember session'); yield* click('Check remembered state'); yield* click('Check remembered state'); break;
      case 'duplicate-write':
        yield* click('Create order'); yield* wait('Response interrupted'); yield* click('Inspect receipt');
        checks = [{ kind: 'text', contains: 'Orders recorded: 1' }]; break;
      case 'extraction': {
        const extracted = (yield call('tab_extract', { session_id: page.session_id, kind: 'table' })).data;
        const total = extracted.items.slice(1).reduce((sum, row) => sum + Number(row[1]) * Number(row[2]), 0);
        yield* act([{ type: 'fill', ref: find('Total'), value: String(total) }, { type: 'click', ref: find('Submit total') }]); break;
      }
      default: throw new Error('No script for fixture task');
    }
    const verification = yield call('tab_verify', { session_id: page.session_id, checks, timeout_ms: 5000 });
    return { type: 'finish', summary: 'Scripted workflow reached its explicit page check; independent judging follows.', evidence: [verification.toolCallId] };
  }
  let iterator;
  return async ({ messages }) => {
    const previous = messages.filter(message => message.role === 'tool').at(-1);
    if (!iterator) {
      if (initialized) {
        if (previous?.name !== 'tab_open') throw new Error('Script fixture expected executor initialization');
        initialPage = payload(previous.result);
      }
      iterator = workflow();
    }
    return iterator.next(previous ? { data: payload(previous.result), toolCallId: previous.toolCallId } : undefined).value;
  };
}

export async function runTablaze(attempt, config) {
  const started = performance.now();
  const deadlineAtMs = config.deadlineAtMs ?? Date.now() + (config.timeoutMs ?? 120000);
  const phaseEvents = [];
  const phase = (type, details = {}) => phaseEvents.push({ type, atMs: performance.now() - started, ...details });
  const completion = { agentDoneObserved: false, agentSuccessObserved: null, agentDoneAtMs: null, agentDoneSource: 'accepted runAgent result, not a proposed finish', agentRunReturned: false, timedOut: false, timeoutPhase: null, cleanup: { status: 'not_started', elapsedMs: null } };
  const { createServer } = await import('../../dist/server.js');
  const { connectAgentTools, createOpenAICompatiblePlanner, runAgent } = await import('../../dist/agent.js');
  const runtime = createServer({ channel: config.channel, executablePath: config.executablePath, timeoutMs: 5000, popupPolicy: config.tablazePopupPolicy ?? 'stay' });
  let connection, result, failure, browserVersion = null, proposedReport;
  const observedEvents = [];
  const retained = [];
  const artifactPaths = new Set();
  let toolTimeMs = 0;
  try {
    connection = await connectAgentTools(runtime.server);
    const tools = {
      listTools: options => connection.tools.listTools(options),
      async callTool(call, options) {
        const start = performance.now();
        try {
          const result = await connection.tools.callTool(call, options);
          const data = payload(result);
          for (const download of data.downloads ?? []) if (download.status === 'completed' && download.path) artifactPaths.add(download.path);
          return result;
        } finally { toolTimeMs += performance.now() - start; }
      },
    };
    const originalPlanner = config.mode === 'scripted' ? scriptedPlanner(attempt, { initialized: config.tablazeInitializeUrl === true }) : createOpenAICompatiblePlanner({
      endpoint: config.gatewayEndpoint, model: config.model, apiKey: 'local-benchmark-gateway', supportsImages: true,
    });
    const planner = async input => {
      const decision = await originalPlanner(input);
      if (decision.type === 'finish' || decision.type === 'fail') {
        proposedReport = { type: decision.type, atMs: performance.now() - started, ...(decision.type === 'fail' ? { reason: decision.reason } : {}) };
        phase('report_proposed', { reportType: decision.type });
      }
      return decision;
    };
    phase('agent_run_start');
    result = await runAgent({ task: attempt.prompt, ...(config.tablazeInitializeUrl === true ? { startUrl: attempt.url } : {}), planner, tools, maxSteps: config.maxSteps ?? 40, maxToolCalls: config.maxToolCalls ?? 150, timeoutMs: Math.max(1, deadlineAtMs - Date.now()), onEvent: event => {
      observedEvents.push(event);
      phase(event.type, { step: event.step, ...(event.call ? { tool: event.call.name } : {}) });
    } });
    completion.agentRunReturned = true;
    completion.timedOut = result.status === 'limit_reached' && Date.now() >= deadlineAtMs;
    completion.timeoutPhase = completion.timedOut ? phaseEvents.at(-1)?.type ?? 'agent_run' : null;
    const acceptedSuccess = result.status === 'succeeded';
    const acceptedFailure = result.status === 'failed' && proposedReport?.type === 'fail' && result.reason === proposedReport.reason;
    completion.agentDoneObserved = acceptedSuccess || acceptedFailure;
    completion.agentSuccessObserved = completion.agentDoneObserved ? acceptedSuccess : null;
    completion.agentDoneAtMs = completion.agentDoneObserved ? performance.now() - started : null;
    completion.proposedReport = proposedReport ?? null;
    phase('agent_run_returned', { status: result.status });
    const browser = await runtime.engine.browserPromise?.catch(() => undefined);
    browserVersion = browser?.version() ?? null;
    if (artifactPaths.size) {
      await mkdir(join(config.workDirectory, 'downloads'), { recursive: true });
      for (const source of artifactPaths) {
        const destination = join(config.workDirectory, 'downloads', `${retained.length}.download`);
        await copyFile(source, destination); retained.push(destination);
      }
    }
  } catch (error) {
    failure = error.name ?? 'Error';
    phase('adapter_error', { errorType: failure });
  } finally {
    const cleanupStart = performance.now();
    phase('cleanup_start');
    let timer;
    const cleanup = (async () => {
      const results = await Promise.allSettled([connection?.close(), runtime.dispose()]);
      const artifacts = await runtime.engine.artifactDirectory?.catch(() => undefined);
      if (artifacts) await rm(artifacts, { recursive: true, force: true });
      return results.some(item => item.status === 'rejected') ? 'failed' : 'completed';
    })();
    try {
      completion.cleanup.status = await Promise.race([cleanup, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(10, Math.min(config.cleanupTimeoutMs ?? 5000, 10000))); })]);
    } catch { completion.cleanup.status = 'failed'; }
    finally { clearTimeout(timer); }
    if (completion.cleanup.status !== 'completed') {
      failure ??= 'CleanupIncomplete';
      // This adapter only launches an isolated browser. A best-effort final close
      // targets that owned browser; incomplete cleanup never counts as complete.
      void runtime.engine.browserPromise?.then(browser => browser.close()).catch(() => {});
    }
    completion.cleanup.elapsedMs = performance.now() - cleanupStart;
    completion.adapterElapsedMs = performance.now() - started;
    phase('cleanup_end', { status: completion.cleanup.status });
  }
  return { agentStatus: failure ? 'failed' : result?.status ?? 'failed', claimedSuccess: completion.agentSuccessObserved === true,
    ...(result?.failure ? { failure: result.failure } : {}),
    steps: result?.steps ?? null, toolCalls: result?.toolCalls ?? null, browserVersion, toolTimeMs, artifactPaths: retained, completion,
    trace: { ...(result ?? { status: 'failed', events: observedEvents }), comparison: { completion, phaseEvents, errorType: failure ?? null } } };
}
