import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local synthesis: no credentials, external API, or speaker playback.
if (process.platform !== 'darwin') throw new Error('This narration recipe requires macOS say and its Tingting voice. Supply an equivalent measured manifest on other systems.');
const directory = resolve(process.argv[2] || 'demo/narration-output');
await mkdir(directory, { recursive: true });
const script = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'narration.zh-CN.json'), 'utf8'));
const run = promisify(execFile), manifest = [];
for (const item of script) {
  const base = String(item.index + 1).padStart(2, '0') + '-' + item.id;
  const textFile = join(directory, base + '.txt'), file = join(directory, base + '.aiff');
  await writeFile(textFile, item.text + '\n');
  await run('/usr/bin/say', ['-v', item.voice, '-r', String(item.rate), '-f', textFile, '-o', file], { timeout: 60000 });
  const { stdout } = await run('/usr/bin/afinfo', [file]);
  const duration = Number(stdout.match(/estimated duration:\s*([\d.]+)\s*sec/)?.[1]);
  if (!Number.isFinite(duration) || duration <= 0 || (await readFile(file)).length < 1000) throw new Error('Narration synthesis produced no audio. Check the installed voice and local speech permissions.');
  manifest.push({ ...item, file, duration_seconds: duration });
}
await writeFile(join(directory, 'narration.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(join(directory, 'narration.json') + '\n');
