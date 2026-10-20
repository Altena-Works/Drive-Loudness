import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = await readFile(path.join(root, 'src/icons/icon.svg'), 'utf8');
const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 24, 32, 48, 128]) {
    // 出力サイズのCanvasへ描画し、ビューポートに依存せずPNG化する。
    const png = await page.evaluate(async ({ svg, size }) => {
      const url = URL.createObjectURL(new Blob([svg.replace('<svg ', `<svg width="${size}" height="${size}" `)], { type: 'image/svg+xml' }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(image, 0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1];
      } finally { URL.revokeObjectURL(url); }
    }, { svg, size });
    await writeFile(path.join(root, `src/icons/icon${size}.png`), Buffer.from(png, 'base64'));
  }
  console.log('Generated white-background waveform icons: 16, 24, 32, 48, 128 px');
} finally {
  await browser.close();
}
