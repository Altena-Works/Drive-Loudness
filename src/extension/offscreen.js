let worker, workerTimer, active, completed = false;
const send = message => chrome.runtime.sendMessage(message).catch(() => {});
function cancel() { clearTimeout(workerTimer); worker?.terminate(); worker = undefined; active = undefined; completed = false; }
// 完了通知の処理前にSTATUSが来ても、消失したWorkerと誤判定させない。
function finish(message) { clearTimeout(workerTimer); worker?.terminate(); worker = undefined; completed = true; send(message); }
const matches = message => active && ['job', 'ownerType', 'ownerId'].every(key => active[key] === message[key]);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'offscreen') return;
  if (message.type === 'STATUS') { respond({ ok: true, active }); return; }
  if (message.type === 'ANALYZE') {
    if (active && completed && matches(message)) cancel();
    if (active) { respond(matches(message) ? { ok: true } : { error: '別の動画を解析中です。' }); return; }
    if (!['preview', 'batch'].includes(message.ownerType) || !message.ownerId || !message.job) { respond({ error: '解析対象を確認できません。' }); return; }
    active = { job: message.job, ownerType: message.ownerType, ownerId: message.ownerId };
    const identity = { ...active };
    worker = new Worker(chrome.runtime.getURL('analysis-worker.js'), { type: 'module' });
    const ownedWorker = worker;
    workerTimer = setTimeout(() => { if (worker !== ownedWorker || !matches(identity) || completed) return; finish({ type: 'ANALYSIS_ERROR', ...identity, error: '解析時間の上限に達しました。' }); }, 60_000);
    worker.onerror = () => { if (worker !== ownedWorker || !matches(identity) || completed) return; finish({ type: 'ANALYSIS_ERROR', ...identity, error: '解析処理を開始できませんでした。' }); };
    worker.onmessage = ({ data }) => {
      if (worker !== ownedWorker || !matches(identity) || completed) return;
      if (data.type === 'PROGRESS') send({ type: 'ANALYSIS_PROGRESS', ...identity, progress: data.progress });
      else { finish(data.type === 'DONE' ? { type: 'ANALYSIS_DONE', ...identity, result: data.result } : { type: 'ANALYSIS_ERROR', ...identity, error: data.error, code: data.code }); }
    };
    worker.postMessage({ token: message.token, file: message.file });
  }
  if (message.type === 'CANCEL' && matches(message)) cancel();
  respond({ ok: true });
});
