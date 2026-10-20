// 同じ動画要素への二重接続を避けるため、停止時も音声経路を再利用する。
export class PlayerAudio {
  constructor() { this.nodes = new WeakMap(); }
  graph(video) {
    const url = new URL(video.currentSrc || video.src, location.href);
    if (url.origin !== location.origin || !['blob:', 'https:', 'http:'].includes(url.protocol))
      throw new Error('この配信形式では自動補正できません。');
    let graph = this.nodes.get(video);
    if (graph) return graph;
    if (this.context?.state !== 'running') throw new Error('音声を開始できません。ページを再読み込みしてください。');
    const source = this.context.createMediaElementSource(video);
    const fixed = this.context.createGain(), master = this.context.createGain();
    const meter = this.context.createAnalyser(); meter.fftSize = 2048;
    source.connect(fixed).connect(master).connect(meter).connect(this.context.destination);
    graph = { fixed, master, meter, samples: new Float32Array(meter.fftSize) };
    this.nodes.set(video, graph);
    return graph;
  }
  apply(video, gain, volume) {
    // 単体読み込みに対応するため、MAX_BOOST_DBと同じ上限を直接指定する。
    if (!Number.isFinite(gain) || gain < 0 || gain > 10 ** (20 / 20) ||
        !Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('補正値が不正です。');
    const graph = this.graph(video);
    graph.fixed.gain.value = gain; graph.master.gain.value = volume;
  }
  bypass(video) {
    const graph = this.nodes.get(video);
    if (graph) { graph.fixed.gain.value = 1; graph.master.gain.value = 1; }
  }
  async resume() {
    this.context ??= new AudioContext();
    if (this.context.state === 'closed') throw new Error('音声処理が終了しています。');
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('音声を再開できません。');
  }
  status(video) {
    const graph = this.nodes.get(video);
    if (!graph) return { context: 'unconnected', rms: 0, volume: video?.volume ?? null };
    graph.meter.getFloatTimeDomainData(graph.samples);
    const energy = graph.samples.reduce((sum, value) => sum + value * value, 0) / graph.samples.length;
    return { context: this.context.state, rms: Math.sqrt(energy), volume: video.volume };
  }
}
