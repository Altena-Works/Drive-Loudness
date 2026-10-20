import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url)), out = path.join(root, 'dist');
let config = {};
try { config = JSON.parse(await readFile(path.join(root, 'config.local.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (config.clientId && !/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.clientId)) throw new Error('clientIdの形式を確認してください。');
await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
await build({ absWorkingDir: root, entryPoints: {
  background: 'src/extension/background.js', content: 'src/extension/content.js',
  offscreen: 'src/extension/offscreen.js', 'analysis-worker': 'src/extension/analysis-worker.js',
  popup: 'src/ui/popup.js', options: 'src/ui/options.js', batch: 'src/ui/batch.js',
}, bundle: true, format: 'esm', target: 'chrome116', outdir: out, legalComments: 'none' });
for (const file of ['popup.html', 'options.html', 'batch.html', 'offscreen.html', 'styles.css']) await copyFile(path.join(root, 'src/ui', file), path.join(out, file));
const icons = Object.fromEntries([16, 24, 32, 48, 128].map(size => [size, `icons/icon${size}.png`]));
await mkdir(path.join(out, 'icons'), { recursive: true });
for (const file of Object.values(icons)) await copyFile(path.join(root, 'src', file), path.join(out, file));
const manifest = {
  manifest_version: 3, name: 'DriveLoudness', version: '0.1.0', minimum_chrome_version: '116',
  description: 'Google Drive動画を再生前に部分解析し、動画ごとの音量差を固定倍率で補正します。',
  permissions: ['scripting', 'storage', 'identity', 'offscreen', 'webNavigation'],
  host_permissions: ['https://drive.google.com/*', 'https://docs.google.com/*', 'https://www.googleapis.com/*', 'https://youtube.googleapis.com/*'],
  background: { service_worker: 'background.js', type: 'module' },
  icons,
  action: { default_popup: 'popup.html', default_title: 'DriveLoudness', default_icon: icons },
  options_page: 'options.html',
  content_scripts: [{ matches: ['https://drive.google.com/*', 'https://docs.google.com/*', 'https://youtube.googleapis.com/embed/*'], all_frames: true, js: ['content.js'], run_at: 'document_start' }],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src https://www.googleapis.com;" },
};
if (config.clientId) manifest.oauth2 = { client_id: config.clientId, scopes: ['https://www.googleapis.com/auth/drive.readonly'] };
if (config.publicKey) manifest.key = config.publicKey;
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${out}${config.clientId ? ' (OAuth configured)' : ' (OAuth未設定: READMEを参照)'}`);
