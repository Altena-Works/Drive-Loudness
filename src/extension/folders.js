import { driveJson, fileIdPattern } from './drive.js';

export const FOLDER = 'application/vnd.google-apps.folder';
export const SHORTCUT = 'application/vnd.google-apps.shortcut';
export const BATCH_LIMITS = Object.freeze({ files: 5000, folders: 1000, bytes: 5 * 1024 ** 2 });
export const byteSize = value => new TextEncoder().encode(JSON.stringify(value)).length;
export function folderId(input) {
  const value = String(input ?? '').trim();
  if (fileIdPattern.test(value)) return value;
  try {
    const url = new URL(value);
    const id = /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
    if (url.protocol === 'https:' && url.hostname === 'drive.google.com' && !url.username && !url.password && !url.port && fileIdPattern.test(id ?? '')) return id;
  } catch {}
  throw new Error('DriveのフォルダーURLまたはフォルダーIDを入力してください。');
}
export async function enumerateFolder(input, { signal, progress = async () => {}, request = driveJson, limits = BATCH_LIMITS } = {}) {
  const id = folderId(input);
  const root = await request(`files/${id}?fields=id,name,mimeType,driveId,trashed&supportsAllDrives=true`, { signal });
  if (root.id !== id || root.mimeType !== FOLDER || root.trashed) throw new Error('読み取り可能なフォルダーを指定してください。');
  const pending = [id], seenFolders = new Set([id]), seenFiles = new Set(), items = [];
  const checkSize = () => {
    // 解析後の理由（最大249 UTF-16文字）と状態名の増分も予約する。
    const reserved = items.filter(item => item.status === 'pending').length * 754;
    if (items.length > limits.files || seenFolders.size > limits.folders || byteSize(items) + reserved > limits.bytes)
      throw new Error('対象が上限を超えました。より狭いフォルダーを指定してください。');
  };
  for (let index = 0; index < pending.length; index++) {
    let pageToken; const tokens = new Set();
    do {
      signal?.throwIfAborted();
      const params = new URLSearchParams({ q: `'${pending[index]}' in parents and trashed = false and (mimeType = '${FOLDER}' or mimeType = '${SHORTCUT}' or mimeType contains 'video/')`,
        fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType)', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
        corpora: root.driveId ? 'drive' : 'user' });
      if (root.driveId) params.set('driveId', root.driveId);
      if (pageToken) params.set('pageToken', pageToken);
      const page = await request(`files?${params}`, { signal });
      if (page.incompleteSearch || !Array.isArray(page.files)) throw new Error('フォルダーの対象確認が未完了です。再確認してください。');
      for (const file of page.files) {
        if (!fileIdPattern.test(file.id ?? '') || typeof file.name !== 'string' || typeof file.mimeType !== 'string') throw new Error('フォルダーの一覧を確認できません。');
        if (file.mimeType === FOLDER) {
          if (!seenFolders.has(file.id)) { seenFolders.add(file.id); pending.push(file.id); }
        } else if (!seenFiles.has(file.id)) {
          seenFiles.add(file.id);
          const reason = file.mimeType === SHORTCUT ? 'ショートカットは対象外です。' : file.mimeType !== 'video/mp4' ? 'MP4以外の動画は対象外です。' : '';
          items.push({ id: file.id, name: file.name.slice(0, 500), status: reason ? 'skipped' : 'pending', reason });
        }
      }
      checkSize();
      await progress({ folders: index + 1, found: items.length });
      pageToken = page.nextPageToken;
      if (pageToken && (typeof pageToken !== 'string' || tokens.has(pageToken))) throw new Error('ページ送りを完了できません。再確認してください。');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
  }
  return { folder: { id, name: String(root.name ?? id).slice(0, 500) }, items };
}
