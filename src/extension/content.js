import { PlayerAudio } from './player-audio.js';
import { probeFrame } from './drive.js';
import { visibleElement, visiblePlayers, playerFrame } from './view.js';

(() => {
  const url = new URL(location.href), top = window === window.top;
  if (url.hostname === 'youtube.googleapis.com' && (url.pathname !== '/embed/' ||
      url.searchParams.get('ps') !== 'docs' || url.searchParams.get('origin') !== 'https://drive.google.com')) return;
  const audio = new PlayerAudio(), channel = 'drive-loudness-view';
  const links = new WeakMap(), pendingLinks = new WeakMap();
  let bridge;
  let current, selection, timer, notice, noticeTimer;
  const validKey = value => /^[a-f0-9-]{36}$/.test(value ?? '');
  const send = message => chrome.runtime.sendMessage(message).catch(() => null);
  const pause = state => { if (!state.node.paused) { state.internalPauses++; state.node.pause(); } };
  function show(text, error = false) {
    clearTimeout(noticeTimer); notice?.remove();
    notice = document.createElement('div');
    notice.setAttribute('data-drive-loudness-notice', ''); notice.setAttribute('role', error ? 'alert' : 'status');
    notice.style.cssText = 'position:fixed;right:20px;bottom:72px;z-index:2147483647;pointer-events:none;padding:7px 11px;border-radius:7px;background:#142820ed;color:#e8f5ef;font:13px/1.4 system-ui;box-shadow:0 2px 10px #0004;max-width:320px;';
    notice.textContent = text;
    (document.fullscreenElement ?? document.body ?? document.documentElement).append(notice);
    noticeTimer = setTimeout(() => { notice?.remove(); notice = undefined; }, error ? 6000 : 3000);
  }
  function clearWaits(state) {
    for (const name of ['deadline', 'claimDeadline', 'retryTimer', 'audioDeadline']) { clearTimeout(state[name]); state[name] = undefined; }
  }
  function release(state, stop = true) {
    clearWaits(state);
    if (state.controlled) {
      if (stop) pause(state);
      audio.bypass(state.node);
      if (state.node.volume === 1 && state.setVolume && !state.userVolumeTouched) state.node.volume = state.volume;
      if (state.node.muted === state.writtenMuted) state.node.muted = state.muted;
    }
    state.controlled = false; state.phase = 'stopped'; state.requested = false;
    clearTimeout(noticeTimer); notice?.remove(); notice = undefined;
  }
  function fail(state, reason, stop = true) {
    if (state !== current) return;
    release(state, stop); state.phase = 'error'; state.error = reason;
    show(`未補正 · ${reason}`, true);
    send({ type: 'MEDIA_ERROR', key: state.key, view: state.view, error: reason });
  }
  function activate(state) {
    if (current !== state || state.phase !== 'waiting' || audio.context?.state !== 'running') return;
    try {
      audio.apply(state.node, state.gain, state.master);
      state.volume = state.node.volume; state.node.volume = 1; state.setVolume = true;
      state.writtenMuted = state.muted; state.node.muted = state.muted;
      clearTimeout(state.audioDeadline); state.audioDeadline = undefined;
      state.phase = 'playing';
      if (!state.notified) { state.notified = true; if (top) show(state.label); }
      send({ type: 'AUDIO_ACTIVE', key: state.key, view: state.view });
      if (state.requested) { state.requested = false; state.node.play().catch(() => {}); }
    } catch (error) { fail(state, error.message); }
  }
  function wake() {
    const state = current;
    if (!state || !['waiting', 'stopped', 'error'].includes(state.phase)) return;
    // 接続前は再開不能でもネイティブ音声を残す。接続後は等倍経路を再開する。
    if (state.phase !== 'waiting' && !audio.nodes.has(state.node)) return;
    if (state.phase === 'waiting' && !state.requested && !audio.context) return;
    if (state.phase === 'waiting' && state.requested && !state.audioDeadline) {
      state.audioDeadline = setTimeout(() => {
        if (current === state && state.phase === 'waiting') fail(state, audio.nodes.has(state.node) ? '音声を再開できません。ページを再読み込みしてください。' : '音声補正を開始できません。原音で再生できます。', false);
      }, 1000);
    }
    audio.resume().then(() => {
      if (current !== state) return;
      if (state.phase === 'waiting') activate(state);
    }).catch(() => {
      if (current === state) fail(state, audio.nodes.has(state.node) ? '音声を再開できません。ページを再読み込みしてください。' : '音声補正を開始できません。原音で再生できます。', false);
    });
  }
  function announce(state) {
    if (current !== state || state.announced || state.phase !== 'pending' || state.node.readyState < 1 ||
        !Number.isFinite(state.node.duration) || state.node.duration <= 0) return;
    state.announced = true;
    send({ type: 'MEDIA_READY', key: state.key, view: state.view }).then(response => {
      if (current !== state || state.phase !== 'pending') return;
      if (response?.accepted) { state.registered = true; clearTimeout(state.claimDeadline); state.claimDeadline = undefined; }
      else if (response?.retry && state.retries++ < 20) {
        state.retryTimer = setTimeout(() => { state.announced = false; announce(state); }, 500);
      } else fail(state, response?.error ?? '表示中の動画を特定できません。原音で再生できます。');
    });
  }
  function hold(state, view) {
    if (current !== state || state.phase !== 'candidate' || state.node.readyState < 1 ||
        !Number.isFinite(state.node.duration) || state.node.duration <= 0) return;
    state.view = view; state.phase = 'pending'; state.controlled = true;
    state.volume = state.node.volume; state.muted = state.node.muted; state.writtenMuted = true;
    state.requested = !state.node.paused;
    // 応答promiseやWorker開始を待たず、ミュートする前に期限を設ける。
    state.claimDeadline = setTimeout(() => {
      if (current === state && state.phase === 'pending' && !state.registered)
        fail(state, '表示中の動画を確認できません。原音で再生できます。');
    }, 10_000);
    state.node.muted = true; pause(state); announce(state);
  }
  function candidate(node) {
    if (current) {
      const old = current; release(old); send({ type: 'MEDIA_GONE', key: old.key, view: old.view });
    }
    current = { node, key: crypto.randomUUID(), source: node.currentSrc || node.src, phase: 'candidate', retries: 0, internalPauses: 0 };
    return current;
  }
  function post(node, message) {
    const link = links.get(node);
    if (node.isConnected && playerFrame(node) && link?.src === node.src) link.port.postMessage({ channel, ...message });
  }
  function connect() {
    if (top || bridge?.connected || (bridge && Date.now() < bridge.retryAt)) return;
    const origin = location.ancestorOrigins?.[0];
    if (!['https://drive.google.com', 'https://docs.google.com'].includes(origin)) return;
    bridge?.port.close();
    const { port1, port2 } = new MessageChannel(), id = crypto.randomUUID();
    const link = bridge = { port: port1, id, retryAt: Date.now() + 1000 };
    port1.onmessage = event => {
      if (bridge !== link || event.data?.channel !== channel) return;
      if (event.data.type === 'CONNECTED' && event.data.id === id) port1.postMessage({ channel, type: 'CONFIRMED', id });
      else if (event.data.type === 'ACCEPTED' && event.data.id === id) link.connected = true;
      else childMessage(event.data);
    };
    port1.start();
    // 子の準備完了後に親へ接続する。親から遷移中のWindowProxyへは送信しない。
    window.parent.postMessage({ channel, type: 'CONNECT', id }, origin, [port2]);
  }
  function childMessage(message) {
    if (!validKey(message.view)) return;
    const state = current;
    if (!state) return;
    const reply = () => bridge.port.postMessage({ channel, type: 'READY', view: current.view, key: current.key, phase: current.phase, error: current.error });
    if (message.type === 'PROBE') {
      if (state.view && state.view !== message.view) candidate(state.node);
      current.view = message.view; reply();
    } else if (message.view === state.view && message.key === state.key) {
      if (message.type === 'ACK') hold(state, message.view);
      else if (['REVOKE', 'STOP'].includes(message.type)) release(state);
      else if (message.type === 'RETRY') { candidate(state.node).view = message.view; reply(); }
    }
  }
  function inspectView() {
    if (!top) return;
    const nodes = visiblePlayers(), ids = probeFrame().ids;
    const node = nodes.length === 1 && ids.length === 1 ? nodes[0] : null;
    if (selection && (selection.node !== node || selection.fileId !== ids[0] || selection.src !== (node?.tagName === 'IFRAME' ? node.src : undefined) || selection.link !== (node?.tagName === 'IFRAME' ? links.get(node) : undefined))) {
      const old = selection; selection = undefined;
      clearTimeout(noticeTimer); notice?.remove(); notice = undefined;
      if (old.node.tagName === 'IFRAME') post(old.node, { type: 'REVOKE', view: old.view, key: old.key });
      else if (current?.view === old.view) release(current);
      send({ type: 'VIEW_CHANGED' });
    }
    if (!node) return;
    selection ??= { node, src: node.tagName === 'IFRAME' ? node.src : undefined, link: node.tagName === 'IFRAME' ? links.get(node) : undefined, fileId: ids[0], view: crypto.randomUUID() };
    if (node.tagName === 'IFRAME') post(node, { type: 'PROBE', view: selection.view });
    else if (current?.node === node) {
      if (selection.key !== current.key) { selection.key = current.key; send({ type: 'VIEW_CHANGED' }); }
      hold(current, selection.view);
    }
  }
  function inspect() {
    clearTimeout(timer); timer = undefined;
    // Driveは子videoを一時的に画面外へ置く。子の表示可否は親iframeの照合で決める。
    const nodes = [...document.querySelectorAll('video')].filter(node => top ? visibleElement(node) : node.isConnected);
    const node = nodes.length === 1 ? nodes[0] : null;
    if (current && (!current.node.isConnected || current.node !== node)) {
      const old = current; release(old); current = undefined; send({ type: 'MEDIA_GONE', key: old.key, view: old.view });
    }
    if (node) {
      const source = node.currentSrc || node.src;
      if (!current || (source && current.source && source !== current.source)) candidate(node);
      else { if (source) current.source = source; announce(current); }
    }
    inspectView(); connect();
  }
  const schedule = () => { timer ??= setTimeout(inspect, 100); };
  new MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'src'] });
  document.addEventListener('load', event => {
    if (top && event.target.tagName === 'IFRAME' && playerFrame(event.target)) schedule();
  }, true);
  setInterval(inspect, 500);
  for (const event of ['loadedmetadata', 'durationchange', 'loadstart']) document.addEventListener(event, eventObject => {
    if (eventObject.target instanceof HTMLVideoElement) inspect();
  }, true);
  window.addEventListener('message', event => {
    const message = event.data, port = event.ports?.[0];
    if (!top || message?.channel !== channel || message.type !== 'CONNECT' || !validKey(message.id) || !port) return;
    const node = [...document.querySelectorAll('iframe[src]')].find(node => playerFrame(node) &&
      node.contentWindow === event.source && new URL(node.src).origin === event.origin);
    if (!node) { port.close(); return; }
    const previous = pendingLinks.get(node);
    if (previous) { previous.expired = true; clearTimeout(previous.deadline); previous.port.close(); }
    const link = { port, src: node.src, id: message.id }; pendingLinks.set(node, link);
    link.deadline = setTimeout(() => {
      if (pendingLinks.get(node) === link) { pendingLinks.delete(node); link.expired = true; port.close(); }
    }, 2000);
    port.onmessage = event => {
      const message = event.data, view = selection;
      if (link.expired || !node.isConnected || node.src !== link.src || !playerFrame(node) || message?.channel !== channel) return;
      if (message.type === 'CONFIRMED' && message.id === link.id) {
        if (link.confirmed || pendingLinks.get(node) !== link) return;
        clearTimeout(link.deadline); pendingLinks.delete(node); link.confirmed = true;
        links.get(node)?.port.close(); links.set(node, link);
        port.postMessage({ channel, type: 'ACCEPTED', id: link.id }); inspectView(); return;
      }
      if (links.get(node) !== link || node.src !== link.src || !node.isConnected || !playerFrame(node) ||
          !view || view.node !== node || message?.channel !== channel || message.type !== 'READY' ||
          message.view !== view.view || !validKey(message.key) || !visibleElement(node)) return;
      if (view.key !== message.key) { view.key = message.key; view.stopped = false; send({ type: 'VIEW_CHANGED' }); }
      view.phase = ['candidate', 'pending', 'waiting', 'playing', 'stopped', 'error'].includes(message.phase) ? message.phase : 'candidate';
      view.error = typeof message.error === 'string' && message.error.length < 250 ? message.error : undefined;
      post(node, { type: 'ACK', view: view.view, key: view.key });
    };
    port.start(); port.postMessage({ channel, type: 'CONNECTED', id: message.id });
  });
  document.addEventListener('play', event => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    inspect();
    const state = current;
    if (!state || state.node !== event.target) return;
    if (state.phase === 'pending') { state.requested = true; pause(state); }
    else if (state.phase === 'waiting') { state.requested = true; wake(); }
    else if (['stopped', 'error'].includes(state.phase)) wake();
  }, true);
  document.addEventListener('pause', event => {
    if (current?.node !== event.target) return;
    if (current.internalPauses) current.internalPauses--;
    else current.requested = false;
  }, true);
  document.addEventListener('volumechange', event => {
    const state = current;
    if (!state?.controlled || event.target !== state.node) return;
    if (state.setVolume && state.node.volume !== 1) state.userVolumeTouched = true;
    if (state.phase === 'pending' && state.node.muted !== state.writtenMuted) {
      state.muted = state.node.muted; state.node.muted = true;
    } else if (state.phase === 'waiting' && !state.setVolume) {
      state.muted = state.node.muted; state.writtenMuted = state.muted;
    }
  }, true);
  for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, eventObject => { if (eventObject.isTrusted) wake(); }, true);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (top && ['VIEW_STATUS', 'STOP_VIEW', 'RETRY_VIEW'].includes(message.type)) {
      inspectView(); const view = selection;
      if (!view || !view.key) { respond({ error: '表示中の動画を確認しています。' }); return; }
      if (message.type !== 'VIEW_STATUS') {
        if (message.view !== view.view || message.key !== view.key) { respond({ error: '表示中の動画が変わりました。' }); return; }
        if (message.type === 'STOP_VIEW') {
          view.stopped = true;
          if (view.node.tagName === 'IFRAME') post(view.node, { type: 'STOP', view: view.view, key: view.key });
          else if (current?.key === view.key) release(current);
        } else {
          view.stopped = false;
          if (view.node.tagName === 'IFRAME') post(view.node, { type: 'RETRY', view: view.view, key: view.key });
          else { candidate(view.node); inspectView(); }
        }
      }
      const local = view.node.tagName === 'VIDEO' ? current : view;
      respond({ ok: true, fileId: view.fileId, view: view.view, key: view.key, phase: view.stopped ? 'stopped' : local?.phase, error: local?.error }); return;
    }
    if (message.type === 'NOTICE' && top) {
      const ids = probeFrame().ids;
      if (ids.length !== 1 || ids[0] !== message.fileId || !/^[−＋]\d+\.\d dB(?:（上限）)?$/.test(message.label ?? '')) { respond({ error: '表示中の動画が変わりました。' }); return; }
      show(message.label); respond({ ok: true }); return;
    }
    const state = current;
    if (!state || message.key !== state.key || message.view !== state.view) { respond({ error: '対象動画が変わりました。' }); return; }
    try {
      if (message.type === 'CHECK') {
        if (!state.node.isConnected || state.source !== (state.node.currentSrc || state.node.src) || !state.controlled) throw new Error('対象動画が変わりました。');
        respond({ ok: true, duration: state.node.duration });
      } else if (message.type === 'ANALYSIS_START') {
        if (state.phase !== 'pending' || !validKey(message.job) || (state.analysisJob && state.analysisJob !== message.job)) throw new Error('対象の解析が変わりました。');
        if (!state.analysisJob) {
          state.analysisJob = message.job; state.registered = true; clearTimeout(state.claimDeadline);
          state.deadline = setTimeout(() => {
            if (current === state && state.phase === 'pending' && state.analysisJob === message.job) fail(state, '解析時間の上限に達しました。補正を再開して再試行できます。');
          }, 65_000);
        }
        respond({ ok: true });
      } else if (message.type === 'APPLY') {
        if (state.phase !== 'pending' || !state.node.isConnected || state.source !== (state.node.currentSrc || state.node.src)) throw new Error('対象動画が変わりました。');
        clearWaits(state); state.registered = true;
        state.gain = message.gain; state.master = message.volume; state.label = message.label; state.phase = 'waiting';
        state.writtenMuted = state.muted; state.node.muted = state.muted;
        activate(state);
        if (state.phase === 'waiting') { if (state.requested) state.node.play().catch(() => {}); wake(); }
        respond({ ok: true, running: state.phase === 'playing' });
      } else if (message.type === 'RESTORE') { release(state); respond({ ok: true }); }
      else if (message.type === 'FAIL') { fail(state, message.error); respond({ ok: true }); }
      else if (message.type === 'RETRY') { candidate(state.node); inspectView(); respond({ ok: true }); }
      else if (message.type === 'AUDIO_STATUS') { respond({ ok: true, audio: audio.status(state.node), phase: state.phase }); }
    } catch (error) { fail(state, error.message); respond({ error: error.message }); }
  });
  inspect();
})();
