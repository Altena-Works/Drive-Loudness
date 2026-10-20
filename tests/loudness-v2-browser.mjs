import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gainFor } from '../src/analysis/loudness.js';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, 'test-results/loudness-v2');
await mkdir(output, { recursive: true });
const volumeFor = offsets => {
  let expression = String(10 ** (offsets.at(-1) / 20));
  for (let i = offsets.length - 2; i >= 0; i--) expression = `if(lt(t,${3 + (i + 1) * 177 / 15}),${10 ** (offsets[i] / 20)},${expression})`;
  return `if(lt(t,3),1,${expression})`;
};
const allCases = [
  { name: 'quiet-intro', seconds: 180, volume: 'if(lt(t,30),0.12589254,1)' },
  { name: 'loud-intro', seconds: 180, volume: 'if(lt(t,3),2.81838293,0.50118723)' },
  { name: 'dynamic', seconds: 180, volume: 'if(lt(mod(t,60),30),0.25118864,1)' },
  { name: 'silent-intro', seconds: 180, volume: 'if(lt(t,30),0,1)' },
  { name: 'short', seconds: .7, volume: '1' },
  { name: 'sixteen', seconds: 180, volume: volumeFor([-15,-9,-6,-6,-6,0,-18,-9,-9,-15,-9,-6,-12,-6,-12]), windows: 16 },
  { name: 'uncertain', seconds: 180, volume: volumeFor([-18,-12,0,-3,-15,-15,-6,-3,-15,-15,-3,0,-9,-15,-9]), uncertain: true },
];
const selected = process.argv.slice(2);
const cases = allCases.filter(item => !selected.length || selected.includes(item.name));
assert(cases.length);
for (const item of cases) {
  item.file = path.join(output, `${item.name}.mp4`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=48000:duration=${item.seconds}`,
    '-af', `volume='${item.volume}':eval=frame`, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', item.file]);
  const reference = spawnSync('ffmpeg', ['-hide_banner', '-i', item.file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(reference.status, 0);
  item.reference = +[...reference.stderr.matchAll(/I:\s+(-?\d+(?:\.\d+)?) LUFS/g)].at(-1)[1];
}
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const bytes = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.mp4') ? 'video/mp4' : 'text/html');
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (range) { const start = +range[1], end = +range[2]; res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }); res.end(bytes.subarray(start, end + 1)); }
    else res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const report = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/dist/popup.html`);
  for (const item of cases) {
    const result = await page.evaluate(async file => {
      const { RangeReader } = await import('/src/analysis/range.js');
      const { analyze } = await import('/src/analysis/analyze.js');
      const size = (await (await fetch(file)).arrayBuffer()).byteLength;
      let progress;
      try { return await analyze(new RangeReader({ url: file, size }), value => { progress = value; }); }
      catch (error) { return { error: error.code, message: error.message, progress }; }
    }, `/test-results/loudness-v2/${item.name}.mp4`);
    if (item.uncertain) {
      assert.equal(result.error, 'UNCERTAIN'); assert.equal(result.progress.windows, 16);
      report.push({ name: item.name, result }); console.log(JSON.stringify(report.at(-1))); continue;
    }
    assert.equal(result.error, undefined, result.message);
    if (item.windows) assert.equal(result.windows, item.windows);
    const gain = gainFor(result);
    report.push({ name: item.name, reference: item.reference, errorLU: result.lufs - item.reference, result, gain });
    console.log(JSON.stringify(report.at(-1)));
    assert.equal(result.analyzer, 2); assert.equal(result.stability.converged, true);
    assert(result.windows <= 16); assert(result.requests <= 256); assert(result.bytes <= 64 * 1024 ** 2);
    assert(Math.abs(result.lufs - item.reference) <= 1, `${item.name}: ${result.lufs} vs ${item.reference}`);
    if (item.name === 'loud-intro') {
      assert.equal(gain.limitReason, 'short-term'); assert(result.openingLufs + gain.db <= -17 + 1e-8);
      const popup = await browser.newPage({ viewport: { width: 320, height: 400 }, reducedMotion: 'reduce' });
      await popup.addInitScript(({ result, gain }) => {
        window.chrome = { storage: { session: { get: async () => ({ animatedFiles: [] }), set: async () => {} } }, tabs: { query: async () => [{ id: 1 }] }, runtime: {
          openOptionsPage() {}, sendMessage: async () => ({ state: { phase: 'playing', fileId: 'synthetic', file: { name: 'loud-intro.mp4' }, result, gain }, settings: { target: -23, volume: .5 } }) } };
      }, { result, gain });
      await popup.goto(`${base}/dist/popup.html`);
      await popup.getByText('大きい区間に合わせて調整', { exact: false }).waitFor();
      assert((await popup.locator('#to-label').innerText()).startsWith('補正後'));
      assert(!(await popup.locator('#stats').innerText()).includes('最大+20'));
      await popup.screenshot({ path: path.join(output, 'short-term-limit.png'), fullPage: true });
      await popup.close();
    }
  }
} finally {
  await writeFile(path.join(output, selected.length ? `report-${selected.join('-')}.json` : 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
