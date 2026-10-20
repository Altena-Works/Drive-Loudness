# DriveLoudness

Google Driveの動画を部分解析し、動画ごとの音量差を自動で補正するChrome拡張です。動画内の自然な強弱を保ち、適用した補正量を動画上に約3秒表示します。

現在は開発版です。利用にはGoogle OAuthクライアントの設定が必要です。

## 使い方

1. 拡張の設定から「Googleに接続」し、動画を読み取れるアカウントで認証します。
2. Driveで動画を開くと自動解析が始まります。解析中は一時停止し、完了後はDriveの通常操作で再生できます。
3. 聞く音量は端末側で調整します。補正は動画ごとに固定し、基準は−23 LUFSです。

原音で聞くときは、拡張ボタンから補正を停止します。動画は一時停止し、次の再生から原音に戻ります。認証切れや解析失敗は「未補正」と表示します。音声処理を再開できない場合は、Driveタブを再読み込みしてください。

### フォルダーの一括解析

拡張ボタンの「フォルダーを一括解析」から、「対象を確認」→「解析を開始」を押します。Drive上で開いているフォルダーは自動入力され、手動でURLやIDを指定することもできます。

サブフォルダーも対象にし、ショートカット先には進みません。処理中は一括解析のタブを開いておいてください。中止やタブを閉じた場合も、解析済みの結果は次回に再利用できます。

## セットアップ

Node.js 22以降、npm、Chrome 116以降を使用します。

1. 依存関係を取得してビルドします。

   ```sh
   npm ci
   npm run build
   ```

2. Chromeの `chrome://extensions` でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」から `dist` を選びます。表示された拡張IDを控えます。
3. [Google Cloud Console](https://console.cloud.google.com/)でGoogle Drive APIを有効にし、OAuth同意画面を設定します。テスト中は利用するアカウントをテストユーザーに追加します。
4. OAuthクライアントを「Chrome拡張機能」として作成し、手順2の拡張IDを登録します。
5. `config.example.json` を参考に `config.local.json` を作り、クライアントIDを設定します。クライアントシークレットや秘密鍵は使いません。

   ```json
   {
     "clientId": "123456789012-your-client.apps.googleusercontent.com"
   }
   ```

6. `npm run build` を再実行し、Chromeで拡張を再読み込みします。

`dist` を別の場所やPCに移す場合は、拡張IDとOAuth登録を合わせてください。既存の拡張公開鍵がある場合は、`config.local.json` の `publicKey` に設定できます。[Chrome OAuthの設定](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)

## 権限とデータ

Google Drive全体の読み取り権限（`drive.readonly`）を使います。開いた動画や一括解析の対象フォルダーを読み取り、Driveへの作成・変更・削除は行いません。Drive・Docsと、Driveの動画プレーヤーがある `youtube.googleapis.com` へのアクセス権も使用します。

音声解析は端末内で行い、外部の音声解析サービスは使いません。動画・PCM・OAuthトークンを拡張がファイルやログへ保存することはありません。測定結果はブラウザ内に最大5000件・5MiBまで保存し、設定画面から削除できます。「接続情報を解除」は、拡張のトークンキャッシュと測定結果を削除します。Google側の許可はGoogleアカウントの設定から撤回してください。

`drive.readonly` は制限付きスコープです。不特定多数への配布には、Googleの検証要件を確認してください。[Drive APIのスコープ](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

## 対応範囲と制約

- ダウンロードが許可されたMP4 / AAC-LC / mono・stereoに対応します。WebM、MOV、fragmented MP4、複数音声トラック、複雑な編集リストには対応していません。
- 長い動画は冒頭を含む最大16地点で推定します。全編の厳密なIntegrated LUFS測定ではありません。無音や推定値が安定しない動画は補正しません。
- 増幅は最大+20dBです。リミッターや瞬間ピークの制限は行わないため、音割れを防ぐ保証はありません。
- 1本の解析は取得64MiB・256要求・60秒までです。他の動画の解析を待つ時間は含みません。取得に失敗しても全ファイルのダウンロードへ切り替えません。
- 一括解析の対象確認は、非フォルダー5000件・1000フォルダー・一覧5MiBまでです。
- Driveの変換済み音声と原本の差や、Driveの画面変更によって補正が適切に働かない場合があります。スピーカーの実音圧や聴感上の一致は保証しません。

## 開発

テストにはffmpeg・ffprobe、ブラウザテストにはPlaywrightのChromiumが必要です。テスト用動画は次の手順で生成します。

```sh
node scripts/fixtures.mjs
npm test
npx playwright install chromium
node tests/audio-path.mjs
npm run test:browser
npm run test:loudness
```

ブラウザテストのGoogle/OAuth通信はローカルデータに置き換えています。実Driveでの動作確認とは区別してください。`PLAYWRIGHT_BROWSERS_PATH` を使う場合は、Chromiumの取得時とテスト実行時の両方に指定します。

`src/analysis` に解析処理、`src/extension` に拡張の制御、`src/ui` に画面を置いています。アイコンの再生成は `npm run icons`、配布物の生成は `npm run build` です。
