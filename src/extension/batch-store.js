import { byteSize, BATCH_LIMITS } from './folders.js';

export const batchState = async () => (await chrome.storage.session.get('batch')).batch;
export const batchItems = async () => (await chrome.storage.session.get('batchItems')).batchItems ?? [];
export const putBatch = batch => chrome.storage.session.set({ batch });
export function counts(items) {
  const value = { total: items.length, analyzed: 0, cached: 0, skipped: 0, failed: 0, pending: 0 };
  for (const item of items) value[item.status === 'pending' ? 'pending' : item.status]++;
  return value;
}
export async function putItems(items) {
  if (items.length > BATCH_LIMITS.files || byteSize(items) > BATCH_LIMITS.bytes) throw new Error('対象一覧の保存上限に達しました。');
  await chrome.storage.session.set({ batchItems: items });
}
export async function completeItem(batch, index, status, reason = '', evicted = 0) {
  const items = await batchItems();
  if (items[index]?.status !== 'pending') return batch;
  let detail = String(reason).slice(0, 249);
  while (byteSize(detail) > 750) detail = detail.slice(0, -1);
  items[index] = { ...items[index], status, reason: detail };
  await putItems(items);
  const next = { ...batch, ...counts(items), current: null, revision: batch.revision + 1, evicted: (batch.evicted ?? 0) + evicted };
  await putBatch(next);
  return next;
}
