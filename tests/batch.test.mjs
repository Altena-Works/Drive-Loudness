import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { folderId, enumerateFolder, FOLDER, SHORTCUT, byteSize } from '../src/extension/folders.js';
import { updatedCache, saveResult } from '../src/extension/cache.js';
import { cacheKey } from '../src/extension/drive.js';
const rootId = 'RootFolder123456', childId = 'ChildFolder12345';
const file = (id, mimeType = 'video/mp4') => ({ id, name: id + '.mp4', mimeType });

test('フォルダーURLだけを受理し、外部URL/動画URL/クエリー中の偽URLを拒否する', () => {
  assert.equal(folderId(`https://drive.google.com/drive/u/0/folders/${rootId}?usp=sharing`), rootId);
  assert.equal(folderId(rootId), rootId);
  for (const input of [`https://other.example/drive/folders/${rootId}`, `https://drive.google.com/file/d/${rootId}/view`, `https://drive.google.com/?folder=${rootId}`, `https://evil@drive.google.com/drive/folders/${rootId}`, 'root']) assert.throws(() => folderId(input));
});
test('空ページの続き・入れ子・重複・共有ドライブを扱い、ショートカット先へ進まない', async () => {
  const calls = [];
  const result = await enumerateFolder(rootId, { request: async path => {
    calls.push(path); const url = new URL(path, 'https://example/');
    if (url.pathname === '/files/' + rootId) return { id: rootId, name: 'Root', mimeType: FOLDER, driveId: 'SharedDrive123456' };
    assert.equal(url.searchParams.get('corpora'), 'drive'); assert.equal(url.searchParams.get('driveId'), 'SharedDrive123456');
    if (url.searchParams.get('q').includes(rootId)) {
      if (!url.searchParams.get('pageToken')) return { files: [], nextPageToken: 'second' };
      return { files: [file(childId, FOLDER), file('VideoFile123456'), file('Shortcut123456', SHORTCUT), file('OtherVideo12345', 'video/webm')] };
    }
    return { files: [file('VideoFile123456'), file('NestedVideo12345'), file(rootId, FOLDER)] };
  } });
  assert.equal(calls.length, 4);
  assert.equal(result.items.length, 4);
  assert.equal(result.items.filter(x => x.status === 'skipped').length, 2);
  assert.deepEqual(result.items.filter(x => x.status === 'pending').map(x => x.id), ['VideoFile123456', 'NestedVideo12345']);
});
test('一覧の未完了・ページ循環・上限・中断を完了扱いにしない', async () => {
  const request = page => async path => path.startsWith('files/') ? { id: rootId, mimeType: FOLDER } : page;
  await assert.rejects(enumerateFolder(rootId, { request: request({ files: [], incompleteSearch: true }) }), /未完了/);
  await assert.rejects(enumerateFolder(rootId, { request: request({ files: [], nextPageToken: 'repeated' }) }), /ページ送り/);
  await assert.rejects(enumerateFolder(rootId, { request: request({ files: [file('VideoFile123456'), file('SecondVideo12345')] }), limits: { files: 1, folders: 2, bytes: 10000 } }), /上限/);
  const controller = new AbortController();
  await assert.rejects(enumerateFolder(rootId, { signal: controller.signal, request: request({ files: [], nextPageToken: 'next' }), progress: async () => controller.abort() }), { name: 'AbortError' });
});
test('50件を超えるキャッシュを保持し、同じ動画の旧版だけを置換する', () => {
  const previous = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`VideoFile${i}:1:aac-default:analyzer-2:3s-weighted-v2`, { result: { lufs: -20 }, measuredAt: i }]));
  const next = updatedCache(previous, { id: 'VideoFile0', version: '2' }, { lufs: -21 });
  assert.equal(Object.keys(next.cache).length, 80); assert(!next.cache['VideoFile0:1:aac-default:analyzer-2:3s-weighted-v2']);
  assert.equal(Object.keys(previous).length, 80); assert.equal(next.evicted, 0);
});
test('UTF-8容量と件数で古い結果を整理し、保存失敗でも旧キャッシュを維持する', async () => {
  const old = globalThis.chrome;
  const previous = { 'OtherVideo123:1': { result: { name: 'あ'.repeat(60) }, measuredAt: 1 } };
  const file = { id: 'NewVideo123456', version: '1' }, result = { lufs: -21 };
  const next = updatedCache(previous, file, result, { limits: { files: 5000, bytes: 200 } });
  assert(byteSize(next.cache) <= 200); assert.equal(next.evicted, 1); assert(next.cache[cacheKey(file)]);
  const limited = updatedCache(previous, file, result, { limits: { files: 1, bytes: 10000 } }); assert.equal(Object.keys(limited.cache).length, 1);
  try {
    const storage = { cache: structuredClone(previous) };
    globalThis.chrome = { storage: { local: { get: async () => storage, set: async () => { throw new Error('quota'); } } } };
    await assert.rejects(saveResult(file, result), /quota/); assert.deepEqual(storage.cache, previous);
  } finally { globalThis.chrome = old; }
});
test('offscreenは所有者の異なる中止と二重開始を拒否し、旧Worker結果を捨てる', async () => {
  const source = await readFile(new URL('../src/extension/offscreen.js', import.meta.url), 'utf8');
  const workers = [], messages = []; let listener;
  const sandbox = { Worker: class { constructor() { workers.push(this); } postMessage() {} terminate() { this.terminated = true; } },
    setTimeout: () => 1, clearTimeout() {},
    chrome: { runtime: { id: 'test', getURL: x => x, onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async value => messages.push(value) } } };
  vm.runInNewContext(source, sandbox);
  const call = message => { let result; listener({ target: 'offscreen', ...message }, { id: 'test' }, value => { result = value; }); return result; };
  const first = { job: 'first', ownerType: 'batch', ownerId: 'run' }, second = { job: 'second', ownerType: 'preview', ownerId: 1 };
  assert(call({ type: 'ANALYZE', ...first, file: {} }).ok);
  assert(call({ type: 'ANALYZE', ...second, file: {} }).error); assert.equal(workers.length, 1);
  call({ type: 'CANCEL', ...second }); assert(!workers[0].terminated);
  call({ type: 'CANCEL', ...first }); assert(workers[0].terminated);
  call({ type: 'ANALYZE', ...second, file: {} });
  workers[0].onerror(); assert.equal(messages.length, 0); assert(!workers[1].terminated);
  workers[0].onmessage({ data: { type: 'DONE', result: {} } }); assert.equal(messages.length, 0); assert(!workers[1].terminated);
  workers[1].onmessage({ data: { type: 'ERROR', error: 'expired', code: 'AUTH' } });
  assert.equal(messages[0].ownerId, 1);
  assert.equal(call({ type: 'STATUS' }).active.job, second.job, '完了通知を処理する前に所有権を消さない');
  call({ type: 'ANALYZE', ...second, file: {} });
  assert.equal(workers.length, 3, 'AUTH更新後は同一jobでも新しいWorkerで再解析する');
  workers[1].onerror(); workers[1].onmessage({ data: { type: 'DONE', result: {} } });
  assert.equal(messages.length, 1); assert(!workers[2].terminated);
  workers[2].onmessage({ data: { type: 'DONE', result: { lufs: -21 } } });
  assert.equal(messages[1].type, 'ANALYSIS_DONE');
  assert.equal(call({ type: 'STATUS' }).active.job, second.job);
  call({ type: 'CANCEL', ...second }); assert.equal(call({ type: 'STATUS' }).active, undefined);
});
