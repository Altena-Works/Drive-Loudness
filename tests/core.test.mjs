import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { RangeReader } from '../src/analysis/range.js';
import { readMovie, groupPackets } from '../src/analysis/mp4.js';
import { measureWindow, aggregate, samplingWindows, gainFor } from '../src/analysis/loudness.js';

function fixtureReader(bytes, extra = {}) {
  return new RangeReader({ url: 'https://fixture.invalid/file', size: bytes.length, fetcher: async (_, options) => {
    const [start, end] = options.headers.Range.match(/\d+/g).map(Number);
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  }, ...extra });
}
test('Rangeを無視する200応答は本文を読まず中断する', async () => {
  let canceled = false;
  const reader = new RangeReader({ url: 'https://fixture.invalid', size: 100, fetcher: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 200 }) });
  await assert.rejects(reader.read(10, 10), { code: 'RANGE' });
  assert.equal(canceled, true); assert.equal(reader.bytes, 0);
});
test('応答範囲、短い本文、長い本文を拒否する', async () => {
  for (const [range, length, code] of [['bytes 0-9/100', 10, 'RANGE'], ['bytes 10-19/101', 10, 'RANGE'], ['bytes 10-19/100', 9, 'RANGE'], ['bytes 10-19/100', 11, 'BUDGET']]) {
    const reader = new RangeReader({ url: 'https://fixture.invalid', size: 100,
      fetcher: async () => new Response(new Uint8Array(length), { status: 206, headers: { 'Content-Range': range } }) });
    await assert.rejects(reader.read(10, 10), { code });
  }
});
test('取得量・要求数とキャンセルの境界を守る', async () => {
  const bytes = new Uint8Array(100), limits = { bytes: 16, requests: 2, milliseconds: 1000 };
  const reader = fixtureReader(bytes, { limits });
  await reader.read(0, 8); await reader.read(8, 8);
  await assert.rejects(reader.read(16, 1), { code: 'BUDGET' });
  assert.equal(reader.bytes, 16);
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(fixtureReader(bytes, { signal: canceled.signal }).read(0, 8), { name: 'AbortError' });
});
test('認証・取得権限エラーを分類する', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'ACCESS'], [404, 'ACCESS']]) {
    const reader = new RangeReader({ url: 'https://fixture.invalid', size: 100, fetcher: async () => new Response('', { status }) });
    await assert.rejects(reader.read(0, 1), { code });
  }
});

for (const name of ['tone.mp4', 'tone-tail.mp4']) test(`MP4索引の音声位置はffprobeと一致する: ${name}`, async () => {
  const bytes = await readFile(new URL(`fixtures/${name}`, import.meta.url));
  const reader = fixtureReader(bytes), movie = await readMovie(reader);
  const reference = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_entries', 'packet=pos,size,dts_time', '-of', 'json', new URL(`fixtures/${name}`, import.meta.url).pathname], { encoding: 'utf8' })).packets;
  const packets = movie.packets(4, 6);
  assert.ok(packets.length > 80); assert.equal(movie.config.codec, 'mp4a.40.2');
  for (const packet of packets) {
    const found = reference.find(p => +p.pos === packet.offset);
    assert.ok(found); assert.equal(+found.size, packet.size);
    // AACエンコーダー遅延はMP4の編集リストによりffprobeでは負のDTSとなる。
    assert.ok(Math.abs(packet.timestamp / 1e6 - +found.dts_time) < 0.03);
  }
  assert.ok(reader.bytes < bytes.length / 2, 'mdat全体を取得していない');
  const groups = groupPackets(packets);
  assert.ok(groups.every(g => g.end - g.start <= 262144));
});
test('壊れたMP4と巨大なmoovを取得上限内で拒否する', async () => {
  await assert.rejects(readMovie(fixtureReader(new Uint8Array(32))), { code: 'FORMAT' });
  const bytes = new Uint8Array(32); const view = new DataView(bytes.buffer);
  view.setUint32(0, 32 * 1024 ** 2); bytes.set(new TextEncoder().encode('moov'), 4);
  const reader = fixtureReader(bytes); reader.size = 32 * 1024 ** 2;
  reader.fetcher = async () => new Response(bytes.subarray(0, 16), { status: 206, headers: { 'Content-Range': `bytes 0-15/${reader.size}` } });
  await assert.rejects(readMovie(reader), { code: 'FORMAT' }); assert.equal(reader.bytes, 16);
});

function tone(db, seconds = 2.4, rate = 48000) {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 10 ** (db / 20) * Math.sin(2 * Math.PI * 1000 * i / rate));
}
test('K-weightingとチャンネル加算: 1kHz mono/stereoの既知値', () => {
  const channel = tone(-20);
  const mono = aggregate([measureWindow([channel], 48000, 0.2, 2.2)]);
  const stereo = aggregate([measureWindow([channel, channel], 48000, 0.2, 2.2)]);
  assert.ok(Math.abs(mono.lufs - (-23.0)) < 0.15, `${mono.lufs}`);
  assert.ok(Math.abs(stereo.lufs - mono.lufs - 3.0103) < 0.001);
});
test('同じ音の±6dB差を測定し、固定補正後の差がなくなる', () => {
  const results = [-6, 0, 6].map(db => aggregate([measureWindow([tone(-20 + db)], 48000, 0.2, 2.2)]));
  assert.ok(Math.abs(results[2].lufs - results[0].lufs - 12) < 0.001);
  const output = results.map(result => result.lufs + gainFor(result, -29).db);
  assert.ok(Math.max(...output) - Math.min(...output) < 0.001);
});
test('無音を増幅せず、LUFSでなくエネルギーを集約する', () => {
  assert.equal(aggregate([measureWindow([new Float32Array(48000)], 48000)]).lufs, null);
  const result = aggregate([{ blocks: [0.01], peakDb: -10 }, { blocks: [0.001], peakDb: -20 }]);
  assert.ok(Math.abs(result.lufs - (-0.691 + 10 * Math.log10(0.0055))) < 0.0001);
  assert.throws(() => gainFor({ lufs: null, peakDb: null }));
});
test('ピークに関係なく平均を目標へ揃え、増幅は安全上限+20dBまで', () => {
  const result = gainFor({ lufs: -50, peakDb: -20 }, -23);
  assert.equal(result.db, 20); assert.equal(result.limited, true);
  const quiet = gainFor({ lufs: -35, peakDb: -1 }, -23);
  assert.ok(Math.abs(quiet.db - 12) < 1e-9); assert.equal(quiet.limited, false);
  assert.ok(Math.abs(gainFor({ lufs: -15.1, peakDb: -0.5 }, -23).db + 7.9) < 1e-9);
});
test('3分・長時間とも8地点、短い動画では測定区間を重複させない', () => {
  for (const duration of [180, 7200]) {
    const windows = samplingWindows(duration);
    assert.equal(windows.length, 8); assert.equal(windows.reduce((sum, w) => sum + w.end - w.start, 0), 24);
    assert.ok(windows[0].start < duration / 8 && windows.at(-1).end > duration * 7 / 8);
  }
  assert.equal(samplingWindows(1).length, 1);
  assert.throws(() => samplingWindows(0));
});

