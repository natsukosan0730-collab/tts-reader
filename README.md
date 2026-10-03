# TTS Reader

テキスト → Gemini TTS → WAV。スマホのホーム画面に追加して使うPWA。生成はサーバー側(Vercel)で継続する。

## セットアップ
```bash
cd ~/tts-reader
npm install
npm test                      # 整形/分割/WAVのテスト
npx vercel login
npx vercel link
npx vercel blob create-store  # Blobストア作成(プライベート。BLOB_STORE_ID 等が自動で入る)
npx vercel env add GEMINI_API_KEY      # Google AI Studioで発行したキー
npx vercel env add APP_PASSWORD        # アプリ用の合言葉(他人の利用を防ぐ)
npx vercel --prod
```
Blobストアはダッシュボードの Storage > Create > Blob からでも作成でき、プロジェクトに接続すると環境変数が入る。

## 構成
- `public/` 画面(index.html, refine.js=推敲ロジック, PWA一式)
- `api/jobs.js` POSTで生成ジョブ開始(`waitUntil`でレスポンス後も継続)、GETで進捗取得
- `lib/gemini.js` Gemini TTS呼び出し、`lib/audio.js` 分割とWAV化

## 制約
- 関数の最大実行時間は300秒。長文は160秒ごとに区切り、残りを新しい関数呼び出しへ自動で引き継ぐ(画面を閉じていても継続)。
- 引き継ぎに失敗した場合や、サーバー側が止まった場合(150秒以上更新なし)は、画面を開くと自動で続きから再開する。再開では完了済みの分割は再処理しない。
- 生成物はプライベートなVercel Blobに保存され、アプリのパスワード付きAPI経由でのみ取得できる。
- Blobストアは「プライベート」で作成すること(コードは access:'private' 前提)。認証はVercelが自動設定するOIDC(BLOB_STORE_ID)を使う。
