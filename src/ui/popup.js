import { gainFor, MAX_BOOST_DB } from '../analysis/loudness.js';
const $ = id => document.getElementById(id);
let tabId, busy = false, active = false, animating = false, shown = new Set();
const labels = { idle: '待機中', identifying: '動画確認中', queued: '解析待ち', analyzing: '解析中', waiting: '再生待ち', playing: '自動補正中', stopped: '停止中', error: '未補正' };
const signed = (value, sign = value) => `${sign >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
async function request(message) {
  const response = await chrome.runtime.sendMessage({ ...message, tabId });
  if (response?.error) throw new Error(response.error);
  return response;
}
function showError(error) { $('error').textContent = error.message; }
function animate(fileId, db) {
  shown.add(fileId); chrome.storage.session.set({ animatedFiles: [...shown].slice(-50) }).catch(() => {});
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  animating = true;
  const number = $('db').firstChild, start = performance.now(), duration = 900;
  const frame = now => {
    const t = Math.min(1, (now - start) / duration), eased = 1 - (1 - t) ** 3;
    number.textContent = signed(db * eased, db);
    if (t < 1) requestAnimationFrame(frame);
    else animating = false;
  };
  requestAnimationFrame(frame);
}
async function refresh() {
  const { state, settings } = await request({ type: 'GET_STATE' });
  active = ['identifying', 'queued', 'analyzing', 'waiting', 'playing'].includes(state.phase);
  const idle = state.phase === 'idle';
  $('phase').textContent = labels[state.phase] ?? '待機中';
  $('phase').dataset.phase = state.phase;
  $('filename').textContent = state.file?.name ?? '';
  $('filename').title = state.file?.name ?? '';
  $('toggle').disabled = busy || idle;
  $('toggle').dataset.active = active;
  $('toggle').ariaLabel = $('toggle').title = active ? 'この動画の補正を停止' : '補正を再開';
  const applied = state.result && active;
  const gain = applied ? state.gain ?? gainFor(state.result, settings.target) : null;
  $('db').hidden = idle;
  $('db').dataset.applied = !!applied;
  if (!animating) {
    $('db').replaceChildren(applied ? signed(gain.db) : '−−', Object.assign(document.createElement('small'), { textContent: gain?.limited ? 'dB 上限' : 'dB' }));
    if (applied && !shown.has(state.fileId)) animate(state.fileId, gain.db);
  }
  let details = '';
  if (applied) details = `${state.result.windows}地点で推定${state.cached ? '　保存済み結果' : ''}${gain.limited ?
    (gain.limitReason === 'short-term' ? '　大きい区間に合わせて調整' : `　増幅は最大+${MAX_BOOST_DB}dBまで`) : ''}`;
  else if (state.progress && state.phase === 'analyzing') {
    const elapsed = Number.isFinite(state.analysisStartedAt) ? `　${Math.max(0, Math.floor((Date.now() - state.analysisStartedAt) / 1000))}秒` : '';
    details = `${state.progress.windows}${state.progress.total ? ` / ${state.progress.total}` : ''}地点${elapsed} / ${(state.progress.bytes / 1024 ** 2).toFixed(2)} MiB`;
  }
  $('stats').textContent = details;
  $('status').textContent = idle || state.phase === 'playing' ? '' : state.message ?? (state.phase === 'analyzing' ? '再生前に複数地点を測定しています（最大約1分）。' :
    state.phase === 'queued' ? 'ほかの動画の解析終了を待っています。' : '');
  $('status').dataset.phase = state.phase;
}
$('toggle').onclick = async () => {
  if (busy) return; busy = true; $('error').textContent = '';
  try { await request({ type: active ? 'STOP' : 'RETRY' }); } catch (error) { showError(error); }
  finally { busy = false; await refresh().catch(showError); }
};
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('batch').onclick = () => request({ type: 'OPEN_BATCH' }).catch(showError);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id;
shown = new Set((await chrome.storage.session.get('animatedFiles').catch(() => ({}))).animatedFiles);
await refresh().catch(showError);
setInterval(() => { if (!busy) refresh().catch(showError); }, 800);
