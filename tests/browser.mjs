import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtureName = 'tone-3min.mp4';
const fixture = await readFile(path.join(root, 'tests/fixtures', fixtureName));
const profile = await mkdtemp(path.join(tmpdir(), 'drive-loudness-test-'));
const extension = path.join(profile, 'extension');
await cp(path.join(root, 'dist'), extension, { recursive: true });
// Playwrightはoffscreen Workerの通信をrouteで捕捉しないため、テスト用コピーだけに
// fetchの置換を前置する。元の配布物や解析コードは変更しない。
const transport = `
globalThis.fetch = async (url, init) => {
  if (new URL(url).origin !== 'https://www.googleapis.com') throw new Error('Test blocks external network');
  if (new URL(url).pathname.includes('BatchCancelVideo12345')) await new Promise(resolve => setTimeout(resolve, 5000));
  const raw = atob('${fixture.toString('base64')}');
  const [start, end] = init.headers.Range.match(/\\d+/g).map(Number);
  const bytes = Uint8Array.from(raw.slice(start, end + 1), c => c.charCodeAt(0));
  return new Response(bytes, {status:206, headers:{'Content-Range':'bytes '+start+'-'+end+'/${fixture.length}'}});
};\n`;
const bundle = await readFile(path.join(root, 'dist/analysis-worker.js'), 'utf8');
await writeFile(path.join(extension, 'analysis-worker.js'), transport + bundle);
await mkdir(path.join(root, 'test-results'), { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + name);
    if (name === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local audio analysis test</title>'); return; }
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.mp4') ? 'video/mp4' : 'text/plain');
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (match) {
      const start = +match[1], end = +match[2];
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      res.end(data.subarray(start, end + 1));
    } else res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, chromiumSandbox: true, args: [
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
  ] });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(sw.url()).hostname;
  const failures = [];
  context.on('page', page => {
    page.on('pageerror', error => failures.push({ message: error.message, stack: error.stack }));
    page.on('console', message => {
      if (message.type() === 'error' && /Failed to execute 'postMessage'.*target origin/.test(message.text())) failures.push({ message: message.text() });
    });
  });
  const local = await context.newPage();
  await local.goto(`http://127.0.0.1:${server.address().port}/`);
  const stats = await local.evaluate(async fixtureName => {
    const { RangeReader } = await import('/src/analysis/range.js');
    const { analyze } = await import('/src/analysis/analyze.js');
    const url = '/tests/fixtures/' + fixtureName;
    const head = await fetch(url);
    const size = (await head.arrayBuffer()).byteLength;
    const progress = [];
    const result = await analyze(new RangeReader({ url, size }), value => progress.push(value));
    return { ...result, testProgress: progress };
  }, fixtureName);
  // ffmpegはstderrに測定結果を出す。
  const ref = await new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => execFile('ffmpeg', ['-hide_banner', '-i', path.join(root, 'tests/fixtures', fixtureName), '-af', 'ebur128', '-f', 'null', '-'], (_, stdout, stderr) => {
      const values = [...stderr.matchAll(/I:\s+(-?\d+(?:\.\d+)?) LUFS/g)];
      if (!values.length) reject(new Error('ffmpegの参照値を読めません')); else resolve(+values.at(-1)[1]);
    }));
  });
  assert.ok(Math.abs(stats.lufs - ref) < 0.2, `LUFS ${stats.lufs} vs ${ref}`);
  assert.equal(stats.windows, 13);
  assert.equal(stats.analyzer, 2);
  assert.equal(stats.testProgress[0].windows, 0);
  assert.ok(stats.testProgress.every(p => p.total === 13));
  assert.equal(stats.testProgress.at(-1).windows, 13);
  console.log('WebCodecs AAC区間解析:', JSON.stringify({ lufs: stats.lufs, reference: ref, windows: stats.windows, bytes: stats.bytes, requests: stats.requests }));

  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  const shippedManifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(await options.locator('#connect').isDisabled(), !shippedManifest.oauth2?.client_id);
  await options.locator('#clear').click();
  await options.getByRole('status').filter({ hasText: '測定結果を削除しました。' }).waitFor();

  // Google/OAuthだけを人工データに置換し、配布物の自動動作を確認する。
  const fileId = 'LocalTestVideo1234567890', nextId = 'LocalTestVideoChanged123456';
  let version = '1', metadataRequests = 0, batchMode = 'normal';
  const batchFolderId = 'BatchFolderRoot12345', batchChildId = 'BatchFolderChild12345';
  const batchA = 'BatchFreshVideoA12345', batchB = 'BatchFreshVideoB12345';
  await context.route('https://www.googleapis.com/**', async route => {
    metadataRequests++;
    const url = new URL(route.request().url());
    if (url.pathname === '/drive/v3/files') {
      const item = (id, mimeType = 'video/mp4') => ({ id, mimeType, name: id + '.mp4' });
      const root = url.searchParams.get('q').includes(batchFolderId);
      const files = batchMode === 'cancel' ? [item('BatchCancelVideo12345')] : root ?
        [item(batchChildId, 'application/vnd.google-apps.folder'), item(batchA), item('BatchShortcut123456', 'application/vnd.google-apps.shortcut')] :
        [item(batchA), item(batchB), item('BatchOtherVideo12345', 'video/webm')];
      if (batchMode === 'normal' && root && !url.searchParams.get('pageToken')) await route.fulfill({ json: { files: [], nextPageToken: 'second' } });
      else await route.fulfill({ json: { files } });
      return;
    }
    const requestedId = /files\/([^?]+)/.exec(route.request().url())[1];
    if (requestedId === batchFolderId) { await route.fulfill({ json: { id: batchFolderId, name: '一括解析テスト', mimeType: 'application/vnd.google-apps.folder' } }); return; }
    await route.fulfill({ json: { id: requestedId, name: requestedId === nextId ? 'fixture-next.mp4' : 'fixture.mp4', size: String(fixture.length), version, mimeType: 'video/mp4', capabilities: { canDownload: true } } });
  });
  const playerHtml = '<!doctype html><meta charset="utf-8"><button id="play">再生</button><video aria-hidden="true" controls preload="auto" src="/test-video.mp4"></video><script>document.querySelector("video").volume=0.3;if(parent!==window){const v=document.querySelector("video");v.style.transform="translateY(-1000px)";v.preload="none";v.load();}document.querySelector("button").onclick=()=>document.querySelector("video").play();window.addEventListener("message",e=>{if(e.source===parent&&e.origin==="https://drive.google.com"&&e.data==="fixture-play")document.querySelector("video").play()})</script>';
  const serveMedia = async route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    if (!range) { await route.fulfill({ contentType: 'video/mp4', body: fixture }); return; }
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), fixture.length - 1) : fixture.length - 1;
    await route.fulfill({ status: 206, contentType: 'video/mp4', headers: { 'Content-Range': `bytes ${start}-${end}/${fixture.length}`, 'Accept-Ranges': 'bytes' }, body: fixture.subarray(start, end + 1) });
  };
  await context.route('https://youtube.googleapis.com/**', async route => {
    if (route.request().url().includes('/test-video.mp4')) await serveMedia(route);
    else { await new Promise(resolve => setTimeout(resolve, 900)); await route.fulfill({ contentType: 'text/html; charset=utf-8', body: playerHtml }); }
  });
  await context.route('https://drive.google.com/**', async route => {
    if (route.request().url().includes('/test-video.mp4')) { await serveMedia(route); return; }
    const folder = `<!doctype html><meta charset="utf-8"><h2>fixture.mp4</h2><div role="row" data-id="${fileId}" aria-selected="true"><strong>fixture.mp4</strong></div><div role="row" data-id="${nextId}" aria-selected="false"><strong>fixture-next.mp4</strong></div><iframe id="first" allow="autoplay" srcdoc="<p>準備中</p>" src="https://youtube.googleapis.com/embed/?ps=docs&origin=https%3A%2F%2Fdrive.google.com"></iframe><iframe id="second" hidden allow="autoplay" src="https://youtube.googleapis.com/embed/?ps=docs&origin=https%3A%2F%2Fdrive.google.com&next=1"></iframe><button id="previous">前へ</button><button id="next">次へ</button><button id="outer-play">Driveの再生</button><script>setTimeout(()=>document.querySelector('#first').removeAttribute('srcdoc'),1200);let second=false;function select(value){second=value;document.querySelector('h2').textContent=second?'fixture-next.mp4':'fixture.mp4';document.querySelector('#first').hidden=second;document.querySelector('#second').hidden=!second;}document.querySelector('#next').onclick=()=>select(true);document.querySelector('#previous').onclick=()=>select(false);document.querySelector('#outer-play').onclick=()=>{const frame=document.querySelector(second?'#second':'#first');function play(){if(frame.contentDocument)return;frame.removeEventListener('load',play);frame.contentWindow.postMessage('fixture-play','https://youtube.googleapis.com')}frame.addEventListener('load',play);play()}</script>`;
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: route.request().url().includes('/drive/folders/') ? folder : playerHtml });
  });
  await sw.evaluate(async () => {
    const manifest = chrome.runtime.getManifest();
    chrome.runtime.getManifest = () => ({ ...manifest, oauth2: { client_id: '123-test.apps.googleusercontent.com' } });
    chrome.identity.getAuthToken = async () => ({ token: 'synthetic-local-test-value', grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    await chrome.storage.local.set({ target: -14, volume: 0.1 });
  });
  const drive = await context.newPage();
  await drive.goto(`https://drive.google.com/file/d/${fileId}/view`);
  const tabId = await sw.evaluate(async fileId => (await chrome.tabs.query({})).find(t => t.url?.includes(fileId)).id, fileId);
  const ui = await context.newPage();
  await ui.addInitScript(tabId => { chrome.tabs.query = async () => [{ id: tabId }]; }, tabId);
  await ui.goto(`chrome-extension://${id}/popup.html`);
  const command = message => ui.evaluate(message => chrome.runtime.sendMessage(message), { tabId, ...message });
  const waitState = async (target, forTab = tabId) => {
    for (let attempt = 0; attempt < 250; attempt++) {
      const state = (await command({ type: 'GET_STATE', tabId: forTab })).state;
      if (target.includes(state.phase)) return state;
      if (state.phase === 'error') throw new Error(state.message);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`state timeout: ${JSON.stringify((await command({ type: 'GET_STATE', tabId: forTab })).state)}`);
  };
  const prepared = await waitState(['waiting', 'playing']);
  assert.equal(prepared.result.windows, 13); assert.equal(prepared.cached, false);
  assert.ok(Math.abs(prepared.result.lufs - ref) < 0.2);
  // 拡張ボタンで起動せず、通常の再生操作だけでAudioContextを再開する。
  await drive.getByRole('button', { name: '再生', exact: true }).click();
  await waitState(['playing']); await drive.waitForFunction(() => !document.querySelector('video').paused);
  await drive.locator('[data-drive-loudness-notice]').waitFor();
  assert.match(await drive.locator('[data-drive-loudness-notice]').textContent(), /^−1\.9 dB$/);
  await drive.screenshot({ path: path.join(root, 'test-results/auto-notice.png') });
  await drive.locator('[data-drive-loudness-notice]').waitFor({ state: 'detached', timeout: 5000 });
  const playing = await command({ type: 'GET_STATE' }); assert.equal(playing.audio.context, 'running'); assert.ok(playing.audio.rms > 0.01);
  assert.deepEqual(playing.settings, { target: -23, volume: 1 }, '以前の設定にかかわらず基準固定/追加音量調整なし');
  await ui.reload();
  await ui.waitForFunction(() => document.querySelector('#phase').textContent === '自動補正中');
  assert.equal(await ui.getByRole('slider').count(), 0);
  assert.equal(await ui.getByText('Driveで動画を開くと', { exact: false }).count(), 0);
  await ui.locator('body').screenshot({ path: path.join(root, 'test-results/popup-fixed-level.png') });
  const fixedOptions = await context.newPage(); await fixedOptions.goto(`chrome-extension://${id}/options.html`);
  assert.equal(await fixedOptions.getByRole('slider').count(), 0);
  assert.equal(await fixedOptions.getByRole('heading', { name: '目標音量', exact: true }).count(), 0);
  await fixedOptions.screenshot({ path: path.join(root, 'test-results/options-fixed-level.png'), fullPage: true }); await fixedOptions.close();

  const second = await context.newPage(); await second.goto(`https://drive.google.com/file/d/${fileId}/view`);
  const secondTab = await sw.evaluate(async () => (await chrome.tabs.query({})).filter(t => t.url?.includes('/file/d/')).at(-1).id);
  assert.equal((await waitState(['waiting', 'playing'], secondTab)).cached, true);
  assert.equal((await command({ type: 'GET_STATE' })).state.phase, 'playing');
  await command({ type: 'STOP' });
  assert.equal(await drive.evaluate(() => document.querySelector('video').volume), 0.3);
  assert.equal(await drive.evaluate(() => document.querySelector('video').muted), false);
  await drive.getByRole('button', { name: '再生', exact: true }).click();
  await drive.waitForFunction(() => !document.querySelector('video').paused);
  await drive.waitForTimeout(100);
  assert.ok((await command({ type: 'GET_STATE' })).audio.rms > 0.01, '停止後の原音も出力される');
  await command({ type: 'RETRY' }); assert.equal((await waitState(['waiting', 'playing'])).cached, true);

  // 同一video要素のソース更新と、ファイルID更新の競合。
  await drive.evaluate(nextId => {
    history.pushState({}, '', `/file/d/${nextId}/view`);
    document.querySelector('video').src = '/test-video.mp4?revision=2';
  }, nextId);
  const changed = await waitState(['waiting', 'playing']);
  assert.equal(changed.file.id, nextId);
  await drive.getByRole('button', { name: '再生', exact: true }).click(); await waitState(['playing']);
  await command({ type: 'STOP' });
  await second.close();

  const folder = await context.newPage(), originErrors = [];
  // targetOrigin不一致はpageerror/consoleではなくChromeのsecurityログに出る。
  const frameLog = await context.newCDPSession(folder);
  frameLog.on('Log.entryAdded', ({ entry }) => { if (/Failed to execute 'postMessage'.*target origin/.test(entry.text)) originErrors.push(entry.text); });
  await frameLog.send('Log.enable');
  await folder.goto('https://drive.google.com/drive/folders/FixtureFolder123456');
  const folderTab = await sw.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.includes('/drive/folders/')).id);
  const openedBatch = context.waitForEvent('page');
  await command({ type: 'OPEN_BATCH', tabId: folderTab });
  const autofill = await openedBatch;
  await autofill.waitForLoadState();
  assert.equal(await autofill.locator('#folder').inputValue(), 'FixtureFolder123456');
  await folder.evaluate(() => history.pushState({}, '', '/drive/folders/SecondFolder12345'));
  await command({ type: 'OPEN_BATCH', tabId: folderTab });
  await autofill.waitForURL('**/batch.html?folder=SecondFolder12345');
  await autofill.waitForFunction(() => document.querySelector('#folder')?.value === 'SecondFolder12345');
  assert.equal(context.pages().filter(page => page.url().includes('/batch.html')).length, 1);
  assert.equal(await sw.evaluate(async () => (await chrome.storage.session.get('batch')).batch), undefined, '自動入力だけでは対象確認や解析を開始しない');
  await autofill.close();
  await folder.evaluate(() => history.pushState({}, '', '/drive/folders/FixtureFolder123456'));
  console.log('一括画面: 新規/再利用時にクリック元フォルダーを自動入力（自動開始なし）');
  await folder.frameLocator('#first').locator('video').waitFor();
  assert.deepEqual(originErrors, [], '親Drive文書から動画フレームへの読み込み中に宛先origin不一致を出さない');
  await folder.getByRole('button', { name: 'Driveの再生', exact: true }).click();
  const folderState = await waitState(['waiting', 'playing'], folderTab);
  assert.equal(folderState.file.id, fileId); assert.equal(folderState.cached, true);
  await folder.frameLocator('#first').getByRole('button', { name: '再生', exact: true }).click();
  await waitState(['playing'], folderTab);
  await folder.locator('[data-drive-loudness-notice]').waitFor();
  assert.match(await folder.locator('[data-drive-loudness-notice]').textContent(), /^−1\.9 dB$/);
  await folder.getByRole('button', { name: '次へ' }).click();
  await folder.getByRole('button', { name: 'Driveの再生', exact: true }).click();
  let switched;
  for (let attempt = 0; attempt < 150; attempt++) {
    switched = (await command({ type: 'GET_STATE', tabId: folderTab })).state;
    if (switched.file?.id === nextId && ['waiting', 'playing'].includes(switched.phase)) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(switched.file.id, nextId); assert.ok(['waiting', 'playing'].includes(switched.phase));
  const progressing = async frame => {
    for (let i = 0; i < 60; i++) {
      if (await frame.locator('video').evaluate(v => !v.paused && v.currentTime > .1)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('切り替え後に再生時間が進まない: ' + JSON.stringify(await frame.locator('video').evaluate(v => ({ paused: v.paused, muted: v.muted, ready: v.readyState, time: v.currentTime, error: v.error?.code, message: v.error?.message, src: v.currentSrc, origin: location.origin }))));
  };
  await folder.getByRole('button', { name: 'Driveの再生', exact: true }).click();
  await progressing(folder.frameLocator('#second'));
  await folder.getByRole('button', { name: '前へ', exact: true }).click();
  const returned = await waitState(['waiting', 'playing'], folderTab);
  assert.equal(returned.fileId, fileId);
  await folder.getByRole('button', { name: 'Driveの再生', exact: true }).click();
  await progressing(folder.frameLocator('#first'));
  await folder.getByRole('button', { name: '次へ', exact: true }).click();
  await folder.getByRole('button', { name: '前へ', exact: true }).click();
  const rapid = await waitState(['waiting', 'playing'], folderTab); assert.equal(rapid.fileId, fileId);
  await command({ type: 'STOP', tabId: folderTab });
  await folder.getByRole('button', { name: 'Driveの再生', exact: true }).click();
  await progressing(folder.frameLocator('#first'));
  console.log('先読みiframeを保持した左右往復・高速切り替え・Drive外側からの再生・STOP後の再生を確認');
  // 同じWindowProxyが別originの文書へ移っても、親の制御を転送しない。
  await folder.frameLocator('#first').locator('video').evaluate((video, id) => location.replace(`https://drive.google.com/file/d/${id}/preview`), fileId);
  await folder.waitForFunction(() => document.querySelector('#first').contentDocument?.URL.includes('/preview'));
  await folder.frameLocator('#first').locator('video').evaluate((video, encoded) => {
    const data = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
    video.src = URL.createObjectURL(new Blob([data], { type: 'video/mp4' })); video.load();
  }, fixture.toString('base64'));
  await folder.frameLocator('#first').getByRole('button', { name: '再生', exact: true }).click();
  await progressing(folder.frameLocator('#first'));
  await folder.waitForTimeout(1100);
  assert.deepEqual(originErrors, [], '接続後の文書遷移でも旧Windowへは送信しない');
  assert.equal(await folder.frameLocator('#first').locator('video').evaluate(video => video.muted), false);
  await folder.locator('#first').evaluate(frame => { frame.src = 'https://youtube.googleapis.com/embed/?ps=docs&origin=https%3A%2F%2Fdrive.google.com&reconnected=1'; });
  await folder.waitForFunction(() => document.querySelector('#first').contentDocument === null);
  await folder.frameLocator('#first').locator('video').waitFor();
  await folder.getByRole('button', { name: 'Driveの再生', exact: true }).click();
  const reconnected = await waitState(['waiting', 'playing'], folderTab);
  assert.equal(reconnected.fileId, fileId);
  await progressing(folder.frameLocator('#first'));
  console.log('動画フレームの文書がDrive originへ移った後も宛先エラーなし・原音再生・再接続後の補正を確認');
  version = '2'; await folder.reload();
  await folder.getByRole('button', { name: 'Driveの再生', exact: true }).click();
  const renewed = await waitState(['waiting', 'playing'], folderTab); assert.equal(renewed.file.version, '2'); assert.equal(renewed.cached, false);
  // 終了通知が失われ、offscreenページだけ残った状態からも復帰できる。
  await sw.evaluate(async tabId => {
    const { sessions } = await chrome.storage.session.get('sessions');
    sessions[tabId] = { ...sessions[tabId], phase: 'analyzing', job: 'lost-completion', analysisStartedAt: Date.now() - 70_000 };
    await chrome.storage.session.set({ sessions });
  }, folderTab);
  const expired = (await command({ type: 'GET_STATE', tabId: folderTab })).state;
  assert.equal(expired.phase, 'error'); assert.match(expired.message, /時間の上限/);
  await command({ type: 'RETRY', tabId: folderTab });
  assert.equal((await waitState(['waiting', 'playing'], folderTab)).cached, true);
  // 実際の拡張タブから再帰列挙→解析→再利用を操作する。
  const batchPage = await context.newPage();
  await batchPage.clock.install();
  await batchPage.addInitScript(() => {
    window.testIntervals = []; const original = window.setInterval.bind(window);
    window.setInterval = (...args) => { const id = original(...args); window.testIntervals.push(id); return id; };
  });
  await batchPage.goto(`chrome-extension://${id}/batch.html?folder=${batchFolderId}`);
  await batchPage.getByRole('button', { name: '対象を確認', exact: true }).click();
  await batchPage.waitForFunction(() => document.querySelector('#phase').textContent === '開始できます');
  assert.equal(await batchPage.locator('#skipped').textContent(), '2');
  await batchPage.getByRole('button', { name: '解析を開始', exact: true }).click();
  await batchPage.waitForFunction(() => document.querySelector('#phase').textContent === '完了');
  assert.equal(await batchPage.locator('#analyzed').textContent(), '2');
  assert.equal(await batchPage.locator('#summary').textContent(), '4 / 4件');
  await batchPage.getByText('ファイルごとの結果', { exact: true }).click();
  await batchPage.screenshot({ path: path.join(root, 'test-results/batch-complete.png'), fullPage: true });
  await batchPage.getByRole('button', { name: '対象を確認', exact: true }).click();
  await batchPage.waitForFunction(() => document.querySelector('#phase').textContent === '開始できます');
  await batchPage.getByRole('button', { name: '解析を開始', exact: true }).click();
  await batchPage.waitForFunction(() => document.querySelector('#phase').textContent === '完了');
  assert.equal(await batchPage.locator('#cached').textContent(), '2');
  const cachedPreview = await context.newPage(); await cachedPreview.goto(`https://drive.google.com/file/d/${batchA}/view`);
  const cachedTab = await sw.evaluate(async batchA => (await chrome.tabs.query({})).find(t => t.url?.includes(batchA)).id, batchA);
  assert.equal((await waitState(['waiting', 'playing'], cachedTab)).cached, true);
  await cachedPreview.close();
  // ポーリングを止めても、専用画面のワンショット期限通知が一括Workerを回収する。
  batchMode = 'cancel';
  await batchPage.getByRole('button', { name: '対象を確認', exact: true }).click();
  await batchPage.waitForFunction(() => document.querySelector('#phase').textContent === '開始できます');
  await batchPage.getByRole('button', { name: '解析を開始', exact: true }).click();
  await batchPage.waitForFunction(() => document.querySelector('#current-progress').textContent.includes('地点'));
  await batchPage.evaluate(() => window.testIntervals.forEach(clearInterval));
  await sw.evaluate(async () => { const { activeAnalysis } = await chrome.storage.session.get('activeAnalysis'); activeAnalysis.startedAt = Date.now() - 70_000; await chrome.storage.session.set({ activeAnalysis }); });
  await batchPage.clock.fastForward(65_001);
  await batchPage.waitForFunction(() => document.querySelector('#phase').textContent === '完了');
  assert.equal(await batchPage.locator('#failed').textContent(), '1');
  await batchPage.close();
  const closePage = await context.newPage(); await closePage.goto(`chrome-extension://${id}/batch.html?folder=${batchFolderId}`);
  await closePage.getByRole('button', { name: '対象を確認', exact: true }).click();
  await closePage.waitForFunction(() => document.querySelector('#phase').textContent === '開始できます');
  await closePage.getByRole('button', { name: '解析を開始', exact: true }).click();
  await closePage.waitForFunction(() => document.querySelector('#current-progress').textContent.includes('地点'));
  await closePage.close();
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await sw.evaluate(async () => (await chrome.storage.session.get('batch')).batch);
    if (value.phase === 'cancelled') break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const closed = await sw.evaluate(async () => chrome.storage.session.get(['batch', 'activeAnalysis']));
  assert.equal(closed.batch.phase, 'cancelled'); assert.equal(closed.activeAnalysis, null);
  console.log('一括解析: 階層/空ページ送り/重複/対象外/実Worker解析/再利用/通常プレビュー/ポーリングなしの期限回収/タブ終了時中断を確認');
  const cache = await sw.evaluate(async () => (await chrome.storage.local.get('cache')).cache);
  assert.ok(!JSON.stringify(cache).includes('synthetic-local-test-value'));
  assert.deepEqual(failures, []);
  assert.deepEqual(originErrors, []);
  console.log('配布物: 自動解析・通常の再生操作・dB通知と消去・音声出力・原音復帰・キャッシュ・複数タブ・同一要素更新・フォルダー切替・版更新・終了通知欠落の復旧を確認（Google/OAuth通信はmock）');
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
