import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(projectRoot, 'node_modules/@ffmpeg/core/dist/esm');
const targetRoot = resolve(projectRoot, 'public/ffmpeg');

await mkdir(targetRoot, { recursive: true });
await Promise.all([
  copyFile(
    resolve(sourceRoot, 'ffmpeg-core.js'),
    resolve(targetRoot, 'ffmpeg-core.js'),
  ),
  copyFile(
    resolve(sourceRoot, 'ffmpeg-core.wasm'),
    resolve(targetRoot, 'ffmpeg-core.wasm'),
  ),
]);
