import { getToken, metadata, cacheKey, discover } from './drive.js';
import { gainFor } from '../analysis/loudness.js';
import { folderId, enumerateFolder } from './folders.js';
import { saveResult } from './cache.js';
import { batchState, batchItems, putBatch, putItems, counts, completeItem } from './batch-store.js';

let queue = Promise.resolve();
const serialize = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
const sessions = async () => (await chrome.storage.session.get('sessions')).sessions ?? {};
const get = async tabId => (await sessions())[tabId];
async function put(state) { const all = await sessions(); all[state.tabId] = state; await chrome.storage.session.set({ sessions: all }); }
const settings = async () => ({ target: -23, volume: 1 });
const activeAnalysis = async () => (await chrome.storage.session.get('activeAnalysis')).activeAnalysis;
const setActive = activeAnalysis => chrome.storage.session.set({ activeAnalysis });
const offscreenUrl = chrome.runtime.getURL('offscreen.html');
const publicError = error => typeof error?.message === 'string' && error.message.length < 250 ? error.message : '処理を完了できませんでした。';
const ANALYSIS_DEADLINE_MS = 65_000;
// 通信は状態更新キューの外で行う。トークンとAbortControllerはメモリだけに保持する。
const preparations = new Map(), prepared = new Map(), finishing = new Map(), tokens = new Map();
let listing;
const previewKey = state => `preview:${state.tabId}:${state.key}`;
const batchKey = batch => `batch:${batch.runId}`;
const identity = active => ({ job: active.jobId, ownerType: active.ownerType, ownerId: active.ownerId });
const sameJob = (active, message) => active && active.jobId === message.job && active.ownerType === message.ownerType && active.ownerId === message.ownerId;
async function exists() { return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] })).length > 0; }
async function offscreen(message) {
  const response = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  if (!response?.ok) throw new Error(response?.error ?? '解析ページに接続できません。');
  return response;
}
async function ensureOffscreen() {
  if (!(await exists())) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: '動画音声の部分解析' });
}
async function player(state, message) {
  const options = state.documentId ? { documentId: state.documentId } : { frameId: state.frameId };
  const response = await chrome.tabs.sendMessage(state.tabId, { ...message, key: state.key, view: state.view }, options);
  if (!response?.ok) throw new Error(response?.error ?? '動画に接続できません。');
  return response;
}
async function check(state) {
  const media = await discover(state.tabId, state);
  if (media.fileId !== state.fileId || media.frameId !== state.frameId) throw new Error('対象動画が変わりました。');
  await player(state, { type: 'CHECK' });
}
async function notice(state, label) {
  if (state.frameId !== 0) await chrome.tabs.sendMessage(state.tabId, { type: 'NOTICE', fileId: state.fileId, label }, { frameId: 0 }).catch(() => {});
}
function abortPreparation(key) { preparations.get(key)?.abort(); preparations.delete(key); prepared.delete(key); }
async function releaseJob(active) {
  if (!sameJob(await activeAnalysis(), identity(active))) return;
  // 先に所有権を解除して遅延結果を拒否する。
  await setActive(null);
  finishing.get(active.jobId)?.abort(); finishing.delete(active.jobId); tokens.delete(active.jobId);
  if (await exists()) await offscreen({ type: 'CANCEL', ...identity(active) }).catch(() => {});
}
async function stopTab(tabId, reason = '自動補正を停止しました。') {
  const state = await get(tabId); if (!state) return;
  await put({ ...state, phase: 'stopped', message: reason });
  abortPreparation(previewKey(state));
  const active = await activeAnalysis();
  if (active?.ownerType === 'preview' && active.ownerId === tabId) await releaseJob(active);
  await player(state, { type: 'RESTORE' }).catch(() => {});
}
async function fail(state, error) {
  const message = publicError(error);
  await put({ ...state, phase: 'error', message });
  await player(state, { type: 'FAIL', error: message }).catch(() => {});
}
async function cancelBatch(reason = '一括解析を中止しました。') {
  const batch = await batchState();
  if (!batch || !['checking', 'ready', 'running'].includes(batch.phase)) return;
  await putBatch({ ...batch, phase: 'cancelled', current: null, message: reason, finishedAt: Date.now() });
  if (listing?.runId === batch.runId) { listing.controller.abort(); listing = undefined; }
  abortPreparation(batchKey(batch));
  const active = await activeAnalysis();
  if (active?.ownerType === 'batch' && active.ownerId === batch.runId) await releaseJob(active);
}
async function failJob(active, error) {
  if (!sameJob(await activeAnalysis(), identity(active))) return;
  await releaseJob(active);
  if (active.ownerType === 'preview') {
    const state = await get(active.ownerId);
    if (state?.key === active.key && state.phase === 'analyzing') await fail(state, error);
  } else {
    const batch = await batchState();
    if (batch?.runId === active.ownerId && batch.phase === 'running') {
      const next = await completeItem(batch, active.index, 'failed', publicError(error));
      if (error.code === 'AUTH') await putBatch({ ...next, phase: 'error', message: publicError(error), finishedAt: Date.now() });
    }
  }
}
async function recoverAnalysis() {
  const active = await activeAnalysis();
  if (active) {
    const expired = !Number.isFinite(active.startedAt) || Date.now() - active.startedAt >= ANALYSIS_DEADLINE_MS;
    const alive = await exists();
    const status = alive ? await offscreen({ type: 'STATUS' }).catch(() => null) : null;
    // DONE受信後の版照合はWorker終了後に行われる。
    const lost = !alive || (active.stage === 'analyzing' && !sameJob(active, status?.active ?? {}));
    if (expired || lost) await failJob(active, new Error(expired ? '解析時間の上限に達しました。補正を再開して再試行できます。' : '解析が中断されました。再開してください。'));
  }
  // 旧版または更新途中の状態も、プレーヤーを待たせたままにしない。
  for (const state of Object.values(await sessions())) {
    if (state.phase !== 'analyzing') continue;
    const job = await activeAnalysis();
    if (job?.ownerType === 'preview' && job.ownerId === state.tabId && job.jobId === state.job) continue;
    await fail(state, new Error('解析時間の上限に達したか、中断されました。補正を再開してください。'));
  }
}
async function apply(state, result, cached) {
  await check(state);
  const config = await settings(), gain = gainFor(result, config.target);
  const label = `${gain.db < 0 ? '−' : '＋'}${Math.abs(gain.db).toFixed(1)} dB${gain.limited ? '（上限）' : ''}`;
  const response = await player(state, { type: 'APPLY', gain: gain.linear, volume: config.volume, label });
  await put({ ...state, result, cached, gain, label, phase: response.running ? 'playing' : 'waiting',
    message: response.running ? '自動補正しています。' : '補正の準備ができました。Driveで再生してください。' });
  if (response.running) await notice(state, label);
}
function preparePreview(state) {
  const key = previewKey(state);
  if (preparations.has(key) || prepared.has(key)) return;
  const controller = new AbortController(); preparations.set(key, controller);
  (async () => {
    try {
      await check(state);
      const token = await getToken(), file = await metadata(state.fileId, token, true, controller.signal);
      await check(state); controller.signal.throwIfAborted();
      await serialize(async () => {
        const current = await get(state.tabId);
        if (current?.key !== state.key || current.phase !== 'queued') return;
        const saved = ((await chrome.storage.local.get('cache')).cache ?? {})[cacheKey(file)];
        if (saved) await apply({ ...current, file }, saved.result, true);
        else prepared.set(key, { file, token });
      });
    } catch (error) {
      await serialize(async () => {
        const current = await get(state.tabId);
        if (!controller.signal.aborted && current?.key === state.key && current.phase === 'queued') await fail(current, error);
      });
    } finally {
      if (preparations.get(key) === controller) preparations.delete(key);
      await serialize(pump);
    }
  })().catch(() => {});
}
function prepareBatch(batch, index, item) {
  const key = batchKey(batch), controller = new AbortController(); preparations.set(key, controller);
  (async () => {
    try {
      const token = await getToken(), file = await metadata(item.id, token, true, controller.signal);
      controller.signal.throwIfAborted();
      await serialize(async () => {
        const current = await batchState();
        if (current?.runId !== batch.runId || current.phase !== 'running' || current.current?.index !== index) return;
        const saved = ((await chrome.storage.local.get('cache')).cache ?? {})[cacheKey(file)];
        if (saved) await completeItem(current, index, 'cached');
        else prepared.set(key, { file, token });
      });
    } catch (error) {
      await serialize(async () => {
        const current = await batchState();
        if (controller.signal.aborted || current?.runId !== batch.runId || current.phase !== 'running') return;
        const next = await completeItem(current, index, 'failed', publicError(error));
        if (error.code === 'AUTH') await putBatch({ ...next, phase: 'error', message: publicError(error), finishedAt: Date.now() });
      });
    } finally {
      if (preparations.get(key) === controller) preparations.delete(key);
      await serialize(pump);
    }
  })().catch(() => {});
}
async function startJob(ownerType, ownerId, data, extra = {}) {
  const active = { ownerType, ownerId, jobId: crypto.randomUUID(), startedAt: Date.now(), stage: 'analyzing', file: data.file, ...extra };
  try {
    await ensureOffscreen(); await setActive(active); tokens.set(active.jobId, data.token);
    if (ownerType === 'preview') {
      const state = await get(ownerId);
      await put({ ...state, file: data.file, phase: 'analyzing', job: active.jobId, analysisStartedAt: active.startedAt, progress: { windows: 0, bytes: 0, requests: 0 } });
      await player(state, { type: 'ANALYSIS_START', job: active.jobId });
    } else {
      const batch = await batchState();
      await putBatch({ ...batch, current: { ...batch.current, phase: 'analyzing', job: active.jobId, startedAt: active.startedAt, progress: { windows: 0, bytes: 0 } } });
    }
    await offscreen({ type: 'ANALYZE', ...identity(active), file: data.file, token: data.token });
  } catch (error) {
    if (sameJob(await activeAnalysis(), identity(active))) await failJob(active, error);
    else if (ownerType === 'preview') { const state = await get(ownerId); if (state?.key === extra.key) await fail(state, error); }
    else { const batch = await batchState(); if (batch?.runId === ownerId && batch.phase === 'running') await completeItem(batch, extra.index, 'failed', publicError(error)); }
    await pump();
  }
}
async function pump() {
  const all = Object.values(await sessions()).filter(state => state.phase === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  for (const state of all) preparePreview(state);
  if (await activeAnalysis()) return;
  if (all.length) {
    const state = all[0], key = previewKey(state), data = prepared.get(key);
    if (data) { prepared.delete(key); await startJob('preview', state.tabId, data, { key: state.key }); }
    return;
  }
  let batch = await batchState();
  if (batch?.phase !== 'running') return;
  const key = batchKey(batch), data = prepared.get(key);
  if (data) { prepared.delete(key); await startJob('batch', batch.runId, data, { index: batch.current.index }); return; }
  if (preparations.has(key)) return;
  const items = await batchItems(), index = items.findIndex(item => item.status === 'pending');
  if (index < 0) { await putBatch({ ...batch, phase: 'done', current: null, finishedAt: Date.now() }); return; }
  batch = { ...batch, current: { index, name: items[index].name, phase: 'preparing', startedAt: Date.now() } };
  await putBatch(batch); prepareBatch(batch, index, items[index]);
}
async function ready(message, sender) {
  let media;
  try { media = await discover(sender.tab.id, { ...sender, key: message.key, view: message.view }); } catch { return { retry: true }; }
  if (media.frameId !== sender.frameId) return { retry: true };
  const previous = await get(sender.tab.id);
  if (previous?.key === message.key && previous.documentId === sender.documentId) return { accepted: true };
  const state = { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId, key: message.key, view: message.view, fileId: media.fileId, phase: 'queued', createdAt: Date.now() };
  await player(state, { type: 'CHECK' });
  if (previous) await stopTab(sender.tab.id);
  await put(state); await recoverAnalysis(); await pump(); return { accepted: true };
}
function verifyResult(active, result) {
  const controller = new AbortController(); finishing.set(active.jobId, controller);
  (async () => {
    try {
      const file = await metadata(active.file.id, await getToken(), true, controller.signal);
      if (file.version !== active.file.version) throw new Error('解析中に動画が更新されました。再開してください。');
      controller.signal.throwIfAborted();
      await serialize(async () => {
        if (!sameJob(await activeAnalysis(), identity(active))) return;
        if (active.ownerType === 'preview') {
          const state = await get(active.ownerId);
          if (state?.key !== active.key || state.phase !== 'analyzing') return;
          await check(state); await saveResult(file, result); await apply(state, result, false);
        } else {
          const batch = await batchState();
          if (batch?.runId !== active.ownerId || batch.phase !== 'running') return;
          const evicted = await saveResult(file, result);
          await completeItem(batch, active.index, 'analyzed', '', evicted);
        }
        await releaseJob(active);
      });
    } catch (error) {
      if (!controller.signal.aborted) await serialize(() => failJob(active, error));
    } finally { finishing.delete(active.jobId); await serialize(pump); }
  })().catch(() => {});
}
async function analysis(message) {
  const active = await activeAnalysis();
  if (!sameJob(active, message) || active.stage !== 'analyzing') return;
  if (Date.now() - active.startedAt >= ANALYSIS_DEADLINE_MS) { await failJob(active, new Error('解析時間の上限に達しました。')); await pump(); return; }
  if (message.type === 'ANALYSIS_PROGRESS') {
    if (active.ownerType === 'preview') { const state = await get(active.ownerId); if (state?.job === active.jobId) await put({ ...state, progress: message.progress }); }
    else { const batch = await batchState(); if (batch?.runId === active.ownerId && batch.phase === 'running') await putBatch({ ...batch, current: { ...batch.current, progress: message.progress } }); }
    return;
  }
  if (message.type === 'ANALYSIS_ERROR') {
    if (message.code === 'AUTH' && !active.authRetried) {
      await setActive({ ...active, stage: 'refreshing', authRetried: true });
      (async () => {
        try {
          const oldToken = tokens.get(active.jobId);
          if (oldToken) await chrome.identity.removeCachedAuthToken({ token: oldToken });
          const token = await getToken();
          await serialize(async () => {
            if (!sameJob(await activeAnalysis(), identity(active))) return;
            tokens.set(active.jobId, token); await setActive({ ...active, stage: 'analyzing', authRetried: true });
            await offscreen({ type: 'ANALYZE', ...identity(active), file: active.file, token });
          });
        } catch (error) { await serialize(async () => { await failJob(active, Object.assign(error, { code: 'AUTH' })); await pump(); }); }
      })().catch(() => {});
    } else { await failJob(active, Object.assign(new Error(message.error), { code: message.code })); await pump(); }
    return;
  }
  if (message.type === 'ANALYSIS_DONE') { await setActive({ ...active, stage: 'saving' }); verifyResult(active, message.result); }
}
async function topView(tabId) {
  if (!Number.isInteger(tabId)) return null;
  return chrome.tabs.sendMessage(tabId, { type: 'VIEW_STATUS' }, { frameId: 0 }).catch(() => null);
}
async function viewChanged(tabId) {
  const state = await get(tabId); if (!state || ['stopped', 'error'].includes(state.phase)) return;
  const view = await topView(tabId);
  if (!view?.ok || view.fileId !== state.fileId || view.view !== state.view || view.key !== state.key) {
    await stopTab(tabId, '動画を閉じたか、別の動画に切り替わりました。'); await pump();
  }
}

function startListing(run) {
  const controller = new AbortController(); listing = { runId: run.runId, controller };
  (async () => {
    try {
      const result = await enumerateFolder(run.folder.id, { signal: controller.signal, progress: progress => serialize(async () => {
        const current = await batchState();
        if (current?.runId === run.runId && current.phase === 'checking') await putBatch({ ...current, scanned: progress });
      }) });
      await serialize(async () => {
        const current = await batchState(); if (current?.runId !== run.runId || current.phase !== 'checking') return;
        await putItems(result.items);
        await putBatch({ ...current, folder: result.folder, phase: 'ready', ...counts(result.items), revision: current.revision + 1 });
      });
    } catch (error) {
      if (!controller.signal.aborted) await serialize(async () => {
        const current = await batchState(); if (current?.runId === run.runId && current.phase === 'checking') await putBatch({ ...current, phase: 'error', message: publicError(error) });
      });
    } finally { if (listing?.controller === controller) listing = undefined; }
  })().catch(() => {});
}
async function batchUi(message, ownerTabId) {
  let batch = await batchState();
  if (message.type === 'BATCH_STATE') {
    await recoverAnalysis(); await pump(); batch = await batchState();
    if (batch?.phase === 'checking' && listing?.runId !== batch.runId) {
      batch = { ...batch, phase: 'error', message: '対象確認が中断されました。もう一度確認してください。' }; await putBatch(batch);
    }
    return { batch, owned: !batch || batch.ownerTabId === ownerTabId, items: batch && message.revision !== batch.revision ? await batchItems() : undefined };
  }
  if (message.type === 'BATCH_CHECK') {
    if (batch && ['checking', 'running'].includes(batch.phase)) throw new Error('実行中の一括処理を中止してから確認してください。');
    const id = folderId(message.folder);
    const run = { runId: crypto.randomUUID(), ownerTabId, phase: 'checking', folder: { id }, revision: (batch?.revision ?? 0) + 1, ...counts([]), evicted: 0 };
    await putItems([]); await putBatch(run); startListing(run); return {};
  }
  if (!batch || batch.ownerTabId !== ownerTabId || batch.runId !== message.runId) throw new Error('この画面の対象を確認し直してください。');
  if (message.type === 'BATCH_START') {
    if (batch.phase !== 'ready') throw new Error('対象を確認してから開始してください。');
    await putBatch({ ...batch, phase: 'running', startedAt: Date.now(), current: null }); await pump(); return {};
  }
  if (message.type === 'BATCH_CANCEL') { await cancelBatch(); await pump(); return {}; }
  if (message.type === 'BATCH_TIMEOUT') {
    const active = await activeAnalysis();
    if (active?.ownerType === 'batch' && active.ownerId === batch.runId && active.jobId === message.job && Date.now() - active.startedAt >= ANALYSIS_DEADLINE_MS) {
      await failJob(active, new Error('解析時間の上限に達しました。')); await pump();
    }
    return {};
  }
  throw new Error('未対応の操作です。');
}
async function ui(message) {
  const state = await get(message.tabId);
  if (message.type === 'OPEN_BATCH') {
    let folder = '';
    if (Number.isInteger(message.tabId)) { const tab = await chrome.tabs.get(message.tabId).catch(() => null); try { folder = folderId(tab?.url); } catch {} }
    const url = chrome.runtime.getURL('batch.html') + (folder ? `?folder=${encodeURIComponent(folder)}` : '');
    const saved = (await chrome.storage.session.get('batchPageTabId')).batchPageTabId;
    if (saved) {
      const tab = await chrome.tabs.get(saved).catch(() => null);
      if (tab && batchSender({ url: tab.url })) {
        const batch = await batchState();
        const processing = batch?.ownerTabId === saved && ['checking', 'running'].includes(batch.phase);
        await chrome.tabs.update(saved, processing ? { active: true } : { active: true, url }); return {};
      }
    }
    const tab = await chrome.tabs.create({ url });
    await chrome.storage.session.set({ batchPageTabId: tab.id }); return {};
  }
  if (message.type === 'GET_STATE') {
    await recoverAnalysis(); await pump();
    const latest = await get(message.tabId);
    const status = latest ? await player(latest, { type: 'AUDIO_STATUS' }).catch(() => null) : null;
    const view = await topView(message.tabId);
    const matches = view?.ok && latest?.key === view.key && latest?.view === view.view && latest?.fileId === view.fileId;
    return { state: matches ? latest : view?.ok ? { phase: ['stopped', 'error'].includes(view.phase) ? view.phase : 'identifying', message: view.error ?? '表示中の動画を確認しています。' } : { phase: 'idle' }, settings: await settings(), audio: matches ? status?.audio : null };
  }
  if (message.type === 'STOP') {
    const view = await topView(message.tabId);
    if (view?.ok) await chrome.tabs.sendMessage(message.tabId, { type: 'STOP_VIEW', view: view.view, key: view.key }, { frameId: 0 }).catch(() => {});
    await stopTab(message.tabId); await pump(); return {};
  }
  if (message.type === 'RETRY') {
    const view = await topView(message.tabId);
    if (!view?.ok) throw new Error('Driveで動画を開いてください。');
    await stopTab(message.tabId);
    await chrome.tabs.sendMessage(message.tabId, { type: 'RETRY_VIEW', view: view.view, key: view.key }, { frameId: 0 });
    await pump(); return {};
  }
  if (message.type === 'CLEAR_CACHE') { await cancelBatch('測定結果の削除により中止しました。'); await chrome.storage.local.remove('cache'); await pump(); return {}; }
  if (message.type === 'CONNECT' || message.type === 'DISCONNECT') {
    await cancelBatch('Google接続の変更により中止しました。');
    for (const current of Object.values(await sessions())) await stopTab(current.tabId);
    await chrome.storage.local.remove('cache'); await chrome.identity.clearAllCachedAuthTokens();
    if (message.type === 'CONNECT') { await getToken(true); for (const current of Object.values(await sessions())) await player(current, { type: 'RETRY' }).catch(() => {}); }
    return {};
  }
  throw new Error('未対応の操作です。');
}
function mediaSender(sender) {
  if (!sender.tab || !sender.tab.url?.startsWith('https://drive.google.com/')) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'https:' && (['drive.google.com', 'docs.google.com'].includes(url.hostname) || (url.hostname === 'youtube.googleapis.com' && url.pathname === '/embed/' && url.searchParams.get('ps') === 'docs' && url.searchParams.get('origin') === 'https://drive.google.com'));
  } catch { return false; }
}
function batchSender(sender) {
  try { const url = new URL(sender.url); return url.protocol === 'chrome-extension:' && url.host === chrome.runtime.id && url.pathname === '/batch.html'; } catch { return false; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target === 'offscreen') return;
  const isUi = ['popup.html', 'options.html'].some(path => sender.url === chrome.runtime.getURL(path));
  const isBatch = batchSender(sender), isOffscreen = sender.url === offscreenUrl, isMedia = mediaSender(sender);
  if (!isUi && !isBatch && !isOffscreen && !isMedia) return;
  serialize(async () => {
    if (isUi) return ui(message);
    if (isBatch) {
      const context = sender.documentId ? (await chrome.runtime.getContexts({ documentIds: [sender.documentId] })).find(c => c.documentUrl === sender.url && c.tabId >= 0) : null;
      const tabId = context?.tabId ?? sender.tab?.id;
      if (!Number.isInteger(tabId)) throw new Error('一括解析の画面を開き直してください。');
      return batchUi(message, tabId);
    }
    if (isOffscreen) return analysis(message);
    if (message.type === 'VIEW_CHANGED' && sender.frameId === 0) { await viewChanged(sender.tab.id); return {}; }
    if (!/^[a-f0-9-]{36}$/.test(message.key ?? '')) return {};
    if (message.type === 'MEDIA_READY') return ready(message, sender);
    const state = await get(sender.tab.id);
    if (!state || state.key !== message.key || state.view !== message.view || state.frameId !== sender.frameId || state.documentId !== sender.documentId) return {};
    if (message.type === 'MEDIA_GONE') { await stopTab(state.tabId, '動画が切り替わりました。'); await pump(); }
    if (message.type === 'MEDIA_ERROR') {
      await stopTab(state.tabId);
      await put({ ...state, phase: 'error', message: publicError(new Error(message.error)) }); await pump();
    }
    if (message.type === 'AUDIO_ACTIVE' && state.phase === 'waiting') { await put({ ...state, phase: 'playing', message: '自動補正しています。' }); await notice(state, state.label); }
    return {};
  }).then(result => respond({ ok: true, ...result }), error => respond({ error: publicError(error) }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => serialize(async () => {
  const batch = await batchState(); if (batch?.ownerTabId === tabId) await cancelBatch('処理画面を閉じたため中断しました。');
  await stopTab(tabId); const all = await sessions(); delete all[tabId]; await chrome.storage.session.set({ sessions: all }); await pump();
}));
chrome.webNavigation.onBeforeNavigate.addListener(details => serialize(async () => {
  const batch = await batchState();
  if (details.frameId === 0 && batch?.ownerTabId === details.tabId && !batchSender({ url: details.url })) await cancelBatch('処理画面から移動したため中断しました。');
  const state = await get(details.tabId);
  if (state && (details.frameId === 0 || details.frameId === state.frameId)) { await stopTab(details.tabId, 'ページが移動しました。'); await pump(); }
}));
chrome.webNavigation.onHistoryStateUpdated.addListener(details => serialize(async () => { if (details.frameId === 0) await viewChanged(details.tabId); }));
