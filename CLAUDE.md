# CLAUDE.md

切り抜きショート動画ビューアー（clip-worker）。ボットが Wasabi に動画を投稿し、Web / iOS / Android で縦スワイプ再生する。
設計判断は [DESIGN.md](./DESIGN.md) にある。実装方針を変える前に該当章を読むこと。

## コマンド

```bash
npm test             # Worker のテスト
npm run typecheck
npm run dev          # wrangler dev（.dev.vars が必要。README 参照）
cd ios/MovieClip && xcodebuild -project MovieClip.xcodeproj -scheme MovieClip -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
cd android && ./gradlew assembleDebug
```

## 約束事

- ボット向け API（`/api/v1`）を変えたら `worker/openapi.ts` も直す。description はエージェントがそのまま読むので、運用ルールもそこに書く
- 認証・トークン形式は `~/git/yt-tv` のエージェント API に揃えている。片方だけ変えない
- Wasabi は `worker/storage.ts` の `Storage` 越しに触る。テストはメモリ実装に差し替える（`createApp(makeStorage)`）
- 3つのクライアントは同じ挙動（前後1本の先読み、URL 失効時の取り直し、2秒で再生回数）に揃える。片方だけ変えない
- 識別子 `movieclip://`（アプリのログイン）、`mc_`（トークン接頭辞）、バケット `movie-clip`、D1 `movie-clip` は変えると既存の利用が壊れる
