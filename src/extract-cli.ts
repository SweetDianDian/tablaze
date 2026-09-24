#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createOpenAICompatiblePlanner, type AgentModelUsage } from './agent.js';
import { createCodexPlanner, type CodexReasoningEffort } from './codex.js';
import { createAnthropicPlanner, createOllamaPlanner } from './providers.js';
import { extractWithPlanner } from './model-extraction.js';
import { ExtractionError, type ExtractionSchema, type ExtractionSource } from './extraction.js';

const help = `Tablaze model extraction / 模型提取

Usage: tablaze-extract --task <text> --sources <file.json> --schema <file.json> --provider <name> --model <id> [provider options]

Sources are a JSON array of {id,url,text}. Supply bounded text observed from trusted browser tools or your own source loader. This command does not open URLs or operate a browser.

  --provider <name>        codex, openai-compatible, anthropic, or ollama
  --model <id>             Explicit extraction model
  --endpoint <url>         Full HTTP endpoint; required for openai-compatible
  --api-key-env <name>     HTTP key environment variable (default TABLAZE_API_KEY)
  --codex-command <path>   Codex executable (default codex)
  --reasoning-effort <id>  Optional Codex reasoning setting
  --max-output-tokens <n>  Anthropic or Ollama output limit
  --timeout-ms <ms>       Extraction deadline, 1–3600000 (default 60000)
  --help                  Print this help
`;

function readJsonFile(path: string, maxBytes: number, option: string): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error();
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) throw new Error();
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch { throw new Error(`${option} must be a regular, bounded UTF-8 JSON file.`); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      task: { type: 'string' }, sources: { type: 'string' }, schema: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, endpoint: { type: 'string' },
      'api-key-env': { type: 'string' }, 'codex-command': { type: 'string' }, 'reasoning-effort': { type: 'string' }, 'max-output-tokens': { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    }, allowPositionals: true, strict: true,
  });
  if (values.help) { process.stdout.write(help); return; }
  if (positionals.length || !values.task?.trim() || !values.sources?.trim() || !values.schema?.trim() || !values.model?.trim()) throw new Error('Supply --task, --sources, --schema, and --model; run tablaze-extract --help.');
  const provider = values.provider ?? 'codex';
  if (!['codex', 'openai-compatible', 'anthropic', 'ollama'].includes(provider)) throw new Error('--provider must be codex, openai-compatible, anthropic, or ollama.');
  if (provider === 'openai-compatible' && !values.endpoint?.trim()) throw new Error('The compatible provider requires --endpoint.');
  if (provider === 'codex' && (values.endpoint !== undefined || values['api-key-env'] !== undefined || values['max-output-tokens'] !== undefined)) throw new Error('HTTP provider options do not apply to Codex.');
  if (provider !== 'codex' && (values['codex-command'] !== undefined || values['reasoning-effort'] !== undefined)) throw new Error('Codex options require --provider codex.');
  if (provider === 'openai-compatible' && values['max-output-tokens'] !== undefined) throw new Error('--max-output-tokens applies only to Anthropic or Ollama.');
  const keyName = values['api-key-env'] ?? 'TABLAZE_API_KEY';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) throw new Error('--api-key-env must name an environment variable.');
  const effort = values['reasoning-effort'] as CodexReasoningEffort | undefined;
  if (effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('--reasoning-effort is unsupported.');
  if (values['codex-command'] !== undefined && !values['codex-command'].trim()) throw new Error('--codex-command must be nonempty.');
  const maxOutputTokens = values['max-output-tokens'] === undefined ? undefined : Number(values['max-output-tokens']);
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1_000_000)) throw new Error('--max-output-tokens must be an integer from 1 to 1000000.');
  const timeoutMs = values['timeout-ms'] === undefined ? 60000 : Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error('--timeout-ms must be an integer from 1 to 3600000.');
  const schema = readJsonFile(values.schema, 65536, '--schema') as ExtractionSchema;
  const sources = readJsonFile(values.sources, 2 * 1024 * 1024, '--sources') as ExtractionSource[];
  const usage: AgentModelUsage[] = [];
  const onUsage = (entry: AgentModelUsage) => usage.push({ ...entry });
  const model = values.model;
  const httpOptions = { model, endpoint: values.endpoint, apiKey: process.env[keyName] || undefined, maxOutputTokens, onUsage };
  const codex = provider === 'codex' ? createCodexPlanner({ model, codexCommand: values['codex-command'], reasoningEffort: effort, onUsage }) : undefined;
  const planner = codex ?? (provider === 'anthropic' ? createAnthropicPlanner(httpOptions) : provider === 'ollama' ? createOllamaPlanner(httpOptions) : createOpenAICompatiblePlanner({ ...httpOptions, endpoint: values.endpoint! }));
  try {
    const result = await extractWithPlanner({ task: values.task, sources, schema, planner, timeoutMs });
    process.stdout.write(`${JSON.stringify({ ...result, model_usage: usage }, null, 2)}\n`);
  } finally { await codex?.close(); }
}

main().catch(error => {
  const code = error instanceof ExtractionError ? error.code : 'EXTRACTION_FAILED';
  const fileDiagnostic = error instanceof Error && /^--(?:sources|schema) must be a regular, bounded UTF-8 JSON file\.$/.test(error.message) ? ` ${error.message}` : '';
  process.stderr.write(`Tablaze extraction failed (${code}).${fileDiagnostic}\n`);
  process.exitCode = 1;
});
