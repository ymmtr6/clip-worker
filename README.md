# clip-worker

Grok などのボットが作った切り抜き動画を Wasabi に受け付け、縦スワイプのショート動画として見るためのサービス。
設計は [DESIGN.md](./DESIGN.md)。

- `worker/` — Cloudflare Worker（Hono ＋ D1）。ボット用 API と視聴 API
- `public/` — Web ビューアー
- `ios/MovieClip` — iOS アプリ（SwiftUI ＋ AVPlayer）
- `android/` — Android アプリ（Compose ＋ Media3）
- `scripts/` — トークン発行と投稿の見本

## ローカル開発

```bash
npm install
cat > .dev.vars <<'EOF'
WASABI_ACCESS_KEY=...
WASABI_SECRET_KEY=...
DEV_VIEWER_EMAIL=dev@localhost
ACCESS_AUD=
EOF
npm run db:migrate:local
npm run dev                 # http://localhost:8787
npm test                    # Worker のテスト（Vitest、D1 は node:sqlite、Wasabi はメモリ実装）
npm run typecheck
```

ローカルでも Wasabi は本物の `movie-clip` バケットを使う。

## デプロイ手順

1. Wasabi の鍵を登録する（`movie-clip` バケットだけに絞ったサブユーザーの鍵を推奨）

   ```bash
   npx wrangler secret put WASABI_ACCESS_KEY
   npx wrangler secret put WASABI_SECRET_KEY
   ```

2. Cloudflare Zero Trust で Access アプリケーションを2つ作る
   - `clip.riyamamo.com`（パス指定なし）: Allow 自分のメールアドレス。AUD タグを `wrangler.jsonc` の `ACCESS_AUD` に入れる
   - `clip.riyamamo.com/api/v1`: Bypass Everyone（ボットはトークンで認証する）

3. デプロイしてスキーマを当てる（D1 は初回デプロイで自動作成される）

   ```bash
   npm run deploy
   npm run db:migrate:remote
   ```

4. ボット用トークンを発行する

   ```bash
   node scripts/issue-token.mjs grok                 # 全スコープ
   node scripts/issue-token.mjs grok read,clips:write
   ```

5. ボットに渡すもの
   - ツール定義: `https://clip.riyamamo.com/api/v1/openapi.json`
   - トークン: `mc_...`（`Authorization: Bearer mc_...`）

## ボットからの投稿

URL を渡す（その場で公開）:

```bash
curl -X POST https://clip.riyamamo.com/api/v1/clips \
  -H "Authorization: Bearer $CLIP_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"神回","tags":["ゲーム"],"external_id":"yt:abc:120",
       "source_url":"https://www.youtube.com/watch?v=abc","source_start_seconds":120,
       "video":{"url":"https://example.com/clip.mp4"}}'
```

ファイルをアップロードする（枠 → PUT → complete）:

```bash
CLIP_TOKEN=mc_... node scripts/post-clip.mjs clip.mp4 "神回" poster.jpg
```

## アプリ

### iOS

```bash
open ios/MovieClip/MovieClip.xcodeproj
```

バンドル ID `com.riyamamo.movieclip`、Team `KQJ4F328N7`。シミュレータから wrangler dev に繋ぐときは、
スキームの環境変数に `CLIP_ORIGIN=http://localhost:8787/` と `CLIP_DEV_TOKEN=dev` を入れる（DEBUG ビルドのみ有効）。

### Android

```bash
cd android
./gradlew installDebug                                                    # 本番に繋ぐ
./gradlew installDebug -PclipOrigin=http://10.0.2.2:8787/ -PclipDevToken=dev  # エミュレータから wrangler dev
```
