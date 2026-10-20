export const LIMITS = Object.freeze({ bytes: 64 * 1024 ** 2, requests: 256, milliseconds: 60_000 });

export class AnalysisError extends Error {
  constructor(code, message) { super(message); this.name = 'AnalysisError'; this.code = code; }
}

export class RangeReader {
  constructor({ url, size, token, signal, fetcher = globalThis.fetch.bind(globalThis), limits = LIMITS }) {
    if (!Number.isSafeInteger(size) || size < 16) throw new AnalysisError('FORMAT', 'ファイルサイズが不正です。');
    this.url = url; this.size = size; this.token = token; this.fetcher = fetcher;
    this.limits = limits; this.bytes = 0; this.requests = 0;
    this.signal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(limits.milliseconds)]);
  }

  async read(start, length) {
    this.signal.throwIfAborted();
    if (![start, length].every(Number.isSafeInteger) || start < 0 || length < 1 || start + length > this.size)
      throw new AnalysisError('FORMAT', 'ファイルの範囲情報が不正です。');
    if (++this.requests > this.limits.requests || this.bytes + length > this.limits.bytes)
      throw new AnalysisError('BUDGET', '部分解析の取得上限に達しました。全ダウンロードは行いません。');
    const headers = { Range: `bytes=${start}-${start + length - 1}` };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetcher(this.url, {
      headers, signal: this.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
    const reject = async (code, message) => {
      await response.body?.cancel().catch(() => {});
      throw new AnalysisError(code, message);
    };
    if (response.status === 401) return reject('AUTH', 'Google連携の有効期限が切れました。設定で再接続してください。');
    if (response.status === 403 || response.status === 404) return reject('ACCESS', 'この動画を取得できません。アクセス権とダウンロード許可を確認してください。');
    if (response.status !== 206) return reject('RANGE', '部分取得に対応していない応答です。全ダウンロードは行いません。');
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (!match || +match[1] !== start || +match[2] !== start + length - 1 || +match[3] !== this.size)
      return reject('RANGE', '取得範囲が要求と一致しません。ファイルが更新された可能性があります。');
    const declared = response.headers.get('content-length');
    if (declared !== null && +declared !== length) return reject('RANGE', '応答サイズが要求と一致しません。');
    if (!response.body) return reject('RANGE', '動画データを受信できません。');
    const reader = response.body.getReader();
    const output = new Uint8Array(length);
    let offset = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.bytes += value.byteLength;
        if (offset + value.byteLength > length || this.bytes > this.limits.bytes) {
          await reader.cancel();
          throw new AnalysisError('BUDGET', '応答が取得上限を超えました。');
        }
        output.set(value, offset); offset += value.byteLength;
      }
    } finally { reader.releaseLock(); }
    if (offset !== length) throw new AnalysisError('RANGE', '取得が途中で終了しました。');
    return output;
  }
}
