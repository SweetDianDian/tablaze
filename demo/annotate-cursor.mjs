import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) throw new Error('Usage: TABLAZE_DEMO_FFMPEG=/absolute/ffmpeg node demo/annotate-cursor.mjs INPUT.mp4 OUTPUT.mp4');
const input = resolve(inputArg), output = resolve(outputArg);
const ffmpeg = process.env.TABLAZE_DEMO_FFMPEG ?? 'ffmpeg';
const track = JSON.parse(await readFile(join(here, 'cursor-track.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
});

const [captureWidth, captureHeight] = track.capture_size;
const rect = track.viewer_browser_rect;
// The recorded viewer's grid image fills the browser panel's width. Its intrinsic
// height extends beneath the clipped panel; object-fit does not letterbox it.
const renderedWidth = rect.width;
const renderedHeight = rect.width * captureHeight / captureWidth;
const left = rect.x;
const top = rect.y;
const mapped = point => ({
  x: Math.round((left + point.x * renderedWidth / captureWidth) * track.video_scale - 18),
  y: Math.round((top + point.y * renderedHeight / captureHeight) * track.video_scale - 18),
});
const fmt = number => Number(number.toFixed(3)).toString();
const ramp = (from, to, at) => `${from}+(${to - from})*clip((t-${fmt(at - .42)})/.42,0,1)`;
const coordinate = axis => {
  let expression = '-100';
  for (const phase of [...track.phases].reverse()) {
    assert.ok(phase.start < phase.end && phase.points.length && phase.points[0].at === phase.start);
    let position = String(mapped(phase.points.at(-1))[axis]);
    for (let index = phase.points.length - 2; index >= 0; index--) {
      const point = phase.points[index], next = phase.points[index + 1];
      position = `if(lt(t,${fmt(next.at)}),${ramp(mapped(point)[axis], mapped(next)[axis], next.at)},${position})`;
    }
    expression = `if(between(t,${fmt(phase.start)},${fmt(phase.end)}),${position},${expression})`;
  }
  return expression;
};

const temporary = await mkdtemp(join(tmpdir(), 'tablaze-cursor-'));
try {
  const png = join(temporary, 'cursor.png');
  const browser = await chromium.launch({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 84, height: 84 }, deviceScaleFactor: 1 });
    await page.setContent('<style>html,body{margin:0;background:transparent}</style><svg xmlns="http://www.w3.org/2000/svg" width="84" height="84" viewBox="0 0 84 84"><circle cx="18" cy="18" r="16" fill="#ff7b47" fill-opacity=".24" stroke="#ff7b47" stroke-width="3"/><path d="M18 15v44l11-12 9 17 8-4-9-17 17-2z" fill="#fff" stroke="#17202b" stroke-width="3" stroke-linejoin="round"/></svg>');
    await page.screenshot({ path: png, omitBackground: true });
  } finally { await browser.close(); }

  const filter = `[0:v][1:v]overlay=x='${coordinate('x')}':y='${coordinate('y')}':eval=frame:format=auto,format=yuv420p[v]`;
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-loop', '1', '-i', png,
    '-filter_complex', filter, '-map', '[v]', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-r', '12', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', output]);
  const audioHash = async path => (await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy', '-f', 'streamhash', '-hash', 'SHA256', '-'])).stdout.trim();
  const [sourceAudio, outputAudio] = await Promise.all([audioHash(input), audioHash(output)]);
  assert.equal(outputAudio, sourceAudio, 'The narrated audio packets must remain identical');
  const bytes = await readFile(output);
  const evidence = { schema_version: 1, source_video_sha256: hash(await readFile(input)), output_video_sha256: hash(bytes), output_size_bytes: bytes.length,
    audio_streamhash: outputAudio, source_track: 'demo/cursor-track.json', track_sha256: hash(await readFile(join(here, 'cursor-track.json'))),
    pointer_kind: track.kind, note: track.notice, phases: track.phases.map(phase => ({ id: phase.id, start: phase.start, end: phase.end, targets: phase.points.map(point => point.target), no_click: Boolean(phase.no_click) })) };
  await writeFile(output + '.cursor-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
