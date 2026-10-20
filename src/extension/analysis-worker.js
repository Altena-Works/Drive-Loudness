import { RangeReader } from '../analysis/range.js';
import { analyze } from '../analysis/analyze.js';
self.onmessage = async ({ data: { token, file } }) => {
  try {
    const reader = new RangeReader({ url: `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, size: file.size, token });
    const result = await analyze(reader, progress => self.postMessage({ type: 'PROGRESS', progress }));
    self.postMessage({ type: 'DONE', result });
  } catch (error) {
    self.postMessage({ type: 'ERROR', code: error.code, error: error.name === 'TimeoutError' ? '解析時間の上限に達しました。' :
      error.code ? error.message : '部分解析に失敗しました。形式・通信環境を確認してください。' });
  }
};
