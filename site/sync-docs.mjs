import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fixed public documents only. Do not copy runtime artifacts, deployment
// configuration, browser state, or credentials into the portable website.
const site = dirname(fileURLToPath(import.meta.url));
const root = dirname(site);
const repository = 'https://github.com/SweetDianDian/tablaze/blob/main/';
for (const [source, target] of [['docs/CODEX.md', 'CODEX.md'], ['docs/CODEX.zh-CN.md', 'CODEX.zh-CN.md'], ['SECURITY.md', 'SECURITY.md']]) {
  const original = await readFile(join(root, source), 'utf8');
  const text = original.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, link) => {
    if (/^(https?:|#)/.test(link)) return match;
    if (source.startsWith('docs/')) {
      if (link.startsWith('evidence/') || ['CODEX.md', 'CODEX.zh-CN.md'].includes(link)) return match;
      if (link === '../SECURITY.md') return `[${label}](SECURITY.md)`;
      return `[${label}](${repository}${link.startsWith('../') ? link.slice(3) : `docs/${link}`})`;
    }
    return `[${label}](${repository}${link})`;
  });
  await writeFile(join(site, target), text);
}
for (const name of ['CODEX_COMPARISON_RESULTS_V3.md', 'CODEX_TERMINAL_FOLLOWUP.md']) await copyFile(join(root, 'docs', name), join(site, name));
for (const name of ['codex-e2e.json', 'codex-matched-smoke-v3.json', 'codex-matched-smoke-v3-analysis.json', 'codex-terminal-followup-v1.json', 'codex-terminal-followup-v1-analysis.json']) await copyFile(join(root, 'docs/evidence', name), join(site, 'evidence', name));
console.log('Synchronized public guides, comparison reports, and their fixed evidence files. Historical benchmark.json is unchanged.');
