import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
await mkdir(dir, { recursive: true });
const run = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
run(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=18', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=18',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', '-y', dir + 'tone.mp4']);
run(['-i', dir + 'tone.mp4', '-c', 'copy', '-y', dir + 'tone-tail.mp4']);
run(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=180', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=180',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', '-y', dir + 'tone-3min.mp4']);
