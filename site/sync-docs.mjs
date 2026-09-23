import { readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fixed public documents only. Do not copy runtime artifacts, deployment
// configuration, browser state, or credentials into the portable website.
const site = dirname(fileURLToPath(import.meta.url));
const root = dirname(site);
const repository = 'https://github.com/SweetDianDian/tablaze/blob/main/';
const publicGuides = new Map([
  ['demo/README.md', 'DEMO.md'],
  ['docs/PROVIDERS.md', 'PROVIDERS.md'],
  ['docs/NAVIGATION_POLICY.md', 'NAVIGATION_POLICY.md'],
  ['docs/NAVIGATION_POLICY_VALIDATION.md', 'NAVIGATION_POLICY_VALIDATION.md'],
  ['docs/NETWORK.md', 'NETWORK.md'],
  ['docs/PAGE_SCRIPT.md', 'PAGE_SCRIPT.md'],
  ['docs/PROFILES.md', 'PROFILES.md'],
  ['docs/CODEX_NETWORK_RECEIPT_SMOKE.md', 'CODEX_NETWORK_RECEIPT_SMOKE.md'],
  ['docs/CODEX_PAGE_SCRIPT_SMOKE.md', 'CODEX_PAGE_SCRIPT_SMOKE.md'],
  ['docs/CODEX_POSTCHECKS_SMOKE.md', 'CODEX_POSTCHECKS_SMOKE.md'],
  ['docs/CODEX_DELAYED_TARGET_SMOKE.md', 'CODEX_DELAYED_TARGET_SMOKE.md'],
  ['docs/CODEX_CURRENT_FOUR_SMOKE.md', 'CODEX_CURRENT_FOUR_SMOKE.md'],
  ['docs/CODEX_IFRAME_READINESS_SMOKE.md', 'CODEX_IFRAME_READINESS_SMOKE.md'],
  ['docs/RECORDING.md', 'RECORDING.md'],
  ['docs/BROWSER_USE_2026_AUDIT.md', 'BROWSER_USE_2026_AUDIT.md'],
  ['docs/BROWSER_CONFIGURATION.md', 'BROWSER_CONFIGURATION.md'],
  ['docs/CODEX.md', 'CODEX.md'],
  ['docs/CODEX.zh-CN.md', 'CODEX.zh-CN.md'],
  ['SECURITY.md', 'SECURITY.md'],
]);
for (const [source, target] of publicGuides) {
  const original = await readFile(join(root, source), 'utf8');
  const text = original.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, link) => {
    if (/^(https?:|#)/.test(link)) return match;
    const [file, ...fragments] = link.split('#');
    const fragment = fragments.length ? `#${fragments.join('#')}` : '';
    const sourcePath = posix.normalize(posix.join(posix.dirname(source), file));
    const publicTarget = publicGuides.get(sourcePath);
    if (publicTarget) return `[${label}](${publicTarget}${fragment})`;
    if (source.startsWith('docs/') && link.startsWith('evidence/')) return match;
    return `[${label}](${repository}${sourcePath}${fragment})`;
  });
  await writeFile(join(site, target), text);
}
for (const name of ['CODEX_COMPARISON_RESULTS_V3.md', 'CODEX_TERMINAL_FOLLOWUP.md', 'CODEX_PROVIDER_SMOKE.md', 'CODEX_VIRTUAL_LIST_SMOKE.md', 'CODEX_AUTH_RETURN_SMOKE.md', 'CODEX_NATIVE_MCP_SMOKE.md', 'CODEX_MCP_VARIANTS_V2.md']) await copyFile(join(root, 'docs', name), join(site, name));
for (const name of [
  'development-tests.txt', 'development-tests-2026-09-23.txt', 'development-tests-auth-return.txt', 'development-tests-profile.txt', 'development-tests-click-named.txt', 'development-tests-recording-node24.txt', 'development-tests-control-state-node24.txt', 'development-tests-browser-config-node24.txt', 'development-tests-proxy-node24.txt', 'development-tests-iframe-readiness-node24.txt', 'development-tests-iframe-feedback-node24.txt', 'development-validation.json',
  'navigation-policy-probe-v1.json', 'codex-provider-smoke-v1.json', 'codex-e2e.json', 'codex-matched-smoke-v3.json',
  'codex-matched-smoke-v3-analysis.json', 'codex-terminal-followup-v1.json', 'codex-terminal-followup-v1-analysis.json',
  'codex-virtual-list-smoke-v1.json', 'codex-auth-return-smoke-v1.json', 'native-mcp-preflight-v1.json',
  'native-codex-mcp-smoke-v1.json', 'native-mcp-blocked-form-tablaze.jsonl', 'native-mcp-blocked-form-harness.jsonl',
  'native-mcp-form-tablaze.jsonl', 'native-mcp-form-harness.jsonl', 'native-mcp-canvas-tablaze.jsonl', 'native-mcp-canvas-harness.jsonl',
  'native-codex-mcp-variants-v2.json', 'native-mcp-cli-preflight-v2.json', 'native-mcp-structured-preflight-v2.json',
  'native-mcp-v2-canvas-browser-use-cli-mcp.jsonl', 'native-mcp-v2-canvas-browser-use-mcp.jsonl',
  'native-mcp-v2-form-browser-use-cli-mcp.jsonl', 'native-mcp-v2-form-browser-use-mcp.jsonl',
  'native-mcp-v2-virtual-list-browser-use-cli-mcp.jsonl', 'native-mcp-v2-virtual-list-browser-use-mcp-full-attempt1.jsonl',
  'native-mcp-v2-virtual-list-browser-use-mcp-full-attempt2.jsonl', 'native-mcp-v2-virtual-list-browser-use-mcp.jsonl',
  'native-mcp-v2-virtual-list-harness.jsonl', 'native-mcp-v2-virtual-list-tablaze.jsonl',
  'native-codex-network-receipt-v1.json', 'native-mcp-network-direct-v1.json',
  'native-mcp-network-full-attempt1.json', 'native-mcp-network-full-attempt2.json',
  'native-mcp-network-tablaze.jsonl', 'native-mcp-network-harness.jsonl',
  'native-mcp-network-browser-use-cli-mcp.jsonl', 'native-mcp-network-browser-use-mcp.jsonl',
  'native-mcp-network-browser-use-mcp-full-attempt1.jsonl', 'native-mcp-network-browser-use-mcp-full-attempt2.jsonl',
  'network-receipt-direct-runner-v1.mjs', 'development-tests-network-receipt.txt',
  'owned-profile-validation.json',
  'native-mcp-page-script-v1.json', 'native-mcp-page-script-v1.json.tablaze.jsonl',
  'native-mcp-page-script-v1.json.browser-use-cli-mcp.jsonl',
]) await copyFile(join(root, 'docs/evidence', name), join(site, 'evidence', name));
// Curated synthetic fixture reports and traces for the post-check comparison.
await cp(join(root, 'docs/evidence/postchecks'), join(site, 'evidence/postchecks'), { recursive: true, force: true });
await cp(join(root, 'docs/evidence/click-named'), join(site, 'evidence/click-named'), { recursive: true, force: true });
await cp(join(root, 'docs/evidence/current-four'), join(site, 'evidence/current-four'), { recursive: true, force: true });
await cp(join(root, 'docs/evidence/iframe-readiness'), join(site, 'evidence/iframe-readiness'), { recursive: true, force: true });
console.log('Synchronized public guides, comparison reports, and their fixed evidence files. Historical benchmark.json is unchanged.');
