// ITU-R BS.1770のK-weighting。mono/stereoを400msブロック、100ms刻みで測定する。
function coefficients(rate) {
  let k = Math.tan(Math.PI * 1681.974450955533 / rate);
  const vh = 10 ** (3.999843853973347 / 20), vb = vh ** 0.4996667741545416;
  const q = 0.7071752369554196, a0 = 1 + k / q + k * k;
  const shelf = [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0,
    (vh - vb * k / q + k * k) / a0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0];
  k = Math.tan(Math.PI * 38.13547087602444 / rate);
  const b0 = 1 + k / 0.5003270373238773 + k * k;
  return [shelf, [1, -2, 1, 2 * (k * k - 1) / b0, (1 - k / 0.5003270373238773 + k * k) / b0]];
}
function filter(c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return x => { const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
const lufs = energy => energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity;

export function measureWindow(channels, rate, start = 0, end = channels[0]?.length / rate) {
  if (![1, 2].includes(channels.length) || rate < 8000 || rate > 96000 || channels.some(c => c.length !== channels[0].length))
    throw new Error('対応する音声形式ではありません。');
  const count = channels[0].length, energy = new Float64Array(count);
  let peak = 0;
  for (const channel of channels) {
    const [shelf, pass] = coefficients(rate).map(filter);
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(channel[i])) throw new Error('音声データが不正です。');
      const value = pass(shelf(channel[i])); energy[i] += value * value;
      peak = Math.max(peak, Math.abs(channel[i]));
    }
  }
  const block = Math.round(rate * 0.4), step = Math.round(rate * 0.1);
  const first = Math.max(0, Math.ceil(start * rate)), last = Math.min(count, Math.floor(end * rate));
  const blocks = [];
  if (last - first >= block) {
    let sum = 0;
    for (let i = first; i < first + block; i++) sum += energy[i];
    for (let at = first; at + block <= last; at += step) {
      if (at > first) for (let i = 0; i < step; i++) sum += energy[at + block - step + i] - energy[at - step + i];
      blocks.push(Math.max(0, sum / block));
    }
  }
  // 短時間値はゲートを使わない。末尾併合で3秒を超えた場合も3秒窓で測る。
  const shortLength = Math.min(Math.round(rate * 3), last - first);
  let sum = 0, maximum = 0;
  for (let i = first; i < first + shortLength; i++) sum += energy[i];
  maximum = sum;
  for (let at = first + step; at + shortLength <= last; at += step) {
    for (let i = 0; i < step; i++) sum += energy[at + shortLength - step + i] - energy[at - step + i];
    maximum = Math.max(maximum, sum);
  }
  return { blocks, shortTermLufs: shortLength ? lufs(Math.max(0, maximum / shortLength)) : -Infinity,
    peakDb: peak ? 20 * Math.log10(peak) : -Infinity };
}

export function aggregate(windows, duration) {
  const weights = new Map(windows.map(w => [w, w.weight ?? 1]));
  if (Number.isFinite(duration)) {
    const opening = windows.find(w => w.opening), body = windows.filter(w => !w.opening).sort((a, b) => a.start - b.start);
    if (opening) weights.set(opening, opening.end - opening.start);
    const center = w => (w.start + w.end) / 2;
    for (let i = 0; i < body.length; i++) {
      const left = i ? (center(body[i - 1]) + center(body[i])) / 2 : opening?.end ?? 0;
      const right = i + 1 < body.length ? (center(body[i]) + center(body[i + 1])) / 2 : duration;
      weights.set(body[i], body[i].fullAudio ? body[i].end - body[i].start : right - left);
    }
  }
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const weightedMean = xs => xs.reduce((sum, x) => sum + x.energy * x.weight, 0) / xs.reduce((sum, x) => sum + x.weight, 0);
  const blocks = windows.flatMap(w => w.blocks.map(energy => ({ energy, weight: weights.get(w) / w.blocks.length }))).filter(x => lufs(x.energy) >= -70);
  if (!blocks.length) return { lufs: null, peakDb: null, spread: null, validWindows: 0, loudLufs: null, openingLufs: null, guardLufs: null };
  const gate = lufs(weightedMean(blocks)) - 10;
  const kept = blocks.filter(x => lufs(x.energy) >= gate);
  const levels = windows.map(w => w.blocks.filter(e => lufs(e) >= -70)).filter(xs => xs.length).map(xs => lufs(mean(xs)));
  const short = windows.map(w => ({ level: w.shortTermLufs ?? lufs(mean(w.blocks)), weight: weights.get(w), opening: w.opening }))
    .filter(x => Number.isFinite(x.level) && x.level >= -70);
  const body = short.filter(x => !x.opening).sort((a, b) => a.level - b.level);
  const total = body.reduce((sum, x) => sum + x.weight, 0);
  let cumulative = 0, loudLufs = null;
  for (const point of body) { cumulative += point.weight; if (cumulative >= total * .9) { loudLufs = point.level; break; } }
  const openingLufs = short.find(x => x.opening)?.level ?? null;
  const guardLufs = Math.max(loudLufs ?? -Infinity, openingLufs ?? -Infinity);
  return { lufs: lufs(weightedMean(kept)), peakDb: Math.max(...windows.map(w => w.peakDb)),
    spread: Math.max(...levels) - Math.min(...levels), validWindows: levels.length, loudLufs, openingLufs,
    guardLufs: Number.isFinite(guardLufs) ? guardLufs : null };
}

export function samplingWindows(duration, count = 8, seconds = 3, offset = 0) {
  if (!Number.isFinite(duration) || duration < 0.4) throw new Error('動画が短すぎるため測定できません。');
  const width = Math.min(seconds, duration), windows = [];
  for (let i = 0; i < count; i++) {
    const start = Math.max(offset, Math.min(duration - width, offset + (duration - offset) * (i + 0.5) / count - width / 2));
    if (!windows.length || start >= windows.at(-1).end - 0.001) windows.push({ start, end: start + width });
  }
  return windows;
}

export function samplingStages(duration) {
  if (!Number.isFinite(duration) || duration < .4) throw new Error('動画が短すぎるため測定できません。');
  if (duration <= 48) {
    const windows = [];
    for (let start = 0; start < duration; start += 3) {
      if (duration - start < .4 && windows.length) { windows.at(-1).end = duration; break; }
      windows.push({ start, end: Math.min(duration, start + 3), opening: start === 0, fullAudio: true });
    }
    return [windows];
  }
  const grid = samplingWindows(duration, 15, 3, 3);
  return [[{ start: 0, end: 3, opening: true }, ...[0, 2, 4, 6, 8, 10, 12, 14].map(i => grid[i])],
    [1, 5, 9, 13].map(i => grid[i]), [3, 7, 11].map(i => grid[i])];
}

export function stability(previous, current) {
  const integratedDelta = Math.abs(current.lufs - previous.lufs), guardDelta = Math.abs(current.guardLufs - previous.guardLufs);
  return { integratedDelta, guardDelta, converged: previous.lufs !== null && current.lufs !== null &&
    previous.guardLufs !== null && current.guardLufs !== null && integratedDelta <= .5 && guardDelta <= 1, fullAudio: false };
}

// 動画ごとの固定補正。短時間の聴感音量を使い、瞬間ピークは制限しない。
export const ANALYZER_VERSION = 2;
export const SHORT_TERM_ALLOWANCE_LU = 6;
export const MAX_BOOST_DB = 20;
export function gainFor(result, target = -23) {
  if (!Number.isFinite(result.lufs) || !Number.isFinite(target) || target < -35 || target > -14)
    throw new Error('有効な測定結果がありません。');
  const requestedDb = target - result.lufs;
  const shortTermDb = Number.isFinite(result.guardLufs) ? target + SHORT_TERM_ALLOWANCE_LU - result.guardLufs : Infinity;
  const db = Math.min(requestedDb, shortTermDb, MAX_BOOST_DB), limited = db < requestedDb - .05;
  return { db, requestedDb, limited, limitReason: limited ? (shortTermDb < MAX_BOOST_DB ? 'short-term' : 'boost-cap') : null,
    linear: 10 ** (db / 20) };
}
