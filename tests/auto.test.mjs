import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { probeFrame, metadata, cacheKey } from '../src/extension/drive.js';
import { PlayerAudio } from '../src/extension/player-audio.js';
import { visibleElement, visiblePlayers, playerFrame } from '../src/extension/view.js';

class TestMessageChannel {
  constructor() {
    const make = () => ({ closed: false, start() {}, close() { this.closed = true; }, postMessage(data) { if (!this.closed && !this.peer.closed) this.peer.onmessage?.({ data }); } });
    this.port1 = make(); this.port2 = make(); this.port1.peer = this.port2; this.port2.peer = this.port1;
  }
}

function contentFixture({ paused = false, muted = false, running = true, embedded = false, readyReply = { ok: true, accepted: true } } = {}) {
  const events = new Map(), sent = [], upstream = [], notices = [], timers = new Map();
  let handler, tick, parentPort, nextTimer = 0;
  class Video {
    readyState = 4; duration = 180; volume = 0.4; isConnected = true;
    tagName = 'VIDEO'; currentSrc = 'blob:https://youtube.googleapis.com/first'; src = this.currentSrc;
    constructor() { this.paused = paused; this.muted = muted; }
    pause() { if (!this.paused) { this.paused = true; events.get('pause')?.({ target: this }); } }
    play() { this.paused = false; events.get('play')?.({ target: this }); return Promise.resolve(); }
  }
  const node = new Video();
  let instance;
  class Audio {
    context = { state: running ? 'running' : 'suspended' };
    nodes = new WeakSet();
    constructor() { instance = this; }
    apply(video, gain, volume) { this.nodes.add(video); this.applied = { video, gain, volume }; }
    bypass() { this.applied = null; }
    resume() { return Promise.resolve(); }
    volume() {}
    status(video) { return { context: this.context.state, volume: video.volume, rms: 0 }; }
  }
  const sandbox = { URL, MessageChannel: TestMessageChannel, playerFrame, visibleElement: node => node.isConnected, visiblePlayers: () => node.isConnected ? [node] : [], PlayerAudio: Audio, probeFrame: () => ({ ids: ['FixtureVideo123456'] }), crypto: { randomUUID }, HTMLVideoElement: Video,
    location: { href: 'https://youtube.googleapis.com/embed/?ps=docs&origin=https%3A%2F%2Fdrive.google.com', ancestorOrigins: ['https://drive.google.com'] }, window: { top: {}, addEventListener: (name, fn) => events.set('window:' + name, fn) },
    MutationObserver: class { observe() {} }, clearTimeout: id => timers.delete(id),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, setInterval: fn => { tick = fn; },
    document: { querySelectorAll: selector => selector === 'video' && node.isConnected ? [node] : [], addEventListener: (name, fn) => events.set(name, fn),
      createElement: () => { const notice = { style: {}, setAttribute() {}, remove() { this.removed = true; } }; notices.push(notice); return notice; },
      body: { append() {} } },
    chrome: { runtime: { id: 'test', onMessage: { addListener(fn) { handler = fn; } }, sendMessage: async message => { sent.push(message); return typeof readyReply === 'function' ? readyReply(message) : readyReply; } } },
  };
  sandbox.window.parent = { postMessage(message, origin, ports) {
    assert.equal(origin, 'https://drive.google.com'); assert.equal(message.type, 'CONNECT');
    parentPort = ports[0]; parentPort.onmessage = event => {
      if (event.data.type === 'CONFIRMED') parentPort.postMessage({ channel: message.channel, type: 'ACCEPTED', id: message.id });
      else upstream.push(event.data);
    };
    parentPort.postMessage({ channel: message.channel, type: 'CONNECTED', id: message.id });
  } };
  sandbox.window.top = embedded ? {} : sandbox.window;
  return { sandbox, node, events, sent, upstream, notices, timers, dispatchParent: message => parentPort.postMessage({ channel: 'drive-loudness-view', ...message }), audio: () => instance, tick: () => tick(),
    call(message) { let response; handler({ ...message, view: sent.find(m => m.type === 'MEDIA_READY' && m.key === message.key)?.view }, { id: 'test' }, result => { response = result; }); return response; } };
}
const contentSource = (await readFile(new URL('../src/extension/content.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '');

test('子の接続をorigin/sourceで検証し、親の制御はWindowの移動と無関係なポートだけを使う', () => {
  const f = contentFixture(), messages = [];
  const frame = { tagName: 'IFRAME', isConnected: true,
    src: 'https://youtube.googleapis.com/embed/?ps=docs&origin=https%3A%2F%2Fdrive.google.com',
    get contentDocument() { throw new Error('文書確認と送信の間には遷移できるため、文書には依存しない'); },
    contentWindow: { postMessage() { assert.fail('親からWindowへは送信しない'); } } };
  f.sandbox.visiblePlayers = () => frame.isConnected ? [frame] : [];
  f.sandbox.document.querySelectorAll = selector => selector === 'iframe[src]' ? [frame] : [];
  vm.runInNewContext(contentSource, f.sandbox); f.tick(); assert.equal(messages.length, 0);
  const connect = (origin, source = frame.contentWindow, confirm = true) => {
    const channel = new TestMessageChannel(); channel.id = randomUUID();
    channel.port2.onmessage = event => { messages.push(event.data); if (confirm && event.data.type === 'CONNECTED') channel.port2.postMessage({ channel: 'drive-loudness-view', type: 'CONFIRMED', id: event.data.id }); };
    f.events.get('window:message')({ data: { channel: 'drive-loudness-view', type: 'CONNECT', id: channel.id }, origin, source, ports: [channel.port1] });
    return channel;
  };
  assert.equal(connect('https://drive.google.com').port1.closed, true);
  assert.equal(connect('https://youtube.googleapis.com', {}).port1.closed, true);
  assert.equal(messages.length, 0, '未検証の接続にはview/keyを渡さない');
  const first = connect('https://youtube.googleapis.com');
  assert.equal(messages[0].type, 'CONNECTED'); assert.equal(messages.at(-1).type, 'PROBE');
  const view = messages.at(-1).view, key = randomUUID();
  first.port2.postMessage({ channel: 'drive-loudness-view', type: 'READY', view, key });
  assert.equal(messages.at(-1).type, 'ACK');
  assert.equal(f.call({ type: 'VIEW_STATUS' }).key, key);
  const unconfirmed = connect('https://youtube.googleapis.com', frame.contentWindow, false);
  assert.equal(first.port1.closed, false, '遅延した未確認CONNECTで現リンクを閉じない');
  const pendingDeadline = [...f.timers.values()].find(t => t.ms === 2000); pendingDeadline.fn();
  assert.equal(unconfirmed.port1.closed, true);
  const pending = connect('https://youtube.googleapis.com', frame.contentWindow, false);
  const delayed = pending.port1.onmessage;
  const latest = connect('https://youtube.googleapis.com');
  assert.equal(pending.port1.closed, true);
  delayed({ data: { channel: 'drive-loudness-view', type: 'CONFIRMED', id: pending.id } });
  assert.equal(latest.port1.closed, false, '旧未確認候補の遅延確認で最新確定portを閉じない');
  const notices = f.sent.filter(m => m.type === 'VIEW_CHANGED').length;
  const before = messages.length, stale = first.port1.onmessage;
  frame.src = 'https://docs.google.com/file/d/FixtureVideo123456/preview'; f.tick();
  assert.equal(messages.length, before, 'src変更後は旧接続を使わない');
  assert.equal(f.call({ type: 'VIEW_STATUS' }).key, undefined, 'src変更直後に旧keyを現行として返さない');
  assert.equal(f.sent.filter(m => m.type === 'VIEW_CHANGED').length, notices + 1);
  const second = connect('https://docs.google.com'); assert.equal(first.port1.closed, true);
  const connected = messages.length;
  stale({ data: { channel: 'drive-loudness-view', type: 'READY', view, key } });
  assert.equal(messages.length, connected, '旧ポートの遅延応答を拒否する');
  frame.isConnected = false; f.tick(); assert.equal(messages.length, connected);
  assert.equal(second.port1.closed, false);
  assert.equal(f.sent.some(m => m.type === 'MEDIA_READY'), false);
});

test('子の接続確認が失われても再接続し、旧ポートの確認や命令を採用しない', () => {
  const f = contentFixture({ embedded: true }), attempts = [], replies = [];
  let now = 0;
  f.sandbox.Date = { now: () => now };
  f.sandbox.window.parent.postMessage = (message, origin, ports) => { assert.equal(origin, 'https://drive.google.com'); attempts.push({ message, port: ports[0] }); };
  vm.runInNewContext(contentSource, f.sandbox); assert.equal(attempts.length, 1);
  const stale = attempts[0].port.peer.onmessage;
  now = 999; f.tick(); assert.equal(attempts.length, 1);
  now = 1000; f.tick(); assert.equal(attempts.length, 2); assert.equal(attempts[0].port.peer.closed, true);
  stale({ data: { channel: 'drive-loudness-view', type: 'CONNECTED', id: attempts[0].message.id } });
  stale({ data: { channel: 'drive-loudness-view', type: 'PROBE', view: randomUUID() } });
  now = 2000; f.tick(); assert.equal(attempts.length, 3);
  const active = attempts.at(-1); active.port.onmessage = event => replies.push(event.data);
  active.port.postMessage({ channel: 'drive-loudness-view', type: 'CONNECTED', id: active.message.id });
  active.port.postMessage({ channel: 'drive-loudness-view', type: 'ACCEPTED', id: active.message.id });
  now = 3000; f.tick(); assert.equal(attempts.length, 3);
  active.port.postMessage({ channel: 'drive-loudness-view', type: 'PROBE', view: randomUUID() });
  assert.equal(replies.at(-1).type, 'READY');
  assert.equal(f.node.muted, false); assert.equal(f.sent.some(m => m.type === 'MEDIA_READY'), false);
});

test('許可されていない親originへはポートを送信せず、原音再生を維持する', () => {
  const f = contentFixture({ embedded: true }); let attempts = 0;
  f.sandbox.location.ancestorOrigins = ['https://other.example'];
  f.sandbox.window.parent.postMessage = () => { attempts++; };
  vm.runInNewContext(contentSource, f.sandbox); f.tick();
  assert.equal(attempts, 0); assert.equal(f.node.muted, false); assert.equal(f.node.paused, false); assert.equal(f.sent.length, 0);
});

test('未解析音を止め、自動適用後に要求された再生だけを再開し、dB通知を3秒で消す', async () => {
  const f = contentFixture(); vm.runInNewContext(contentSource, f.sandbox);
  assert.equal(f.node.paused, true); assert.equal(f.node.muted, true);
  const key = f.sent.find(m => m.type === 'MEDIA_READY').key;
  assert.equal(f.call({ type: 'ANALYSIS_START', key, job: randomUUID() }).ok, true);
  assert.equal([...f.timers.values()].some(t => t.ms === 65_000), true);
  assert.equal(f.call({ type: 'APPLY', key, gain: 0.8, volume: 0.5, label: '−1.9 dB' }).ok, true);
  assert.equal([...f.timers.values()].some(t => t.ms === 65_000), false);
  assert.equal(f.node.muted, false); assert.equal(f.node.paused, false); assert.equal(f.node.volume, 1);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].textContent, '−1.9 dB');
  const hide = [...f.timers.values()].find(t => t.ms === 3000); assert.ok(hide); hide.fn();
  assert.equal(f.notices[0].removed, true);
  f.node.pause(); await f.node.play(); assert.equal(f.notices.length, 1);
  f.call({ type: 'RESTORE', key }); assert.equal(f.node.volume, 0.4); assert.equal(f.audio().applied, null);
});

test('Workerから終了通知がなくても動画側の期限で未補正へ戻り、通常再生できる', async () => {
  const f = contentFixture({ paused: true }); vm.runInNewContext(contentSource, f.sandbox);
  assert.equal([...f.timers.values()].some(t => t.ms === 65_000), false, 'キュー待ちでは期限を開始しない');
  const key = f.sent.find(m => m.type === 'MEDIA_READY').key, job = randomUUID();
  assert.equal(f.call({ type: 'ANALYSIS_START', key, job }).ok, true);
  const deadline = [...f.timers.values()].find(t => t.ms === 65_000); assert.ok(deadline);
  assert.equal(f.node.muted, true);
  deadline.fn();
  assert.equal(f.node.muted, false); assert.equal(f.node.volume, .4);
  assert.ok(f.sent.some(m => m.type === 'MEDIA_ERROR' && /時間の上限/.test(m.error)));
  assert.ok(f.notices.some(n => /未補正/.test(n.textContent)));
  await f.node.play(); assert.equal(f.node.paused, false);
});

test('動画の登録応答が返らなくても10秒で特定待ちを解除する', async () => {
  const f = contentFixture({ paused: true });
  f.sandbox.chrome.runtime.sendMessage = message => { f.sent.push(message); return new Promise(() => {}); };
  vm.runInNewContext(contentSource, f.sandbox);
  const deadline = [...f.timers.values()].find(t => t.ms === 10_000);
  assert.ok(deadline, '登録の応答promiseと独立した特定待ちの期限が必要');
  deadline.fn();
  assert.equal(f.node.muted, false);
  await f.node.play(); assert.equal(f.node.paused, false);
});

test('長くキュー待ちした動画の期限はWorker開始時から数える', async () => {
  const beforeChrome = globalThis.chrome, beforeFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(); await f.announce(1); await f.announce(2);
    f.sessionStorage.sessions[2].createdAt = Date.now() - 120_000;
    assert.equal(f.messages.filter(m => m.type === 'ANALYSIS_START' && m.tabId === 2).length, 0);
    const beforeStart = Date.now();
    await f.invoke({ type: 'STOP', tabId: 1 }, { url: 'chrome-extension://test/popup.html' });
    assert.equal(f.sessionStorage.sessions[2].phase, 'analyzing');
    assert.ok(f.sessionStorage.sessions[2].analysisStartedAt >= beforeStart);
    assert.equal(f.messages.filter(m => m.type === 'ANALYSIS_START' && m.tabId === 2).length, 1);
  } finally { globalThis.chrome = beforeChrome; globalThis.fetch = beforeFetch; }
});

test('AudioContextがsuspendedなら成功通知をせず、ユーザー再生操作でrunningを確認する', async () => {
  const f = contentFixture({ paused: true, running: false }); vm.runInNewContext(contentSource, f.sandbox);
  const key = f.sent.find(m => m.type === 'MEDIA_READY').key;
  const response = f.call({ type: 'APPLY', key, gain: 1, volume: 0.5, label: '＋0.0 dB' });
  await Promise.resolve();
  assert.equal(response.running, false); assert.equal(f.notices.length, 0); assert.equal(f.node.paused, true);
  f.audio().context.state = 'running'; f.events.get('keydown')({ isTrusted: true }); await Promise.resolve();
  assert.equal(f.notices.length, 1); assert.equal(f.node.paused, true, '再生要求がなければ自動再生しない');
});

test('ソース切替で旧補正を拒否し、元のミュートとユーザー音量を維持する', async () => {
  const f = contentFixture({ paused: true, muted: true }); vm.runInNewContext(contentSource, f.sandbox);
  const key = f.sent.find(m => m.type === 'MEDIA_READY').key;
  f.call({ type: 'APPLY', key, gain: 1, volume: 0.5, label: '＋0.0 dB' });
  assert.equal(f.node.muted, true); f.node.volume = 0.7; f.node.muted = false;
  f.node.currentSrc = 'blob:https://youtube.googleapis.com/second'; f.events.get('loadstart')({ target: f.node });
  assert.equal(f.node.volume, 0.7); assert.ok(f.call({ type: 'APPLY', key, gain: 1, volume: 1 }).error);
  const nextKey = f.sent.filter(m => m.type === 'MEDIA_READY').at(-1).key;
  assert.notEqual(nextKey, key); f.call({ type: 'RESTORE', key: nextKey }); assert.equal(f.node.muted, false);
});

test('suspendedのまま停止/失敗しても、通常再生で等倍経路を再開する', async () => {
  for (const type of ['RESTORE', 'FAIL']) {
    const f = contentFixture({ paused: true, running: false }); vm.runInNewContext(contentSource, f.sandbox);
    const key = f.sent.find(m => m.type === 'MEDIA_READY').key;
    f.call({ type: 'APPLY', key, gain: 0.5, volume: 0.5, label: '−6.0 dB' });
    f.call({ type, key, error: 'fixture error' });
    f.audio().resume = () => { f.audio().context.state = 'running'; return Promise.resolve(); };
    await f.node.play(); await Promise.resolve();
    assert.equal(f.node.paused, false); assert.equal(f.node.volume, 0.4); assert.equal(f.audio().applied, null);
  }
});

test('Drive以外の埋め込みフレームには接続しない', () => {
  const f = contentFixture(); f.sandbox.location.href = 'https://youtube.googleapis.com/embed/?ps=other&origin=https%3A%2F%2Fdrive.google.com';
  vm.runInNewContext(contentSource, f.sandbox); assert.equal(f.sent.length, 0); assert.equal(f.node.muted, false);
});

test('親ページの通知は現在の動画IDと補正dBが一致する場合だけ表示する', () => {
  const f = contentFixture(); f.sandbox.probeFrame = () => ({ ids: [] }); vm.runInNewContext(contentSource, f.sandbox);
  f.sandbox.probeFrame = () => ({ ids: ['FixtureVideo123456'] });
  assert.ok(f.call({ type: 'NOTICE', fileId: 'OldVideo123456', label: '＋4.1 dB' }).error);
  assert.ok(f.call({ type: 'NOTICE', fileId: 'FixtureVideo123456', label: '<script>' }).error);
  assert.equal(f.notices.length, 0);
  assert.equal(f.call({ type: 'NOTICE', fileId: 'FixtureVideo123456', label: '＋4.1 dB' }).ok, true);
  assert.equal(f.notices[0].textContent, '＋4.1 dB');
  f.tick(); assert.notEqual(f.notices[0].removed, true, '表示直後の監視処理では消さない');
});

test('フォルダーの選択だけでは識別せず、表示中の動画名と一つの行が一致する場合だけ識別する', () => {
  const row = { querySelector: () => ({ textContent: 'fixture.mp4' }), getAttribute: () => 'FolderVideo123456' };
  let headings = [], rows = [row];
  const sandbox = { URL, location: { href: 'https://drive.google.com/drive/folders/Folder123456' }, document: {
    querySelectorAll: selector => selector.startsWith('h2') ? headings : selector.startsWith('[role="row"]') ? rows : [],
    querySelector: () => ({}),
  } };
  const probe = () => vm.runInNewContext(`(${probeFrame.toString()})()`, sandbox);
  assert.equal(probe().ids.length, 0);
  headings = [{ textContent: 'fixture.mp4', getClientRects: () => [1] }]; assert.equal(probe().ids[0], 'FolderVideo123456');
  rows = [row, row]; assert.equal(probe().ids.length, 0);
  rows = [row]; headings[0].textContent = 'other.mp4'; assert.equal(probe().ids.length, 0);
});

async function backgroundFixture() {
  let listener, worker; const messages = [], sessionStorage = {}, localStorage = {}, keys = {}, ids = {};
  const events = {};
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const read = (store, input) => typeof input === 'string' ? { [input]: store[input] } : Array.isArray(input) ? Object.fromEntries(input.map(k => [k, store[k]])) : { ...input, ...store };
  const chrome = {
    runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, getManifest: () => ({ oauth2: { client_id: '123-test.apps.googleusercontent.com' } }),
      getContexts: async () => [{}], onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async m => {
        messages.push(m);
        if (m.type === 'STATUS') return { ok: true, active: worker };
        if (m.type === 'ANALYZE') { if (worker) return { error: 'busy' }; worker = { job: m.job, ownerType: m.ownerType, ownerId: m.ownerId }; }
        if (m.type === 'CANCEL' && worker?.job === m.job && worker?.ownerType === m.ownerType && worker?.ownerId === m.ownerId) worker = undefined;
        return { ok: true };
      } },
    storage: { session: { get: async input => read(sessionStorage, input), set: async value => Object.assign(sessionStorage, value) },
      local: { get: async input => read(localStorage, input), set: async value => Object.assign(localStorage, value), remove: async key => { delete localStorage[key]; } } },
    identity: { getAuthToken: async () => ({ token: 'synthetic', grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'] }), removeCachedAuthToken: async () => {} },
    tabs: { get: async tabId => ({ url: `https://drive.google.com/file/d/${ids[tabId]}/view` }), onRemoved: event('removed'),
      sendMessage: async (tabId, message) => {
        messages.push({ ...message, tabId });
        if (message.type === 'VIEW_STATUS') return { ok: true, key: keys[tabId], view: keys[tabId], fileId: ids[tabId] };
        if (message.key !== keys[tabId]) return { error: 'changed' };
        return { ok: true, running: true, duration: 180 };
      } },
    scripting: { executeScript: async ({ target }) => [{ frameId: 0, result: { ids: [ids[target.tabId]], media: { duration: 180 } } }] },
    webNavigation: { onBeforeNavigate: event('navigate'), onHistoryStateUpdated: event('history') },
  };
  globalThis.chrome = chrome;
  globalThis.fetch = async url => new Response(JSON.stringify({ id: /files\/([^?]+)/.exec(url)[1], version: '1', name: 'fixture.mp4', size: 100, mimeType: 'video/mp4', capabilities: { canDownload: true } }));
  await import(`../src/extension/background.js?test=${randomUUID()}`);
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  const invoke = async (message, sender) => {
    if (sender.url?.endsWith('/offscreen.html') && ['ANALYSIS_DONE', 'ANALYSIS_ERROR'].includes(message.type) && worker?.job === message.job) worker = undefined;
    const result = await new Promise(resolve => listener(message, { id: 'test', ...sender }, resolve));
    await flush(); return result;
  };
  const announce = tabId => {
    keys[tabId] = randomUUID(); ids[tabId] = `TestVideo123456${tabId}`;
    return invoke({ type: 'MEDIA_READY', key: keys[tabId], view: keys[tabId] }, { tab: { id: tabId, url: `https://drive.google.com/file/d/${ids[tabId]}/view` }, frameId: 0, documentId: `document-${tabId}`, url: `https://drive.google.com/file/d/${ids[tabId]}/view` });
  };
  return { announce, invoke, flush, messages, keys, ids, sessionStorage, localStorage, events, chrome, listener: () => listener };
}

test('一括画面は押した時点のフォルダーを新規/再利用に渡し、処理中は対象を変えない', async () => {
  const beforeChrome = globalThis.chrome, beforeFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(), opened = [], updated = [];
    let source = 'https://drive.google.com/drive/u/0/folders/FirstFolder12345';
    f.chrome.tabs.get = async id => ({ id, url: id === 1 ? source : 'chrome-extension://test/batch.html?folder=FirstFolder12345' });
    f.chrome.tabs.create = async options => { opened.push(options); return { id: 2 }; };
    f.chrome.tabs.update = async (id, options) => { updated.push({ id, ...options }); };
    const open = () => f.invoke({ type: 'OPEN_BATCH', tabId: 1 }, { url: 'chrome-extension://test/popup.html' });
    assert.equal((await open()).ok, true);
    assert.equal(opened[0].url, 'chrome-extension://test/batch.html?folder=FirstFolder12345');
    source = 'https://drive.google.com/drive/folders/SecondFolder12345';
    await open();
    assert.equal(opened.length, 1);
    assert.equal(updated.at(-1).url, 'chrome-extension://test/batch.html?folder=SecondFolder12345');
    for (const phase of ['checking', 'running']) {
      f.sessionStorage.batch = { ownerTabId: 2, phase, folder: { id: 'FirstFolder12345' } };
      await open(); assert.deepEqual(updated.at(-1), { id: 2, active: true });
      assert.equal(f.sessionStorage.batch.folder.id, 'FirstFolder12345');
    }
    f.sessionStorage.batch.phase = 'done';
    source = 'https://drive.google.com/drive/my-drive';
    await open(); assert.equal(updated.at(-1).url, 'chrome-extension://test/batch.html', '特定できない画面では古いフォルダーを初期入力しない');
  } finally { globalThis.chrome = beforeChrome; globalThis.fetch = beforeFetch; }
});

test('複数タブの解析を直列化し、中断したジョブの遅延結果を適用しない', async () => {
  const beforeChrome = globalThis.chrome, beforeFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(); await f.announce(1); await f.announce(2);
    const first = f.messages.find(m => m.type === 'ANALYZE');
    assert.equal(f.sessionStorage.sessions[1].phase, 'analyzing'); assert.equal(f.sessionStorage.sessions[2].phase, 'queued');
    await f.invoke({ type: 'STOP', tabId: 1 }, { url: 'chrome-extension://test/popup.html' });
    assert.equal(f.sessionStorage.sessions[2].phase, 'analyzing');
    await f.invoke({ ownerType: first.ownerType, ownerId: first.ownerId, type: 'ANALYSIS_DONE', job: first.job, result: { lufs: -21, peakDb: -18 } }, { url: 'chrome-extension://test/offscreen.html' });
    assert.equal(f.messages.filter(m => m.type === 'APPLY').length, 0);
    const second = f.messages.filter(m => m.type === 'ANALYZE').at(-1);
    await f.invoke({ ownerType: second.ownerType, ownerId: second.ownerId, type: 'ANALYSIS_DONE', job: second.job, result: { lufs: -21, peakDb: -18, windows: 8, bytes: 100 } }, { url: 'chrome-extension://test/offscreen.html' });
    assert.equal(f.sessionStorage.sessions[2].phase, 'playing');
    assert.deepEqual(f.messages.filter(m => m.type === 'APPLY').map(m => m.tabId), [2]);
    assert.ok(!JSON.stringify(f.sessionStorage).includes('synthetic')); assert.ok(!JSON.stringify(f.localStorage).includes('synthetic'));
    assert.equal(f.listener()({ type: 'CONNECT' }, { id: 'test', url: 'https://example.com' }, () => {}), undefined);
  } finally { globalThis.chrome = beforeChrome; globalThis.fetch = beforeFetch; }
});

test('OAuth/メタデータ待機中に別動画へ切り替わった場合は固定ゲインを適用しない', async () => {
  const beforeChrome = globalThis.chrome, beforeFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(), originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { f.keys[1] = randomUUID(); return originalFetch(...args); };
    await f.announce(1);
    assert.equal(f.messages.filter(m => m.type === 'APPLY').length, 0);
    assert.equal(f.sessionStorage.sessions[1].phase, 'error');
  } finally { globalThis.chrome = beforeChrome; globalThis.fetch = beforeFetch; }
});

test('Driveの内部版だけが変わっても再利用し、動画内容の版/サイズ更新は見逃さない', async () => {
  const oldFetch = globalThis.fetch;
  try {
    let file = { id: 'TestVideo123456789', name: 'fixture.mp4', size: '100', version: '1', headRevisionId: 'revision-one', mimeType: 'video/mp4', capabilities: { canDownload: true } };
    globalThis.fetch = async () => new Response(JSON.stringify(file));
    const first = await metadata(file.id, 'synthetic');
    file.version = '2'; const viewed = await metadata(file.id, 'synthetic');
    assert.equal(cacheKey(first), cacheKey(viewed));
    file.headRevisionId = 'revision-two'; assert.notEqual(cacheKey(first), cacheKey(await metadata(file.id, 'synthetic')));
    delete file.headRevisionId; file.md5Checksum = 'a'.repeat(32);
    const checksum = await metadata(file.id, 'synthetic'); file.version = '3';
    assert.equal(checksum.version, (await metadata(file.id, 'synthetic')).version);
    file.size = '101'; assert.notEqual(checksum.version, (await metadata(file.id, 'synthetic')).version);
    delete file.md5Checksum; assert.equal((await metadata(file.id, 'synthetic')).version, '3');
  } finally { globalThis.fetch = oldFetch; }
});

test('接続済み要素でもcross-originソースへ変われば再適用を拒否する', () => {
  const oldLocation = globalThis.location;
  try {
    globalThis.location = { href: 'https://drive.google.com/view', origin: 'https://drive.google.com' };
    const audio = new PlayerAudio(), video = { currentSrc: 'blob:https://drive.google.com/fixture' };
    const graph = {}; audio.nodes.set(video, graph); assert.equal(audio.graph(video), graph);
    video.currentSrc = 'https://other.example/video.mp4';
    assert.throws(() => audio.graph(video), /この配信形式/);
  } finally {
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

test('401ではトークンを一度だけ更新し、再試行しても失敗なら停止する', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  try {
    const removed = [], sent = [];
    globalThis.chrome = { runtime: { getManifest: () => ({ oauth2: { client_id: '123-test.apps.googleusercontent.com' } }) },
      identity: { removeCachedAuthToken: async ({ token }) => removed.push(token),
        getAuthToken: async () => ({ token: 'fresh-synthetic', grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'] }) } };
    const file = { id: 'TestVideo123456789', version: '1', size: '100', name: 'fixture.mp4', mimeType: 'video/mp4', capabilities: { canDownload: true } };
    globalThis.fetch = async (_, init) => {
      sent.push(init.headers.Authorization);
      return sent.length === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify(file));
    };
    assert.equal((await metadata(file.id, 'old-synthetic')).id, file.id);
    assert.deepEqual(sent, ['Bearer old-synthetic', 'Bearer fresh-synthetic']); assert.deepEqual(removed, ['old-synthetic']);
    sent.length = 0; removed.length = 0;
    globalThis.fetch = async () => { sent.push('request'); return new Response('', { status: 401 }); };
    await assert.rejects(metadata(file.id, 'old-synthetic'), /期限切れ/);
    assert.equal(sent.length, 2); assert.deepEqual(removed, ['old-synthetic', 'fresh-synthetic']);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});

test('解析ページが残っていても期限を過ぎたジョブを終了し、次の動画を解析する', async () => {
  const beforeChrome = globalThis.chrome, beforeFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(); await f.announce(1);
    const oldJob = f.sessionStorage.sessions[1].job;
    f.sessionStorage.sessions[1].analysisStartedAt = Date.now() - 70_000;
    f.sessionStorage.activeAnalysis.startedAt = Date.now() - 70_000;
    await f.announce(2);
    const response = await f.invoke({ type: 'GET_STATE', tabId: 1 }, { url: 'chrome-extension://test/popup.html' });
    assert.equal(response.state.phase, 'error');
    assert.match(response.state.message, /時間の上限/);
    assert.equal(f.sessionStorage.sessions[2].phase, 'analyzing');
    assert.ok(f.messages.some(m => m.type === 'CANCEL'));
    await f.invoke({ type: 'ANALYSIS_DONE', job: oldJob, result: { lufs: -21, peakDb: -18 } }, { url: 'chrome-extension://test/offscreen.html' });
    assert.equal(f.sessionStorage.sessions[2].phase, 'analyzing');
    assert.equal(f.messages.filter(m => m.type === 'APPLY').length, 0);
  } finally { globalThis.chrome = beforeChrome; globalThis.fetch = beforeFetch; }
});

const batchSender = { url: 'chrome-extension://test/batch.html', tab: { id: 99 } };
const batchRoot = 'BatchFolder123456';
function mockBatchDrive(items) {
  globalThis.fetch = async url => {
    const parsed = new URL(url), id = /\/files\/([^/]+)/.exec(parsed.pathname)?.[1];
    if (!id) return new Response(JSON.stringify({ files: items }));
    if (id === batchRoot) return new Response(JSON.stringify({ id, name: 'Batch', mimeType: 'application/vnd.google-apps.folder' }));
    return new Response(JSON.stringify({ id, name: id + '.mp4', version: '1', size: 100, mimeType: 'video/mp4', capabilities: { canDownload: true } }));
  };
}
const batchFile = id => ({ id, name: id + '.mp4', mimeType: 'video/mp4' });
async function startBatch(f, items) {
  mockBatchDrive(items);
  assert((await f.invoke({ type: 'BATCH_CHECK', folder: batchRoot }, batchSender)).ok);
  assert.equal(f.sessionStorage.batch.phase, 'ready');
  const runId = f.sessionStorage.batch.runId;
  assert((await f.invoke({ type: 'BATCH_START', runId }, batchSender)).ok);
  return runId;
}
async function finishWorker(f, type = 'ANALYSIS_DONE', extra = {}) {
  const active = f.sessionStorage.activeAnalysis;
  return f.invoke({ type, job: active.jobId, ownerType: active.ownerType, ownerId: active.ownerId,
    result: { lufs: -21, peakDb: -18, windows: 13, bytes: 100 }, ...extra }, { url: 'chrome-extension://test/offscreen.html' });
}

test('一括の新規/再利用/失敗件数を分離し、再実行と通常プレビューで結果を共有する', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture();
    const cached = { id: 'CachedVideo12345', version: '1' };
    f.localStorage.cache = { [cacheKey(cached)]: { result: { lufs: -20 }, measuredAt: 1 } };
    await startBatch(f, [batchFile(cached.id), batchFile('FreshVideo123456'), batchFile('Unsupported12345')]);
    assert.equal(f.sessionStorage.activeAnalysis.file.id, 'FreshVideo123456');
    await finishWorker(f); await finishWorker(f, 'ANALYSIS_ERROR', { error: '非対応のコーデックです。', code: 'FORMAT' });
    const state = f.sessionStorage.batch;
    assert.equal(state.phase, 'done'); assert.equal(state.analyzed, 1); assert.equal(state.cached, 1); assert.equal(state.failed, 1); assert.equal(state.pending, 0);
    assert.equal(f.messages.filter(x => x.type === 'APPLY').length, 0);
    await startBatch(f, [batchFile(cached.id), batchFile('FreshVideo123456')]);
    assert.equal(f.sessionStorage.batch.phase, 'done'); assert.equal(f.sessionStorage.batch.cached, 2);
    assert(!JSON.stringify(f.sessionStorage).includes('synthetic')); assert(!JSON.stringify(f.localStorage).includes('synthetic'));
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});
test('一括Worker稼働中も保存済みプレビューを適用し、プレビューSTOPは一括を中止しない', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(); await startBatch(f, [batchFile('FreshVideo123456')]);
    const job = f.sessionStorage.activeAnalysis.jobId;
    f.localStorage.cache = { [cacheKey({ id: 'TestVideo1234561', version: '1' })]: { result: { lufs: -21 }, measuredAt: 1 } };
    await f.announce(1); assert.equal(f.sessionStorage.sessions[1].phase, 'playing'); assert(f.sessionStorage.sessions[1].cached);
    await f.invoke({ type: 'STOP', tabId: 1 }, { url: 'chrome-extension://test/popup.html' });
    assert.equal(f.sessionStorage.activeAnalysis.jobId, job);
    await finishWorker(f); assert.equal(f.sessionStorage.batch.phase, 'done');
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});
test('一括の1件が終わると通常プレビューを優先し、一括中止はそのプレビューを止めない', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(); const runId = await startBatch(f, [batchFile('FirstVideo123456'), batchFile('SecondVideo12345')]);
    await f.announce(1); assert.equal(f.sessionStorage.sessions[1].phase, 'queued');
    await finishWorker(f); assert.equal(f.sessionStorage.activeAnalysis.ownerType, 'preview');
    const job = f.sessionStorage.activeAnalysis.jobId;
    await f.invoke({ type: 'BATCH_CANCEL', runId }, batchSender);
    assert.equal(f.sessionStorage.activeAnalysis.jobId, job);
    await finishWorker(f); assert.equal(f.sessionStorage.sessions[1].phase, 'playing'); assert.equal(f.sessionStorage.batch.phase, 'cancelled');
    assert.equal(f.sessionStorage.batch.pending, 1);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});
test('一覧通信を待っていても中止を処理し、遅い応答で中止状態を上書きしない', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch; let resolveList;
  try {
    const f = await backgroundFixture();
    globalThis.fetch = async url => new URL(url).pathname.endsWith('/' + batchRoot) ? new Response(JSON.stringify({ id: batchRoot, name: 'Batch', mimeType: 'application/vnd.google-apps.folder' })) : new Promise(resolve => { resolveList = resolve; });
    await f.invoke({ type: 'BATCH_CHECK', folder: batchRoot }, batchSender);
    assert.equal(f.sessionStorage.batch.phase, 'checking');
    await f.invoke({ type: 'BATCH_CANCEL', runId: f.sessionStorage.batch.runId }, batchSender);
    assert.equal(f.sessionStorage.batch.phase, 'cancelled');
    resolveList(new Response(JSON.stringify({ files: [batchFile('TooLateVideo1234')] }))); await f.flush();
    assert.equal(f.sessionStorage.batch.phase, 'cancelled'); assert.equal(f.sessionStorage.batchItems.length, 0);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});
test('一括期限通知は所有者/job/時刻を照合し、次のファイルへ進む', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(); const runId = await startBatch(f, [batchFile('FirstVideo123456'), batchFile('SecondVideo12345')]);
    const job = f.sessionStorage.activeAnalysis.jobId;
    await f.invoke({ type: 'BATCH_TIMEOUT', runId, job }, batchSender); assert.equal(f.sessionStorage.activeAnalysis.jobId, job);
    f.sessionStorage.activeAnalysis.startedAt = Date.now() - 70_000;
    await f.invoke({ type: 'BATCH_TIMEOUT', runId, job: 'wrong' }, batchSender); assert.equal(f.sessionStorage.activeAnalysis.jobId, job);
    await f.invoke({ type: 'BATCH_TIMEOUT', runId, job }, batchSender);
    assert.equal(f.sessionStorage.batch.failed, 1); assert.equal(f.sessionStorage.activeAnalysis.file.id, 'SecondVideo12345');
    await finishWorker(f); assert.equal(f.sessionStorage.batch.phase, 'done');
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});
test('一括の認証失敗は一度だけ更新して再試行し、再失敗で残りを中断する', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(); await startBatch(f, [batchFile('FirstVideo123456'), batchFile('SecondVideo12345')]);
    await finishWorker(f, 'ANALYSIS_ERROR', { error: '期限切れ', code: 'AUTH' }); assert(f.sessionStorage.activeAnalysis.authRetried);
    assert.equal(f.messages.filter(x => x.type === 'ANALYZE').length, 2);
    await finishWorker(f, 'ANALYSIS_ERROR', { error: '期限切れ', code: 'AUTH' });
    assert.equal(f.sessionStorage.batch.phase, 'error'); assert.equal(f.sessionStorage.batch.failed, 1); assert.equal(f.sessionStorage.batch.pending, 1);
    assert.equal(f.sessionStorage.activeAnalysis, null);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});

test('Service Workerのメモリを作り直しても保存済みの所有権を引き継ぎ、一括解析を続行する', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(); await startBatch(f, [batchFile('FirstVideo123456'), batchFile('SecondVideo12345')]);
    const job = f.sessionStorage.activeAnalysis.jobId;
    await import(`../src/extension/background.js?restart=${randomUUID()}`);
    await f.invoke({ type: 'BATCH_STATE' }, batchSender);
    assert.equal(f.sessionStorage.activeAnalysis.jobId, job);
    await finishWorker(f); assert.equal(f.sessionStorage.batch.analyzed, 1);
    assert.equal(f.sessionStorage.activeAnalysis.file.id, 'SecondVideo12345');
    await finishWorker(f); assert.equal(f.sessionStorage.batch.phase, 'done'); assert.equal(f.sessionStorage.batch.analyzed, 2);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});
test('offscreenが消失した一括ジョブを回収し、次のファイルへ進む', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture(); await startBatch(f, [batchFile('FirstVideo123456'), batchFile('SecondVideo12345')]);
    let missing = true;
    f.chrome.runtime.getContexts = async () => { if (missing) { missing = false; return []; } return [{}]; };
    await f.invoke({ type: 'BATCH_STATE' }, batchSender);
    assert.equal(f.sessionStorage.batch.failed, 1); assert.equal(f.sessionStorage.activeAnalysis.file.id, 'SecondVideo12345');
    await finishWorker(f); assert.equal(f.sessionStorage.batch.phase, 'done');
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});

const microtasks = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
test('retryが上限まで続いてもpendingのミュート/停止を残さない', async () => {
  const f = contentFixture({ paused: true, readyReply: { ok: true, retry: true } });
  vm.runInNewContext(contentSource, f.sandbox);
  for (let i = 0; i < 21; i++) {
    await microtasks();
    const next = [...f.timers.entries()].find(([, t]) => t.ms === 500);
    if (next) { f.timers.delete(next[0]); next[1].fn(); }
  }
  await microtasks(); assert.equal(f.node.muted, false);
  await f.node.play(); assert.equal(f.node.paused, false);
});
test('所有権ACK後のキュー待ちに10秒期限を適用せず、Worker開始後だけ65秒を測る', async () => {
  const f = contentFixture({ paused: true }); vm.runInNewContext(contentSource, f.sandbox);
  const oldDeadline = [...f.timers.values()].find(t => t.ms === 10_000);
  await microtasks(); assert.equal([...f.timers.values()].some(t => t.ms === 10_000), false);
  oldDeadline.fn(); assert.equal(f.node.muted, true, '解除済みの登録期限が遅れて届いてもキュー待ちを中止しない');
  assert.equal([...f.timers.values()].some(t => t.ms === 65_000), false);
  const key = f.sent.find(m => m.type === 'MEDIA_READY').key;
  f.call({ type: 'ANALYSIS_START', key, job: randomUUID() });
  assert.equal([...f.timers.values()].some(t => t.ms === 65_000), true);
});
test('先読みの子は親との照合前に停止せず、別世代のACK/STOPを受け付けない', async () => {
  const f = contentFixture({ embedded: true }); vm.runInNewContext(contentSource, f.sandbox);
  assert.equal(f.node.muted, false); assert.equal(f.node.paused, false); assert.equal(f.sent.length, 0);
  const view = randomUUID(), dispatch = f.dispatchParent;
  dispatch({ type: 'PROBE', view }); const first = f.upstream.at(-1);
  assert.equal(f.node.muted, false);
  dispatch({ type: 'ACK', view: randomUUID(), key: first.key }); assert.equal(f.node.paused, false);
  dispatch({ type: 'ACK', view, key: first.key }); assert.equal(f.node.muted, true); assert.equal(f.node.paused, true);
  dispatch({ type: 'STOP', view: randomUUID(), key: first.key }); assert.equal(f.node.muted, true);
  dispatch({ type: 'REVOKE', view, key: first.key }); assert.equal(f.node.muted, false);
  const nextView = randomUUID(); dispatch({ type: 'PROBE', view: nextView }); const next = f.upstream.at(-1);
  assert.notEqual(next.key, first.key);
  dispatch({ type: 'ACK', view: nextView, key: next.key });
  dispatch({ type: 'STOP', view, key: first.key }); assert.equal(f.node.muted, true);
});
test('重複loadstartで拡張自身のミュートを元の値にせず、解除を繰り返せる', () => {
  const f = contentFixture({ paused: true }); vm.runInNewContext(contentSource, f.sandbox);
  const key = f.sent.find(m => m.type === 'MEDIA_READY').key;
  for (let i = 0; i < 3; i++) f.events.get('loadstart')({ target: f.node });
  assert.equal(f.sent.filter(m => m.type === 'MEDIA_READY').length, 1);
  f.call({ type: 'RESTORE', key }); assert.equal(f.node.muted, false);
  f.node.muted = true; f.node.volume = .7;
  f.call({ type: 'RESTORE', key }); assert.equal(f.node.muted, true); assert.equal(f.node.volume, .7);
});
test('未接続のAudioContext起動失敗は原音経路を残し、既接続のclosedも失敗を通知する', async () => {
  const before = globalThis.AudioContext, beforeLocation = globalThis.location;
  let connections = 0;
  try {
    globalThis.location = { href: 'https://drive.google.com/view', origin: 'https://drive.google.com' };
    globalThis.AudioContext = class { state = 'suspended'; resume() { return Promise.reject(new Error('blocked')); } createMediaElementSource() { connections++; } };
    const audio = new PlayerAudio(), node = { src: 'blob:https://drive.google.com/test' };
    await assert.rejects(audio.resume(), /blocked/); assert.equal(connections, 0);
    assert.throws(() => audio.apply(node, 1, 1), /音声を開始/); assert.equal(connections, 0);
    audio.nodes.set(node, {}); audio.context.state = 'closed';
    await assert.rejects(audio.resume(), /終了/); assert.equal(connections, 0);
  } finally { if (before === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = before; if (beforeLocation === undefined) delete globalThis.location; else globalThis.location = beforeLocation; }
});
test('表示対象は親の非表示属性/viewportを確認し、2候補なら選ばない', () => {
  const before = { document: globalThis.document, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle };
  const make = () => ({ isConnected: true, nodeType: 1, tagName: 'IFRAME', src: 'https://youtube.googleapis.com/embed/?ps=docs&origin=https%3A%2F%2Fdrive.google.com', style: {}, getAttribute() { return null; }, rect: { width: 300, height: 200, left: 10, right: 310, top: 10, bottom: 210 }, getBoundingClientRect() { return this.rect; } });
  try {
    globalThis.window = { innerWidth: 800, innerHeight: 600 }; globalThis.getComputedStyle = n => ({ display: 'block', visibility: 'visible', opacity: '1', ...n.style });
    const first = make(), second = make(); second.hidden = true;
    globalThis.document = { querySelectorAll: selector => selector === '[role="dialog"]' ? [] : [first, second] };
    assert.equal(visiblePlayers().length, 1);
    first.style.visibility = 'hidden'; assert.equal(visiblePlayers().length, 0);
    first.style.visibility = 'visible'; first.rect.left = 900; assert.equal(visibleElement(first), false);
    first.rect.left = 10; second.hidden = false; assert.equal(visiblePlayers().length, 2, '呼出側は厳密に1件の時だけ選択する');
    first.tagName = 'VIDEO'; first.getAttribute = name => name === 'aria-hidden' ? 'true' : null;
    assert.equal(visibleElement(first), true, 'Driveのvideoはaria-hiddenでも標準操作UIで表示/再生される');
    first.parentElement = { nodeType: 1, hidden: true, style: {}, getAttribute() { return null; } }; assert.equal(visibleElement(first), false);
  } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('設定画面のGET_STATEは動画タブなしでも設定を返す', async () => {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  try {
    const f = await backgroundFixture();
    Object.assign(f.localStorage, { target: -14, volume: 0.1 });
    const response = await f.invoke({ type: 'GET_STATE' }, { url: 'chrome-extension://test/options.html' });
    assert.equal(response.settings.target, -23); assert.equal(response.settings.volume, 1); assert.equal(response.state.phase, 'idle');
    const changed = await f.invoke({ type: 'SETTINGS', target: -14, volume: 0.1 }, { url: 'chrome-extension://test/options.html' });
    assert(changed.error, '旧UIから目標値/試聴音量を変更しない');
    assert.equal(f.localStorage.target, -14); assert.equal(f.localStorage.volume, 0.1, '旧設定データは削除せず適用対象から外す');
    assert(!f.messages.some(m => m.type === 'VIEW_STATUS'));
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});

test('登録前のSTOPと特定期限切れを親の状態にも反映し、再開操作を選べる', () => {
  for (const stop of [true, false]) {
    const f = contentFixture({ paused: true });
    f.sandbox.chrome.runtime.sendMessage = message => { f.sent.push(message); return new Promise(() => {}); };
    vm.runInNewContext(contentSource, f.sandbox);
    const view = f.call({ type: 'VIEW_STATUS' });
    if (stop) f.call({ type: 'STOP_VIEW', key: view.key, view: view.view });
    else [...f.timers.values()].find(t => t.ms === 10_000).fn();
    assert.equal(f.call({ type: 'VIEW_STATUS' }).phase, stop ? 'stopped' : 'error');
    assert.equal(f.node.muted, false);
  }
});

test('補正中にユーザーが音量を変更して1へ戻した場合も停止時に維持する', () => {
  const f = contentFixture({ paused: true }); vm.runInNewContext(contentSource, f.sandbox);
  const key = f.sent.find(m => m.type === 'MEDIA_READY').key;
  f.call({ type: 'APPLY', key, gain: .8, volume: .5, label: '−1.9 dB' });
  f.node.volume = .7; f.events.get('volumechange')({ target: f.node });
  f.node.volume = 1; f.events.get('volumechange')({ target: f.node });
  f.call({ type: 'RESTORE', key }); assert.equal(f.node.volume, 1);
});

test('子フレーム内部のvideoが画面外に配置されていても、親に選ばれた動画を登録する', () => {
  const f = contentFixture({ embedded: true, paused: true }); f.sandbox.visibleElement = () => false;
  vm.runInNewContext(contentSource, f.sandbox);
  f.dispatchParent({ type: 'PROBE', view: randomUUID() });
  assert.equal(f.upstream.at(-1)?.type, 'READY');
  assert.equal(f.node.muted, false, '親のACK前は再生を抑止しない');
});

test('Driveが再生前の動画情報をまだ読み込まない場合は停止も登録期限も始めない', () => {
  const f = contentFixture({ embedded: true, paused: true }); f.node.readyState = 0; f.node.duration = NaN;
  vm.runInNewContext(contentSource, f.sandbox);
  const view = randomUUID(), dispatch = f.dispatchParent;
  dispatch({ type: 'PROBE', view }); const key = f.upstream.at(-1).key;
  dispatch({ type: 'ACK', view, key });
  assert.equal(f.node.muted, false); assert.equal([...f.timers.values()].some(t => t.ms === 10_000), false);
  f.node.readyState = 4; f.node.duration = 180; dispatch({ type: 'ACK', view, key });
  assert.equal(f.node.muted, true); assert.equal([...f.timers.values()].some(t => t.ms === 10_000), true);
});
