import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, samplingStages, stability, gainFor, measureWindow } from '../src/analysis/loudness.js';
import { cacheKey } from '../src/extension/drive.js';
const energy = lu => 10 ** ((lu + .691) / 10);
const window = (level, start, end, extra = {}) => ({ start, end, blocks: Array(27).fill(energy(level)), shortTermLufs: level, peakDb: 0, ...extra });

test('冒頭を含め9→13→16地点を重複せず分散し、長時間でも取得量を増やさない', () => {
  for (const duration of [48.01, 180, 7200]) {
    const stages = samplingStages(duration), all = stages.flat().sort((a, b) => a.start - b.start);
    assert.deepEqual(stages.map(s => s.length), [9, 4, 3]);
    assert.deepEqual(all[0], { start: 0, end: 3, opening: true });
    assert.equal(all.length, 16);
    for (let i = 0; i < all.length; i++) {
      assert.ok(Math.abs(all[i].end - all[i].start - 3) < 1e-6);
      assert.ok(all[i].end <= duration);
      if (i) assert.ok(all[i].start >= all[i - 1].end - 1e-8);
    }
    assert.equal(stages[1][0].start, 3 + 1.5 * (duration - 3) / 15 - 1.5);
  }
});
test('短尺は端を落とさず連続して測定し、0.4秒未満の末尾を併合する', () => {
  for (const duration of [.4, 1, 3.2, 18, 47.9, 48]) {
    const stages = samplingStages(duration), all = stages.flat();
    assert.equal(stages.length, 1); assert.ok(all.length <= 16);
    assert.equal(all[0].start, 0); assert.equal(all.at(-1).end, duration);
    assert.ok(all.every(w => w.end - w.start >= .4 - 1e-8));
    for (let i = 1; i < all.length; i++) assert.equal(all[i].start, all[i - 1].end);
  }
  assert.throws(() => samplingStages(.39));
});
test('冒頭の3秒は全体平均へ3秒分だけ寄与し、冒頭の大音量を別途判定に残す', () => {
  const opening = window(-12, 0, 3, { opening: true });
  const result = aggregate([opening, window(-30, 20, 23), window(-30, 80, 83), window(-30, 160, 163)], 180);
  const expected = -.691 + 10 * Math.log10((3 * energy(-12) + 177 * energy(-30)) / 180);
  assert.ok(Math.abs(result.lufs - expected) < 1e-9);
  assert.equal(result.loudLufs, -30); assert.equal(result.openingLufs, -12); assert.equal(result.guardLufs, -12);
  const gain = gainFor(result); assert.equal(gain.db, -5); assert.equal(gain.limitReason, 'short-term');
});
test('追加測定の密度ではなく代表時間で平均と短時間P90を重み付けする', () => {
  const windows = [window(-30, 0, 3, { weight: 95 }), window(-15, 3, 6, { weight: 5 })];
  const before = aggregate(windows);
  const after = aggregate([windows[0], window(-15, 3, 6, { weight: 2.5 }), window(-15, 6, 9, { weight: 2.5 })]);
  assert.ok(Math.abs(before.lufs - after.lufs) < 1e-9); assert.equal(before.loudLufs, -30); assert.equal(after.loudLufs, -30);
  const gated = aggregate([{ blocks: [0, energy(-30)], weight: 2, peakDb: 0 }, { blocks: [energy(-20)], weight: 1, peakDb: 0 }]);
  assert.ok(Math.abs(gated.lufs - (-.691 + 10 * Math.log10((energy(-30) + energy(-20)) / 2))) < 1e-9);
});
test('大きい区間差だけで拒否せず、追加前後の判定値が安定したかを比較する', () => {
  const result = aggregate([window(-40, 0, 3), window(-20, 3, 6), window(-20, 6, 9)]);
  assert.ok(result.spread > 6); assert.equal(stability(result, result).converged, true);
  assert.equal(stability(result, { ...result, lufs: result.lufs + .6 }).converged, false);
  assert.equal(stability(result, { ...result, guardLufs: result.guardLufs + 1.1 }).converged, false);
  assert.equal(stability(result, { ...result, lufs: null }).converged, false);
});
test('通常音量の±6dBは同じ補正後音量となり、静かな導入を本編と同じ音量にしない', () => {
  const outputs = [-6, 0, 6].map(offset => {
    const result = aggregate([window(-42 + offset, 0, 3, { opening: true }), window(-24 + offset, 3, 6), window(-24 + offset, 6, 9)], 9);
    const gain = gainFor(result);
    assert.equal(gain.limitReason, null);
    return result.lufs + gain.db;
  });
  assert.ok(Math.max(...outputs) - Math.min(...outputs) < 1e-8);
  assert.equal(gainFor({ lufs: -50, guardLufs: -50 }).limitReason, 'boost-cap');
  assert.equal(gainFor({ lufs: -35, guardLufs: -35, peakDb: 0 }).db, 12);
});
test('3秒超の測定窓も短時間値は3秒平均を使い、キャッシュをv1と分ける', () => {
  const rate = 8000, samples = Float32Array.from({ length: rate * 3.3 }, (_, i) => i < rate * 3 ? .01 * Math.sin(2 * Math.PI * 1000 * i / rate) : .1 * Math.sin(2 * Math.PI * 1000 * i / rate));
  const result = measureWindow([samples], rate);
  assert.ok(Number.isFinite(result.shortTermLufs));
  assert.ok(result.shortTermLufs > measureWindow([samples.subarray(0, rate * 3)], rate).shortTermLufs + 8);
  const key = cacheKey({ id: 'test', version: '1' });
  assert.match(key, /analyzer-2/); assert.doesNotMatch(key, /analyzer-1/);
});
