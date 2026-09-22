import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const time = seconds => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

/** Render lossless presentation frames once, with narration on the same timeline. */
export async function renderVideo({ output, ffmpeg, frames, narration, duration }) {
  if (!frames.length || narration.length !== 11) throw new Error('The complete recording requires frames and all eleven narration segments.');
  const concat = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    // All paths are generated numeric filenames within output/frames.
    if (!/^frames\/\d{4}\.png$/.test(frame.file)) throw new Error('Invalid presentation frame path.');
    concat.push(`file '${frame.file}'`, `duration ${Math.max(0.001, (frames[index + 1]?.at_seconds ?? duration) - frame.at_seconds).toFixed(6)}`);
  }
  concat.push(`file '${frames.at(-1).file}'`);
  await writeFile(join(output, 'frames.ffconcat'), concat.join('\n') + '\n');
  const audioInputs = narration.flatMap(segment => ['-i', segment.file]);
  const filters = narration.map((segment, index) => `[${index + 1}:a]aresample=48000,adelay=${Math.round(segment.start_seconds * 1000)}:all=1[a${index}]`);
  filters.push(narration.map((_, index) => `[a${index}]`).join('') + `amix=inputs=${narration.length}:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=7,apad[voice]`);
  const file = 'tablaze-demo-hd.mp4';
  const args = ['-y', '-hide_banner', '-loglevel', 'warning', '-f', 'concat', '-safe', '1', '-i', join(output, 'frames.ffconcat'), ...audioInputs,
    '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[voice]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', '12', '-fps_mode', 'cfr',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', duration.toFixed(3), '-movflags', '+faststart', join(output, file)];
  await run(ffmpeg, args, { timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
  const captions = field => 'WEBVTT\n\n' + narration.map((segment, index) => `${index + 1}\n${time(segment.start_seconds)} --> ${time(segment.start_seconds + segment.duration_seconds)}\n${segment[field]}\n`).join('\n');
  await writeFile(join(output, `narration.${narration[0].language ?? 'zh-CN'}.vtt`), captions('text'));
  if (narration.every(segment => typeof segment.text_zh === 'string' && segment.text_zh.trim())) {
    await writeFile(join(output, 'narration.zh-CN.vtt'), captions('text_zh'));
  }
  return {
    file, codec: 'H.264', frames_per_second: 12, crf: 16, width: 2880, height: 1800,
    audio: { codec: 'AAC', language: narration[0].language ?? 'zh-CN', sample_rate: 48000, bit_rate: 192000, target_lufs: -16, synthesis: narration[0].synthesis ?? 'Supplied narration manifest', voices: [...new Set(narration.map(segment => segment.voice))], segments: narration.length },
    source: 'Lossless 2x presentation PNG frames, encoded once. Real tab_capture images are embedded without re-encoding.',
    encoder_sha256: hash(await readFile(ffmpeg)),
    command_arguments: args.map(value => value.startsWith(output) ? value.slice(output.length + 1) : narration.some(segment => segment.file === value) ? 'NARRATION/' + value.split('/').at(-1) : value),
    frames: await Promise.all(frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(output, frame.file))) }))),
    narration: await Promise.all(narration.map(async ({ file: audioFile, ...segment }) => ({ ...segment, file: audioFile.split('/').at(-1), sha256: hash(await readFile(audioFile)) }))),
  };
}
