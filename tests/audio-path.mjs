import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const moduleSource = await readFile(new URL('../src/extension/player-audio.js', import.meta.url));
const fixture = await readFile(new URL('./fixtures/tone-3min.mp4', import.meta.url));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/player-audio.js' ? 'text/javascript' : req.url === '/tone.mp4' ? 'video/mp4' : 'text/html; charset=utf-8');
  res.end(req.url === '/player-audio.js' ? moduleSource : req.url === '/tone.mp4' ? fixture : '<button>再生</button><video></video>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { PlayerAudio } = await import('/player-audio.js');
    const video = document.querySelector('video');
    video.src = URL.createObjectURL(await (await fetch('/tone.mp4')).blob());
    await Promise.race([new Promise((resolve, reject) => { video.addEventListener('loadedmetadata', resolve, { once: true }); video.addEventListener('error', () => reject(new Error(`media error ${video.error?.code}`)), { once: true }); }), new Promise((_, reject) => setTimeout(() => reject(new Error(`metadata timeout: ${video.readyState}`)), 10000))]);
    const audio = new PlayerAudio(); audio.apply(video, 1, 1);
    window.fixtureAudio = { audio, video };
    document.querySelector('button').onclick = () => { audio.resume(); video.play(); };
  });
  await page.getByRole('button', { name: '再生' }).click();
  const read = () => page.evaluate(() => window.fixtureAudio.audio.status(window.fixtureAudio.video));
  await page.waitForFunction(() => window.fixtureAudio.audio.context.state === 'running' && !window.fixtureAudio.video.paused);
  await page.waitForTimeout(250);
  const baseline = await read(); assert.ok(baseline.rms > 0.01);
  await page.evaluate(() => { const { audio, video } = window.fixtureAudio; window.firstGraph = audio.graph(video); audio.apply(video, 0.5, 1); });
  await page.waitForTimeout(250);
  const reduced = await read(); assert.ok(Math.abs(reduced.rms / baseline.rms - 0.5) < 0.03);
  assert.equal(await page.evaluate(() => window.firstGraph === window.fixtureAudio.audio.graph(window.fixtureAudio.video)), true);
  // 安全上限+20dBまでは受け付け、それを超える倍率は拒否する。
  assert.deepEqual(await page.evaluate(() => { const { audio, video } = window.fixtureAudio; audio.apply(video, 10, 1);
    try { audio.apply(video, 10.01, 1); return [true, false]; } catch { return [true, true]; } finally { audio.apply(video, 0.5, 1); } }), [true, true]);
  await page.evaluate(() => window.fixtureAudio.audio.bypass(window.fixtureAudio.video));
  await page.waitForTimeout(250);
  const restored = await read(); assert.ok(Math.abs(restored.rms / baseline.rms - 1) < 0.03);
  await page.evaluate(() => window.fixtureAudio.audio.context.suspend());
  assert.equal((await read()).context, 'suspended');
  await page.getByRole('button', { name: '再生' }).click();
  await page.waitForFunction(() => window.fixtureAudio.audio.context.state === 'running');
  console.log(JSON.stringify({ baseline: baseline.rms, halfGain: reduced.rms, bypass: restored.rms, ratio: reduced.rms / baseline.rms, restoredRatio: restored.rms / baseline.rms, resumed: true }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
