import { readMovie, groupPackets } from './mp4.js';
import { measureWindow, aggregate, samplingStages, stability, ANALYZER_VERSION } from './loudness.js';
import { AnalysisError } from './range.js';

async function decodeWindow(movie, reader, window) {
  const start = Math.max(0, window.start - 0.2), packets = movie.packets(start, window.end + 0.05);
  if (!packets.length) throw new AnalysisError('FORMAT', '測定区間の音声がありません。');
  const packetData = new Map();
  for (const group of groupPackets(packets)) {
    const data = await reader.read(group.start, group.end - group.start);
    for (const p of group.packets) packetData.set(p, data.subarray(p.offset - group.start, p.offset - group.start + p.size));
  }
  const rate = movie.config.sampleRate, count = Math.ceil((window.end - start + 0.25) * rate);
  const channels = Array.from({ length: movie.config.numberOfChannels }, () => new Float32Array(count));
  let decodeError, frames = 0;
  const decoder = new AudioDecoder({
    error(error) { decodeError = error; },
    output(audio) {
      try {
        if (audio.sampleRate !== rate || audio.numberOfChannels !== channels.length) throw new Error('音声形式が途中で変更されました。');
        const at = Math.round((audio.timestamp / 1e6 - start) * rate);
        for (let c = 0; c < channels.length; c++) {
          const plane = new Float32Array(audio.numberOfFrames);
          audio.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          const from = Math.max(0, -at), to = Math.min(plane.length, count - at);
          if (to > from) channels[c].set(plane.subarray(from, to), Math.max(0, at));
        }
        frames += audio.numberOfFrames;
      } catch (error) { decodeError = error; }
      finally { audio.close(); }
    },
  });
  try {
    decoder.configure(movie.config);
    for (const p of packets) {
      reader.signal.throwIfAborted();
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.timestamp, duration: p.duration, data: packetData.get(p) }));
      if (decoder.decodeQueueSize >= 32) await decoder.flush();
      packetData.delete(p);
    }
    await decoder.flush();
    if (decodeError || !frames) throw new AnalysisError('CODEC', '音声を復号できません。AAC-LCのMP4を確認してください。');
    return measureWindow(channels, rate, window.start - start, window.end - start);
  } finally { if (decoder.state !== 'closed') decoder.close(); }
}

export async function analyze(reader, progress = () => {}) {
  if (typeof AudioDecoder === 'undefined') throw new AnalysisError('CODEC', 'このChromeではAudioDecoderを使用できません。');
  const movie = await readMovie(reader);
  if (!(await AudioDecoder.isConfigSupported(movie.config)).supported)
    throw new AnalysisError('CODEC', 'この環境で対応していない音声コーデックです。');
  const measurements = [], stages = samplingStages(movie.duration);
  let total = stages.length === 1 ? stages[0].length : stages[0].length + stages[1].length;
  const report = () => progress({ windows: measurements.length, total, bytes: reader.bytes, requests: reader.requests });
  report();
  let result, previous, settled = { converged: stages.length === 1, fullAudio: stages.length === 1 };
  for (const windows of stages) {
    if (measurements.length + windows.length > total) { total = measurements.length + windows.length; report(); }
    for (const window of windows) {
      measurements.push({ ...window, ...await decodeWindow(movie, reader, window) });
      report();
    }
    result = aggregate(measurements, movie.duration);
    if (previous) settled = stability(previous, result);
    if (settled.converged && result.lufs !== null && result.validWindows >= Math.min(3, measurements.length)) break;
    previous = result;
  }
  if (result.lufs === null || !settled.converged || result.validWindows < Math.min(3, measurements.length))
    throw new AnalysisError('UNCERTAIN', '無音・測定不足、または追加測定で推定が安定しないため、この動画には自動補正を適用しません。');
  return { ...result, duration: movie.duration, windows: measurements.length, bytes: reader.bytes,
    requests: reader.requests, codec: movie.config.codec, channels: movie.config.numberOfChannels, analyzer: ANALYZER_VERSION, stability: settled };
}
