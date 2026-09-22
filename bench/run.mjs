import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { BrowserEngine } from '../dist/browser.js';
import { startFixture } from '../tests/fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const playwrightJson = JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8'));
const sourceHashes = Object.fromEntries(await Promise.all(['dist/browser.js', 'dist/snapshot.js', 'dist/server.js', 'dist/cli.js', 'tests/fixture.mjs', 'bench/run.mjs', 'package-lock.json'].map(async (file) => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
const repetitions = Number(process.env.TABLAZE_BENCH_REPEATS || 5);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) {
  throw new Error('TABLAZE_BENCH_REPEATS must be an integer between 1 and 100');
}
const channel = process.env.TABLAZE_BROWSER_CHANNEL || undefined;
const options = { headless: true, channel, timeoutMs: 5_000 };
const utf8 = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const timed = async (operation) => {
  const start = performance.now();
  const value = await operation();
  return { value, elapsed_ms: Number((performance.now() - start).toFixed(3)) };
};
const ref = (snapshot, name) => {
  const element = snapshot.elements.find((entry) => entry.name === name);
  if (!element) throw new Error(`Fixture control is absent: ${name}`);
  return element.ref;
};
const errorDetails = (error) => ({ code: error?.code || 'BENCHMARK_FAILED', message: error instanceof Error ? error.message : String(error) });
const resultsDir = join(root, 'bench/results');
await mkdir(resultsDir, { recursive: true });
const started = new Date();
const archive = join(resultsDir, `${started.toISOString().replaceAll(':', '-')}.json`);
const report = {
  schema_version: 1,
  status: 'running',
  started_at: started.toISOString(),
  methodology: {
    workload: 'Local hotel form: Lisbon, 3 nights, free cancellation, search; independently check URL and DOM.',
    cold_open: 'New BrowserEngine and browser process per repetition; includes launch, context/page creation, local navigation and first snapshot. This is process-cold, not an empty OS cache or first npm installation.',
    warm_snapshot: 'Three snapshots in the same existing session before input.',
    batch: 'Four sequential actions: fill, select, check, click. Includes navigation and the default returned snapshot. No rollback.',
    verify: 'Fresh outcome checks against URL, rendered text, field value and result count, outside batch timing.',
    transport: 'BrowserEngine API called in-process. Timings exclude MCP transport, model inference, package installation and internet websites.',
    payload: 'UTF-8 JSON bytes as serialized by this benchmark; these are not model tokens.',
    failures: 'All repetitions retained, including failure stage and error; summaries report successful samples separately.',
  },
  environment: {
    tablaze: packageJson.version,
    playwright: playwrightJson.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    cpu: os.cpus()[0]?.model,
    browser_channel: channel || 'playwright-managed-chromium',
    headless: true,
    browser_version: null,
  },
  source_sha256: sourceHashes,
  requested_repetitions: repetitions,
  samples: [],
};
async function save() {
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(archive, contents);
  await writeFile(join(resultsDir, 'latest.json'), contents);
}
await save();
let fixture;
try {
  fixture = await startFixture();
  for (let iteration = 1; iteration <= repetitions; iteration++) {
    const engine = new BrowserEngine(options);
    const sample = { iteration, passed: false, warm_snapshot_ms: [], payload_bytes: {} };
    let stage = 'cold_open';
    try {
      const opened = await timed(() => engine.open(`${fixture.url}/`));
      sample.cold_open_ms = opened.elapsed_ms;
      sample.payload_bytes.open_snapshot = utf8(opened.value);
      const sessionId = opened.value.session_id;
      let observed = opened.value;
      stage = 'warm_snapshot';
      sample.payload_bytes.warm_snapshots = [];
      for (let index = 0; index < 3; index++) {
        const current = await timed(() => engine.snapshot(sessionId));
        sample.warm_snapshot_ms.push(current.elapsed_ms);
        sample.payload_bytes.warm_snapshots.push(utf8(current.value));
        observed = current.value;
      }
      stage = 'batch';
      const batch = await timed(() => engine.act(sessionId, observed.snapshot_id, [
        { type: 'fill', ref: ref(observed, 'Destination'), value: 'Lisbon' },
        { type: 'select', ref: ref(observed, 'Nights'), values: ['3'] },
        { type: 'check', ref: ref(observed, 'Free cancellation'), checked: true },
        { type: 'click', ref: ref(observed, 'Search stays') },
      ]));
      sample.batch_ms = batch.elapsed_ms;
      sample.payload_bytes.batch = utf8(batch.value);
      sample.action_results = batch.value.results;
      if (!batch.value.ok || batch.value.completed !== 4) throw Object.assign(new Error(JSON.stringify(batch.value.failed || batch.value)), { code: 'BATCH_FAILED' });
      stage = 'verification';
      const verdict = await timed(() => engine.verify(sessionId, [
        { kind: 'url', value: `${fixture.url}/results?destination=Lisbon&nights=3&flexible=yes` },
        { kind: 'title', contains: 'Hotel results' },
        { kind: 'text', contains: '3 nights · Free cancellation' },
        { kind: 'value', selector: '#destination', value: 'Lisbon' },
        { kind: 'count', selector: '[data-hotel="casa-flora"]', value: 1 },
      ], 1_000));
      sample.verification_ms = verdict.elapsed_ms;
      sample.payload_bytes.verification = utf8(verdict.value);
      sample.verification = verdict.value;
      if (!verdict.value.passed) throw new Error('Independent outcome verification failed');
      sample.passed = true;
    } catch (error) {
      sample.failure = { stage, ...errorDetails(error) };
    } finally {
      try { await engine.dispose(); } catch (error) { sample.passed = false; sample.cleanup_error = errorDetails(error); }
      report.samples.push(sample);
      await save();
      process.stdout.write(`Run ${iteration}/${repetitions}: ${sample.passed ? 'verified' : `failed (${sample.failure?.stage || 'cleanup'})`}\n`);
    }
  }
  // Separate, untimed probe for the exact binary version used by the same channel.
  try {
    const probe = await chromium.launch({ headless: true, channel });
    try { report.environment.browser_version = probe.version(); } finally { await probe.close(); }
  } catch (error) { report.environment.browser_version_error = errorDetails(error); }
  const successful = report.samples.filter((sample) => sample.passed);
  const distribution = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return { count: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Number(((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2).toFixed(3)), max: sorted.at(-1) };
  };
  report.summary = {
    attempted: report.samples.length,
    succeeded: successful.length,
    failed: report.samples.length - successful.length,
    success_rate: successful.length / report.samples.length,
    successful_samples_only: {
      cold_open_ms: distribution(successful.map((sample) => sample.cold_open_ms)),
      warm_snapshot_ms: distribution(successful.flatMap((sample) => sample.warm_snapshot_ms)),
      four_action_batch_ms: distribution(successful.map((sample) => sample.batch_ms)),
      verification_ms: distribution(successful.map((sample) => sample.verification_ms)),
      warm_snapshot_utf8_bytes: distribution(successful.flatMap((sample) => sample.payload_bytes.warm_snapshots)),
    },
  };
  report.status = 'completed';
  report.completed_at = new Date().toISOString();
  if (successful.length !== report.samples.length) process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  report.error = errorDetails(error);
  process.exitCode = 1;
} finally {
  await fixture?.close();
  await save();
}
process.stdout.write(`${JSON.stringify(report.summary || report.error, null, 2)}\nReport: ${join(resultsDir, 'latest.json')}\nArchive: ${archive}\n`);
