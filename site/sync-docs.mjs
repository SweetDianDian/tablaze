import { readFile, writeFile, copyFile } from 'node:fs/promises';
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
for (const name of ['CODEX_COMPARISON_RESULTS_V3.md', 'CODEX_TERMINAL_FOLLOWUP.md', 'CODEX_PROVIDER_SMOKE.md']) await copyFile(join(root, 'docs', name), join(site, name));
for (const name of ['development-tests.txt', 'development-validation.json', 'navigation-policy-probe-v1.json', 'codex-provider-smoke-v1.json', 'codex-e2e.json', 'codex-matched-smoke-v3.json', 'codex-matched-smoke-v3-analysis.json', 'codex-terminal-followup-v1.json', 'codex-terminal-followup-v1-analysis.json']) await copyFile(join(root, 'docs/evidence', name), join(site, 'evidence', name));
console.log('Synchronized public guides, comparison reports, and their fixed evidence files. Historical benchmark.json is unchanged.');
