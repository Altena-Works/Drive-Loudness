import { ANALYZER_VERSION } from '../analysis/loudness.js';
export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const fileIdPattern = /^[A-Za-z0-9_-]{10,200}$/;
export async function getToken(interactive = false) {
  const manifest = chrome.runtime.getManifest();
  if (!manifest.oauth2?.client_id || manifest.oauth2.client_id.startsWith('REPLACE_'))
    throw new Error('OAuthクライアントIDが未設定です。READMEの設定手順を確認してください。');
  let response;
  try { response = await chrome.identity.getAuthToken({ interactive, scopes: [SCOPE], enableGranularPermissions: true }); }
  catch { throw Object.assign(new Error('Google連携が期限切れです。設定で再接続してください。'), { code: 'AUTH' }); }
  if (!response.token || (response.grantedScopes && !response.grantedScopes.includes(SCOPE)))
    throw Object.assign(new Error('Driveの読み取り権限が許可されていません。'), { code: 'AUTH' });
  return response.token;
}
export async function driveJson(path, { token, signal, refresh = true } = {}) {
  token ??= await getToken();
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
      headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]),
    });
    if (response.ok) return response.json();
    const status = response.status;
    await response.body?.cancel().catch(() => {});
    if (status === 401) {
      await chrome.identity.removeCachedAuthToken({ token });
      if (!refresh) throw Object.assign(new Error('Google連携が期限切れです。設定で再接続してください。'), { code: 'AUTH' });
      token = await getToken(); refresh = false; continue;
    }
    if ((status === 429 || status >= 500) && attempt < 2) {
      await new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, 500 * (attempt + 1));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      });
      continue;
    }
    throw new Error('Driveの情報を取得できません。アクセス権と通信環境を確認してください。');
  }
}
export async function metadata(fileId, token, retry = true, signal) {
  if (!fileIdPattern.test(fileId)) throw new Error('動画IDを確認できません。Driveの動画を単独表示で開いてください。');
  const fields = 'id,name,size,version,headRevisionId,md5Checksum,mimeType,capabilities(canDownload)';
  const file = await driveJson(`files/${fileId}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`, { token, signal, refresh: retry });
  if (!file.capabilities?.canDownload) throw new Error('この動画はダウンロードが許可されていないため解析できません。');
  if (file.mimeType !== 'video/mp4') throw new Error('現在はMP4（AAC-LC、mono/stereo）に対応しています。');
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 16 || typeof file.version !== 'string') throw new Error('動画のサイズ・版を確認できません。');
  // versionは閲覧などのメタデータ更新でも変わるため、バイナリ内容の版を優先する。
  const version = typeof file.headRevisionId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(file.headRevisionId)
    ? `head:${file.headRevisionId}:${size}`
    : typeof file.md5Checksum === 'string' && /^[a-f0-9]{32}$/i.test(file.md5Checksum)
      ? `md5:${file.md5Checksum.toLowerCase()}:${size}` : file.version;
  return { id: file.id, name: file.name, version, size, mimeType: file.mimeType };
}
export function cacheKey(file) { return `${file.id}:${file.version}:aac-default:analyzer-${ANALYZER_VERSION}:3s-weighted-v2`; }

// executeScriptで各フレームに渡すため、外側の変数を参照しない。
export function probeFrame() {
  const frameUrl = new URL(location.href);
  if (frameUrl.hostname === 'youtube.googleapis.com' &&
      (frameUrl.pathname !== '/embed/' || frameUrl.searchParams.get('ps') !== 'docs' ||
       frameUrl.searchParams.get('origin') !== 'https://drive.google.com'))
    return { ids: [], count: 0, media: null };
  const ids = [];
  const readId = input => {
    try {
      const url = new URL(input); if (!['drive.google.com', 'docs.google.com'].includes(url.hostname)) return;
      const id = /\/file\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] || url.searchParams.get('docid') || url.searchParams.get('id');
      if (id && /^[A-Za-z0-9_-]{10,200}$/.test(id)) ids.push(id);
    } catch {}
  };
  readId(location.href);
  for (const frame of document.querySelectorAll('iframe[src]')) readId(frame.src);
  if (frameUrl.hostname === 'drive.google.com' && !ids.length) {
    const headings = [...document.querySelectorAll('h2,[role="heading"][aria-level="2"]')].filter(node => node.getClientRects().length > 0);
    // Driveの「次へ」では選択行が前のファイルのまま残る。表示名が一意な行だけを使う。
    const rows = [...document.querySelectorAll('[role="row"][data-id]')];
    const candidates = rows.filter(row => headings.some(heading => {
      const name = row.querySelector('strong');
      return name && heading.textContent.trim() === name.textContent.trim();
    }));
    if (candidates.length === 1 && document.querySelector('iframe[src^="https://youtube.googleapis.com/embed/"],video')) {
      const id = candidates[0].getAttribute('data-id');
      if (/^[A-Za-z0-9_-]{10,200}$/.test(id)) ids.push(id);
    }
  }
  const videos = [...document.querySelectorAll('video')].filter(v => v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0);
  return { ids: [...new Set(ids)], count: videos.length, media: videos.length === 1 ? {
    duration: videos[0].duration, muted: videos[0].muted, volume: videos[0].volume,
  } : null };
}
export async function discover(tabId, owner) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://drive.google.com/')) throw new Error('Google Driveの動画タブで実行してください。');
  const view = await chrome.tabs.sendMessage(tabId, { type: 'VIEW_STATUS' }, { frameId: 0 });
  if (!view?.ok || !owner || view.key !== owner.key || view.view !== owner.view || !fileIdPattern.test(view.fileId))
    throw new Error('表示中の動画が変わりました。');
  const target = owner.documentId ? { documentId: owner.documentId } : { frameId: owner.frameId };
  const media = await chrome.tabs.sendMessage(tabId, { type: 'CHECK', key: owner.key, view: owner.view }, target);
  if (!media?.ok || !Number.isFinite(media.duration) || media.duration <= 0) throw new Error('対象動画を確認できません。');
  return { fileId: view.fileId, frameId: owner.frameId, duration: media.duration };
}
