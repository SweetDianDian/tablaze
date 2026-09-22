import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Replace narration without re-encoding any picture or rerunning the MCP workflow.
const [sourceArg, manifestArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !manifestArg || !outputArg || !process.env.TABLAZE_DEMO_FFMPEG) {
  throw new Error('Usage: TABLAZE_DEMO_FFMPEG=/path/ffmpeg node demo/revoice.mjs SOURCE_DIRECTORY NARRATION_JSON OUTPUT_DIRECTORY');
}
const source = resolve(sourceArg), output = resolve(outputArg), ffmpeg = resolve(process.env.TABLAZE_DEMO_FFMPEG);
if (source === output) throw new Error('Keep the original recording in a separate directory.');
const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceReport = await readFile(join(source, 'demo-report.json'));
const report = JSON.parse(sourceReport);
const narration = JSON.parse(await readFile(resolve(manifestArg), 'utf8'));
const timeline = report.video_encoding?.narration;
const duration = report.video?.duration_seconds;
if (report.status !== 'passed' || !Number.isFinite(duration) || duration <= 0 || timeline?.length !== 11 || narration?.length !== 11) {
  throw new Error('Use a complete passed eleven-segment recording and narration manifest.');
}
const segments = narration.map((item, index) => {
  const start = timeline[index].start_seconds;
  const end = timeline[index + 1]?.start_seconds ?? duration;
  if (item.index !== index || item.id !== timeline[index].id || !item.text?.trim() || typeof item.file !== 'string' || !isAbsolute(item.file) ||
      !Number.isFinite(item.duration_seconds) || item.duration_seconds <= 0 ||
      !Number.isFinite(start) || start < 0 || start + item.duration_seconds > end - 0.4 ||
      item.duration_seconds > (report.presentation_holds[index]?.duration_ms ?? 0) / 1000 - 0.65) {
    throw new Error(`Narration segment ${index + 1} is invalid or exceeds its original time window.`);
  }
  return { ...item, start_seconds: start };
});
for (const item of segments) {
  const sha = digest(await readFile(item.file));
  if (item.sha256 && item.sha256 !== sha) throw new Error('Narration bytes differ from their measured manifest.');
  item.sha256 = sha;
}
const original = join(source, report.video.file);
const originalHash = digest(await readFile(original));
if (originalHash !== report.video.sha256) throw new Error('Original recording does not match the trace.');
await mkdir(output, { recursive: true });
const target = join(output, 'tablaze-demo-hd.mp4');
const filters = segments.map((item, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(item.start_seconds * 1000)}:all=1[a${i}]`);
filters.push(segments.map((_, i) => `[a${i}]`).join('') + `amix=inputs=11:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=7,apad[voice]`);
const args = ['-y', '-hide_banner', '-loglevel', 'warning', '-i', original,
  ...segments.flatMap(item => ['-i', item.file]), '-filter_complex', filters.join(';'),
  '-map', '0:v:0', '-map', '[voice]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-metadata:s:a:0', segments[0].language === 'en-US' ? 'language=eng' : 'language=zho', '-t', duration.toFixed(3), '-movflags', '+faststart', target];
await run(ffmpeg, args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
const pictureHash = async file => {
  const { stdout } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
  const value = stdout.trim().match(/^SHA256=([a-f0-9]{64})$/)?.[1];
  if (!value) throw new Error('Could not hash the encoded picture stream.');
  return value;
};
const [before, after] = await Promise.all([pictureHash(original), pictureHash(target)]);
if (before !== after) throw new Error('The picture stream changed during the narration replacement.');
const stamp = seconds => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const captions = field => 'WEBVTT\n\n' + segments.map((item, i) => `${i + 1}\n${stamp(item.start_seconds)} --> ${stamp(item.start_seconds + item.duration_seconds)}\n${item[field]}\n`).join('\n');
await writeFile(join(output, `narration.${segments[0].language ?? 'zh-CN'}.vtt`), captions('text'));
if (segments.every(item => typeof item.text_zh === 'string' && item.text_zh.trim())) {
  await writeFile(join(output, 'narration.zh-CN.vtt'), captions('text_zh'));
}
for (const file of ['poster.png', 'poster-hd.png', '01-plan.jpg', '02-results.jpg', '03-stopped.jpg', '04-popup.jpg', '05-approved.jpg', 'wayfar-itinerary.csv']) {
  await copyFile(join(source, file), join(output, file));
}
report.media_revision = {
  type: 'narration_replacement', revised_at: new Date().toISOString(),
  method: 'Only synthesized narration and captions changed. Original encoded H.264 packets are copied unchanged; MCP events, checks, tool timing, chapters and visual timeline remain from the original run.',
  original_report_sha256: digest(sourceReport), original_video_sha256: originalHash,
  encoded_picture_sha256_before: before, encoded_picture_sha256_after: after,
  picture_stream_identical: true,
  revoice_script_sha256: digest(await readFile(fileURLToPath(import.meta.url))),
  remux_encoder_sha256: digest(await readFile(ffmpeg)),
  minimum_gap_seconds: Math.min(...segments.map((item, i) => (segments[i + 1]?.start_seconds ?? duration) - item.start_seconds - item.duration_seconds)),
};
report.video_encoding.original_command_arguments = report.video_encoding.command_arguments;
report.video_encoding.command_arguments = args.map(value => value === original ? 'ORIGINAL/tablaze-demo-hd.mp4' : value === target ? 'tablaze-demo-hd.mp4' : segments.some(item => item.file === value) ? 'NARRATION/' + basename(value) : value);
report.video_encoding.narration = segments.map(({ file, source_file, ...item }) => ({ ...item, file: basename(file), ...(source_file ? { source_file: basename(source_file) } : {}) }));
report.video_encoding.audio = { codec: 'AAC', language: segments[0].language ?? 'zh-CN', sample_rate: 48000, bit_rate: 192000, target_lufs: -16,
  synthesis: segments[0].synthesis, voices: [...new Set(segments.map(item => item.voice))], segments: 11 };
const bytes = await readFile(target);
report.video = { ...report.video, file: basename(target), sha256: digest(bytes), size_bytes: bytes.length };
await writeFile(join(output, 'demo-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, ...report.video, ...report.media_revision }, null, 2));
