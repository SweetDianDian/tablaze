import { performance } from 'node:perf_hooks';
import { runAgent } from '../dist/agent.js';

const steps = Number(process.argv[2] ?? 200);
const payloadBytes = Number(process.argv[3] ?? 2048);
const mode = process.argv[4] ?? 'default';
if (!Number.isInteger(steps) || steps < 1 || steps > 1000 || !Number.isInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > 100_000) throw new Error('Invalid benchmark arguments.');
if (!['default', 'full'].includes(mode)) throw new Error('Mode must be default or full.');
let counter = 0;
const tool = { name: 'tab_snapshot', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { session_id: { type: 'string' } } } };
const tools = {
  async listTools() { return [tool]; },
  async callTool() {
    counter++;
    const data = { ok: true, session_id: 'long-task', snapshot_id: `snapshot-${counter}`, text: `Observation ${counter}: ${'x'.repeat(payloadBytes)}` };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  },
};
const planningBytes = [];
const start = performance.now();
const run = await runAgent({
  task: 'Inspect a changing page across a long task.', tools,
  maxSteps: steps, maxToolCalls: steps, timeoutMs: 600_000,
  ...(mode === 'full' ? { historyCompaction: false } : {}),
  planner: async ({ step, messages }) => {
    planningBytes.push(Buffer.byteLength(JSON.stringify(messages)));
    return step < steps
      ? { type: 'tools', calls: [{ name: 'tab_snapshot', arguments: { session_id: 'long-task' } }] }
      : { type: 'human_input', question: 'Benchmark complete.' };
  },
});
const elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
console.log(JSON.stringify({ mode, steps, payloadBytes, status: run.status, toolCalls: run.toolCalls, plannerCalls: run.plannerCalls, elapsedMs, firstPlanningBytes: planningBytes[0], medianPlanningBytes: planningBytes[Math.floor(planningBytes.length / 2)], finalPlanningBytes: planningBytes.at(-1), totalPlanningBytes: planningBytes.reduce((sum, bytes) => sum + bytes, 0), maxPlanningBytes: Math.max(...planningBytes), finalHistoryBytes: Buffer.byteLength(JSON.stringify(run.history)), checkpointBytes: Buffer.byteLength(JSON.stringify(run.checkpoint)) }));
