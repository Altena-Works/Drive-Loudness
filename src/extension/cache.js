import { cacheKey } from './drive.js';
import { byteSize } from './folders.js';

export const CACHE_LIMITS = Object.freeze({ files: 5000, bytes: 5 * 1024 ** 2 });
export function updatedCache(previous, file, result, { limits = CACHE_LIMITS, now = Date.now() } = {}) {
  const key = cacheKey(file);
  const entries = Object.entries(previous).filter(([k]) => !k.startsWith(`${file.id}:`));
  entries.push([key, { result, measuredAt: now }]);
  entries.sort((a, b) => b[1].measuredAt - a[1].measuredAt || (a[0] === key ? -1 : b[0] === key ? 1 : 0));
  const kept = []; let bytes = 2;
  for (const entry of entries) {
    const size = byteSize(entry[0]) + 1 + byteSize(entry[1]) + (kept.length ? 1 : 0);
    if (kept.length >= limits.files || bytes + size > limits.bytes) continue;
    bytes += size; kept.push(entry);
  }
  const cache = Object.fromEntries(kept);
  if (!cache[key]) throw new Error('測定結果を保存できません。保存容量を確認してください。');
  return { cache, evicted: entries.length - kept.length };
}
// 呼び出し元の短い状態更新キューで直列化し、失敗時に旧値を消さない。
export async function saveResult(file, result) {
  const previous = (await chrome.storage.local.get('cache')).cache ?? {};
  const next = updatedCache(previous, file, result);
  await chrome.storage.local.set({ cache: next.cache });
  return next.evicted;
}
