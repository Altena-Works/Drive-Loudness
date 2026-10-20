const $ = id => document.getElementById(id);
const phases = { checking: '対象を確認中', ready: '開始できます', running: '解析中', done: '完了', cancelled: '中断', error: '中断' };
const statuses = { pending: '未処理', analyzed: '解析済み', cached: '保存済み', skipped: '対象外', failed: '失敗' };
let batch, owned = true, busy = false, refreshing = false, revision, deadline, watchedJob;
const rows = new Map();
const seconds = start => Math.max(0, Math.floor((Date.now() - start) / 1000));
const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? '拡張に接続できません。画面を開き直してください。');
  return response;
}
function watch() {
  const current = owned && batch?.phase === 'running' && batch.current?.phase === 'analyzing' ? batch.current : null;
  if (current?.job && current.job === watchedJob) return;
  clearTimeout(deadline); watchedJob = current?.job;
  if (!current?.job) return;
  const runId = batch.runId, job = current.job;
  deadline = setTimeout(() => request({ type: 'BATCH_TIMEOUT', runId, job }).then(refresh).catch(showError), Math.max(0, current.startedAt + 65_000 - Date.now()));
}
function renderItems(items) {
  const ids = new Set(items.map(item => item.id));
  for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    let row = rows.get(item.id);
    if (!row) { row = document.createElement('tr'); for (let i = 0; i < 3; i++) row.append(document.createElement('td')); rows.set(item.id, row); fragment.append(row); }
    [item.name, statuses[item.status] ?? item.status, item.reason ?? ''].forEach((text, i) => { if (row.children[i].textContent !== text) row.children[i].textContent = text; });
  }
  $('items').append(fragment);
}
function render() {
  const locked = batch && ['checking', 'running'].includes(batch.phase);
  $('check').disabled = busy || !!locked; $('folder').disabled = busy || !!locked;
  $('run').hidden = !batch; $('intro').hidden = !!batch;
  if (!batch) return;
  setText('folder-name', batch.folder.name ?? batch.folder.id);
  setText('phase', phases[batch.phase] ?? batch.phase); $('phase').dataset.phase = batch.phase === 'running' ? 'analyzing' : batch.phase === 'error' ? 'error' : batch.phase;
  const completed = batch.total - batch.pending;
  setText('summary', batch.phase === 'checking' ? `${batch.scanned?.found ?? 0}件を確認中` : `${completed} / ${batch.total}件`);
  if (batch.phase === 'checking') $('progress').removeAttribute('value');
  else { $('progress').max = batch.total || 1; $('progress').value = completed; }
  for (const key of ['analyzed', 'cached', 'skipped', 'failed']) setText(key, String(batch[key] ?? 0));
  setText('current-name', batch.current?.name ?? '');
  const current = batch.current, progress = current?.progress;
  setText('current-progress', current ? current.phase === 'preparing' ? '動画情報を確認しています' : `${progress?.windows ?? 0}${progress?.total ? ` / ${progress.total}` : ''}地点　${seconds(current.startedAt)}秒 / ${((progress?.bytes ?? 0) / 1024 ** 2).toFixed(2)} MiB` : '');
  setText('message', !owned ? '別のタブで確認した対象です。実行中の画面から操作してください。' : batch.message ?? (batch.phase === 'ready' ? '対象を確認しました。「解析を開始」で音声を取得します。' : batch.phase === 'done' ? '処理が終了しました。保存した結果はDriveで動画を開くと適用されます。' : ''));
  setText('elapsed', batch.startedAt ? `全体の経過時間 ${Math.max(0, Math.floor(((batch.finishedAt ?? Date.now()) - batch.startedAt) / 1000))}秒` : '');
  $('start').hidden = batch.phase !== 'ready'; $('start').disabled = busy || !owned;
  $('cancel').hidden = !['checking', 'ready', 'running'].includes(batch.phase); $('cancel').disabled = busy || !owned;
  setText('evicted', batch.evicted ? `保存上限に合わせ、古い測定結果${batch.evicted}件を整理しました。` : '');
  $('results').hidden = batch.phase === 'checking' || !batch.total;
  watch();
}
function showError(error) { setText('error', error.message); }
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const response = await request({ type: 'BATCH_STATE', revision }); batch = response.batch; owned = response.owned;
    if (response.items) { renderItems(response.items); revision = batch.revision; }
    render();
  } catch (error) { showError(error); }
  finally { refreshing = false; }
}
async function command(message) {
  if (busy) return; busy = true; setText('error', ''); render();
  try { await request(message); } catch (error) { showError(error); }
  finally { busy = false; await refresh(); }
}
$('folder').value = new URL(location.href).searchParams.get('folder') ?? '';
$('folder-form').onsubmit = event => { event.preventDefault(); command({ type: 'BATCH_CHECK', folder: $('folder').value }); };
$('start').onclick = () => command({ type: 'BATCH_START', runId: batch.runId });
$('cancel').onclick = () => command({ type: 'BATCH_CANCEL', runId: batch.runId });
await refresh();
setInterval(() => { if (!busy) refresh(); }, 1000);
