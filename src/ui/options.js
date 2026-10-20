const $ = id => document.getElementById(id);
$('batch').onclick = async () => {
  try { const response = await chrome.runtime.sendMessage({ type: 'OPEN_BATCH' }); if (response?.error) throw new Error(response.error); }
  catch (error) { $('error').textContent = error.message; }
};
const manifest = chrome.runtime.getManifest();
$('client-state').textContent = manifest.oauth2 ? 'OAuthクライアントID: 設定済み' : 'OAuthクライアントIDが未設定です。プロジェクト内のREADMEを参照してください。';
$('connect').disabled = !manifest.oauth2;
for (const [id, type, label] of [['connect', 'CONNECT', 'Googleに接続しました。Driveの動画タブへ戻ってください。'],
  ['disconnect', 'DISCONNECT', '接続情報と測定結果を削除しました。'], ['clear', 'CLEAR_CACHE', '測定結果を削除しました。']]) {
  $(id).onclick = async () => {
    $('error').textContent = ''; $('status').textContent = '処理中…';
    const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
    try { const response = await chrome.runtime.sendMessage({ type }); if (response?.error) throw new Error(response.error); $('status').textContent = label; }
    catch (error) { $('status').textContent = ''; $('error').textContent = error.message; }
    finally { buttons.forEach(b => { b.disabled = b.id === 'connect' && !manifest.oauth2; }); }
  };
}
