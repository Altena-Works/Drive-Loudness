import { AnalysisError } from './range.js';

const fail = (message = 'このMP4の部分解析には対応していません。') => { throw new AnalysisError('FORMAT', message); };
const text = (bytes, offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
const safe64 = (view, offset) => {
  const value = view.getBigUint64(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(value);
};

// 各boxは親の境界内だけで読む。映像のサンプル一覧やPCM全体は作らない。
function boxes(bytes, start = 0, end = bytes.length) {
  const result = []; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset < end;) {
    if (offset + 8 > end || result.length >= 1024) fail();
    let size = view.getUint32(offset); let header = 8;
    if (size === 1) { if (offset + 16 > end) fail(); size = safe64(view, offset + 8); header = 16; }
    if (size === 0) size = end - offset;
    if (size < header || offset + size > end) fail();
    result.push({ type: text(bytes, offset + 4, 4), start: offset, data: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

export async function readMovie(reader) {
  for (let offset = 0, count = 0; offset + 8 <= reader.size && count < 128; count++) {
    const header = await reader.read(offset, Math.min(16, reader.size - offset));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let size = view.getUint32(0); const type = text(header, 4, 4);
    if (size === 1) { if (header.length < 16) fail(); size = safe64(view, 8); }
    if (size === 0) size = reader.size - offset;
    if (size < (view.getUint32(0) === 1 ? 16 : 8) || offset + size > reader.size) fail();
    if (type === 'moof') fail('分割形式のMP4には現在対応していません。');
    if (type === 'moov') {
      if (size > 16 * 1024 ** 2) fail('索引が部分解析の上限を超えています。');
      return parseMovie(await reader.read(offset, size), reader.size);
    }
    offset += size;
  }
  fail('MP4の音声索引を見つけられませんでした。');
}

export function parseMovie(bytes, fileSize) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const children = (box) => boxes(bytes, box.data, box.end);
  const one = (box, type) => { const value = children(box).find(b => b.type === type); if (!value) fail(); return value; };
  const check = (box, offset, length) => { if (offset < box.data || offset + length > box.end) fail(); };
  const u32 = (box, offset) => { check(box, offset, 4); return view.getUint32(offset); };
  const root = boxes(bytes)[0];
  if (root?.type !== 'moov' || children(root).some(b => b.type === 'mvex')) fail();
  const audio = children(root).filter(b => b.type === 'trak').filter(trak => {
    const h = one(one(trak, 'mdia'), 'hdlr'); check(h, h.data, 12);
    return text(bytes, h.data + 8, 4) === 'soun';
  });
  if (audio.length !== 1) fail('音声トラックが1つのMP4に対応しています。');
  const trak = audio[0], mdia = one(trak, 'mdia'), mdhd = one(mdia, 'mdhd');
  check(mdhd, mdhd.data, 1); const version = bytes[mdhd.data];
  if (version !== 0 && version !== 1) fail();
  const timescale = u32(mdhd, mdhd.data + (version === 1 ? 20 : 12));
  const durationOffset = mdhd.data + (version === 1 ? 24 : 16);
  check(mdhd, durationOffset, version === 1 ? 8 : 4);
  const durationTicks = version === 1 ? safe64(view, durationOffset) : view.getUint32(durationOffset);
  if (!timescale || !durationTicks) fail();
  const edts = children(trak).find(b => b.type === 'edts');
  if (edts) {
    const edit = one(edts, 'elst');
    if (u32(edit, edit.data + 4) !== 1) fail('複雑な編集タイムラインのMP4には対応していません。');
    const wide = bytes[edit.data] === 1;
    check(edit, edit.data + 8, wide ? 20 : 12);
    const mediaTime = wide ? Number(view.getBigInt64(edit.data + 16)) : view.getInt32(edit.data + 12);
    const rateAt = edit.data + (wide ? 24 : 16);
    if (mediaTime < 0 || mediaTime > timescale * 0.2 || view.getUint32(rateAt) !== 65536)
      fail('複雑な編集タイムラインのMP4には対応していません。');
  }
  const stbl = one(one(mdia, 'minf'), 'stbl');
  const stsd = one(stbl, 'stsd');
  if (u32(stsd, stsd.data + 4) !== 1) fail();
  const entry = boxes(bytes, stsd.data + 8, stsd.end)[0];
  if (entry?.type !== 'mp4a') fail('AAC音声の通常MP4に対応しています。');
  check(entry, entry.data, 28);
  if (view.getUint16(entry.data + 8) !== 0) fail();
  const channels = view.getUint16(entry.data + 16);
  const sampleRate = view.getUint32(entry.data + 24) / 65536;
  if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 96000) fail('対応する音声は96kHz以下のmono/stereoです。');
  const esds = boxes(bytes, entry.data + 28, entry.end).find(b => b.type === 'esds');
  if (!esds) fail();
  let description;
  function descriptors(start, end, depth = 0) {
    if (depth > 4) fail();
    for (let at = start; at < end;) {
      const tag = bytes[at++]; let length = 0, n = 0, value;
      do { if (at >= end || n++ === 4) fail(); value = bytes[at++]; length = length * 128 + (value & 127); } while (value & 128);
      const limit = at + length; if (limit > end) fail();
      if (tag === 5) description = bytes.slice(at, limit);
      if (tag === 3) {
        if (at + 3 > limit) fail();
        const flags = bytes[at + 2]; let next = at + 3;
        if (flags & 128) next += 2;
        if (flags & 64) { if (next >= limit) fail(); next += 1 + bytes[next]; }
        if (flags & 32) next += 2;
        if (next > limit) fail(); descriptors(next, limit, depth + 1);
      }
      if (tag === 4) { if (at + 13 > limit || bytes[at] !== 0x40) fail(); descriptors(at + 13, limit, depth + 1); }
      at = limit;
    }
  }
  descriptors(esds.data + 4, esds.end);
  if (!description?.length || description.length > 64 || (description[0] >> 3) !== 2)
    fail('AAC-LC音声に対応しています。');
  const table = (type, width) => {
    const box = one(stbl, type); const count = u32(box, box.data + 4);
    check(box, box.data + 8, count * width);
    if (count > 4_000_000) fail();
    return { count, get: (i, field = 0) => {
      if (i < 0 || i >= count || field < 0 || field >= width / 4) fail();
      return view.getUint32(box.data + 8 + i * width + field * 4);
    }, box };
  };
  const stts = table('stts', 8), stsc = table('stsc', 12), stsz = one(stbl, 'stsz');
  const fixedSize = u32(stsz, stsz.data + 4), sampleCount = u32(stsz, stsz.data + 8);
  if (!sampleCount || sampleCount > 4_000_000 || !stts.count || !stsc.count) fail();
  if (!fixedSize) check(stsz, stsz.data + 12, sampleCount * 4);
  const sizeOf = i => { if (i < 0 || i >= sampleCount) fail(); return fixedSize || view.getUint32(stsz.data + 12 + i * 4); };
  const offsetBox = children(stbl).find(b => b.type === 'stco' || b.type === 'co64');
  if (!offsetBox) fail();
  const chunkCount = u32(offsetBox, offsetBox.data + 4), offsetWidth = offsetBox.type === 'co64' ? 8 : 4;
  check(offsetBox, offsetBox.data + 8, chunkCount * offsetWidth);
  let totalSamples = 0, totalTicks = 0;
  for (let i = 0; i < stts.count; i++) {
    const count = stts.get(i), delta = stts.get(i, 1);
    if (!count || !delta) fail(); totalSamples += count; totalTicks += count * delta;
  }
  if (totalSamples !== sampleCount || !Number.isSafeInteger(totalTicks)) fail();
  let described = 0;
  for (let i = 0; i < stsc.count; i++) {
    const first = stsc.get(i), next = i + 1 < stsc.count ? stsc.get(i + 1) : chunkCount + 1;
    if ((i === 0 && first !== 1) || next <= first || next > chunkCount + 1 || !stsc.get(i, 1) || stsc.get(i, 2) !== 1) fail();
    described += (next - first) * stsc.get(i, 1);
  }
  if (described !== sampleCount) fail();
  if (children(stbl).some(b => ['ctts', 'senc', 'sinf'].includes(b.type))) fail();
  function timeAt(index) {
    let first = 0, ticks = 0;
    for (let i = 0; i < stts.count; i++) {
      const count = stts.get(i), delta = stts.get(i, 1);
      if (index < first + count) return { ticks: ticks + (index - first) * delta, delta };
      first += count; ticks += count * delta;
    }
    fail();
  }
  function sampleAt(seconds) {
    const target = seconds * timescale; let first = 0, ticks = 0;
    for (let i = 0; i < stts.count; i++) {
      const count = stts.get(i), delta = stts.get(i, 1);
      if (target < ticks + count * delta) return first + Math.max(0, Math.floor((target - ticks) / delta));
      first += count; ticks += count * delta;
    }
    return sampleCount - 1;
  }
  function offsetOf(index) {
    let firstSample = 0;
    for (let i = 0; i < stsc.count; i++) {
      const firstChunk = stsc.get(i) - 1, perChunk = stsc.get(i, 1);
      const endChunk = i + 1 < stsc.count ? stsc.get(i + 1) - 1 : chunkCount;
      const count = (endChunk - firstChunk) * perChunk;
      if (index < firstSample + count) {
        const chunk = firstChunk + Math.floor((index - firstSample) / perChunk);
        const chunkFirst = firstSample + (chunk - firstChunk) * perChunk;
        const at = offsetBox.data + 8 + chunk * offsetWidth;
        let offset = offsetWidth === 8 ? safe64(view, at) : view.getUint32(at);
        // 1つのchunkに極端に多いサンプルがある場合も、索引予算内で走査する。
        for (let s = chunkFirst; s < index; s++) offset += sizeOf(s);
        return { offset, endIndex: chunkFirst + perChunk };
      }
      firstSample += count;
    }
    fail();
  }
  return {
    duration: Math.min(durationTicks, totalTicks) / timescale,
    config: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, description },
    packets(start, end) {
      const result = [];
      let position;
      for (let i = sampleAt(start); i < sampleCount; i++) {
        const { ticks, delta } = timeAt(i); if (ticks / timescale >= end) break;
        if (!position || i >= position.endIndex) position = offsetOf(i);
        const size = sizeOf(i), offset = position.offset;
        position.offset += size;
        if (!size || size > 1024 ** 2 || !Number.isSafeInteger(offset) || offset < 0 || offset + size > fileSize || result.length >= 4096) fail();
        result.push({ offset, size, timestamp: Math.round(ticks / timescale * 1e6), duration: Math.round(delta / timescale * 1e6) });
      }
      return result;
    },
  };
}

export function groupPackets(packets) {
  const groups = [];
  for (const packet of [...packets].sort((a, b) => a.offset - b.offset)) {
    const last = groups.at(-1), end = packet.offset + packet.size;
    if (last && packet.offset >= last.start && packet.offset - last.end <= 32_768 && end - last.start <= 262_144) {
      last.end = Math.max(last.end, end); last.packets.push(packet);
    } else groups.push({ start: packet.offset, end, packets: [packet] });
  }
  return groups;
}
