# Clip — 切り抜きショート動画ビューアー 設計

Grok などのボットが作った切り抜き動画を受け付け、縦スワイプのショート動画として Web / iOS / Android で見るためのサービス。
構成は Crossmovie（`~/git/movie-workers`）、ボット向け API は YouTune TV（`~/git/yt-tv`）のエージェント API に揃えている。

## 1. 全体像

```
 Grok bot ──(Bearer mc_...)──▶ clip.riyamamo.com/api/v1/*   ← Access は Bypass
    │                                │  Cloudflare Worker (clip-worker)
    │  署名付き PUT                   │  D1 (movie-clip): clips / clip_tags / agent_tokens
    ▼                                ▼
 Wasabi バケット movie-clip（private）◀── 署名付き GET ── Web / iOS / Android
                                     ▲
 視聴者 ──(Cloudflare Access)──▶ clip.riyamamo.com/ と /api/*
```

| 部品 | 場所 | 技術 |
|---|---|---|
| Worker（API ＋ Web 配信） | `worker/`, `public/` | Hono, D1, aws4fetch |
| ストレージ | Wasabi `movie-clip`（ap-northeast-1, private） | S3 互換。CORS は `clip.riyamamo.com` の GET/HEAD のみ |
| iOS | `ios/MovieClip` | SwiftUI ＋ AVPlayer、iOS 17+、依存なし |
| Android | `android/` | Kotlin ＋ Compose ＋ Media3 ExoPlayer、minSdk 26 |

## 2. 受け付け（ボット → Wasabi）

ボットには Wasabi の鍵を渡さない。ボットが持つのはスコープ付きのトークンだけで、
Worker が1時間有効の署名付き URL を発行する。投稿は2通り。

### 2.1 アップロード方式（ファイルを持っているボット）

```
POST /api/v1/clips  {title, video: {content_type: "video/mp4"}, poster?: {...}, external_id, ...}
  → 201 {clip: {id, status: "pending"}, uploads: {video: {method: "PUT", url, headers}}}
PUT  <uploads.video.url>   (Content-Type を headers のとおりに付ける)
POST /api/v1/clips/:id/complete
  → 200 {clip: {status: "ready"}}     ← ここでフィードに出る
```

- `complete` は Wasabi に HEAD して実体を確かめる。無ければ 409 `video_not_uploaded`、500MB 超は消して 413
- ポスターは任意。PUT されていなければ外して公開する（アプリは動画の先頭フレームを出す）
- `complete` されないまま24時間経った枠は cron（毎日 04:00 JST）がオブジェクトごと消す

### 2.2 URL 方式（URL しか持っていないボット）

```
POST /api/v1/clips  {title, video: {url: "https://..."}}
  → 201 {clip: {status: "ready"}}
```

Worker が取得して Wasabi にストリームのまま流し込み、その場で公開する。チャット型のエージェントは
バイナリの PUT ができないことが多いので、Grok にはこちらを推奨と OpenAPI に書いている。

- メモリに載せないため、Content-Length を返す配布元だけ受け付ける（無ければ 422 `source_length_unknown`）
- Content-Type が `application/octet-stream` でも拡張子から判定する
- https のみ

### 2.3 冪等性

`external_id`（ボット側の一意な ID。例: `yt:<videoId>:<開始秒>`）はトークン名ごとに一意。

- 公開済みと同じ値で再送 → 200 `duplicate: true` で既存を返す（二重登録しない）
- 未完了と同じ値で再送 → 同じ id のまま署名付き URL を出し直す（途中で落ちたボットがやり直せる）

### 2.4 オブジェクトの置き場所

```
clips/<id>/video     Content-Type は PUT 時のもの
clips/<id>/poster
```

拡張子を付けないのは、再送で形式が変わっても同じキーを上書きでき、孤立オブジェクトが出ないようにするため。
`id` は `Date.now()` の36進数＋乱数で、おおむね作成順に並ぶ。

## 3. 認証

| 経路 | 対象 | 認証 |
|---|---|---|
| `/`, `/api/*`（v1 以外） | 視聴者（自分） | Cloudflare Access。Worker でも JWT（署名・aud・iss・exp）を検証 |
| `/api/v1/*` | ボット | `mc_<id>_<secret>` の Bearer。SHA-256 だけ保存。Access は Bypass |
| `/api/v1/openapi.json` | ボット | 認証なし（ツール定義） |

- スコープ: `read` / `clips:write` / `clips:delete`
- **公開モード（`PUBLIC_VIEWER=true`、今の本番）**: 閲覧系（`GET /api/feed`・`/api/tags`・`/api/clips/:id`・`POST /api/clips/:id/view`）だけ認証なしで開く。
  削除・トークン管理・`/api/me`・`/api/app-auth` は Access 必須のまま（`ACCESS_AUD` が空なので 503）。
  クライアントはログインなしでフィードを出し、401 が返ったときだけログイン画面に回る。削除ボタンはログイン済み（Web は `/api/me` が通る）ときだけ出す。
  閉じるときは Access を設定（`scripts/setup-access.mjs`）して `PUBLIC_VIEWER` を外す
- Access の設定ミスで素通しになっても Worker が JWT を検証するので視聴 API は開かない。
  `ACCESS_AUD` が空なら 503（ローカルは `DEV_VIEWER_EMAIL` で素通し）
- ネイティブアプリは `/api/app-auth` を ASWebAuthenticationSession / Custom Tabs で開いて Access → Google を通し、
  Worker が `movieclip://auth?token=<JWT>` で返す JWT を保存する。以降は `cf-access-token` ヘッダで送る
  （Access はこのヘッダを受け付け、Worker も同じヘッダを見る）。401 か Access へのリダイレクトでログインに戻る
- トークンの発行: `POST /api/admin/tokens`（Access 経由）か `scripts/issue-token.mjs`（D1 へ直接）

## 4. 視聴 API

```
GET    /api/feed?cursor=&tag=&limit=&order=   新着順（既定）か order=shuffle。1ページ10件、最大30
GET    /api/clips/:id                   再生 URL の取り直し用
POST   /api/clips/:id/view              再生回数（2秒見たら1回）
DELETE /api/clips/:id                   Wasabi のオブジェクトごと消す
GET    /api/tags                        タグと件数
GET    /api/app-auth                    アプリのログイン
GET/POST/DELETE /api/admin/tokens       ボット用トークン
```

シャッフルは最初のページで seed と時刻を決めてカーソルに入れ、ページをまたいでも並びが変わらないようにする
（重複も漏れもない。途中で公開されたものは次のシャッフルから混ざる）。対象の id を全部読んで Worker で並べ替えるので、
件数が数万を超えたら作り直す。

フィードの各要素は `video_url` / `poster_url` に署名付き GET URL（6時間）を持つ。
1本ずつ URL を取りに行かずに済むのでスワイプしてすぐ再生できる。署名はローカル計算なので Wasabi へのリクエストは発生しない。
URL が切れて再生に失敗したら、各クライアントが `GET /api/clips/:id` で取り直す（同じ動画は10秒に1回まで）。

## 5. クライアント

3つとも同じ挙動に揃えている。

- 縦ページング（Web: scroll-snap、iOS: `scrollTargetBehavior(.paging)`、Android: `VerticalPager`）
- 表示中の1本と前後1本だけプレイヤーを持ち、それより遠いものは捨てる（先読みとメモリの両立）
- 止まったページだけ先頭から再生し、ループする。タップで一時停止
- 残り3本で次のページを読む
- 一覧（3列のサムネイル）とフィードを上部のボタンで切り替える。一覧でタップした動画からフィードを再生する。
  ポスターが無い動画は先頭付近のフレームを使う（Web は `<video preload=metadata>`、iOS は AVAssetImageGenerator、Android は coil-video）
- 並び順（新着／シャッフル）を上部のボタンで切り替え、端末に保存する。切り替え中に届いた古い並びの結果は捨てる
- ミュートは全動画で共通の1つの設定で、端末に保存する。Web は音ありの自動再生を拒否されたらミュートで再生し直す
- タグを押すとそのタグで絞り込み、上部のチップで解除
- 切り抜き元へのリンク（YouTube なら `t=` 付き）
- 削除は確認つき
- アプリが裏に回ったら止める

iOS は `AVAudioSession.playback` でマナーモードでも音を出す。DEBUG ビルドは環境変数 `CLIP_ORIGIN` / `CLIP_DEV_TOKEN`、
Android の debug ビルドは `-PclipOrigin` / `-PclipDevToken` で wrangler dev に繋げる。

## 6. 決めたこと・やらなかったこと

- **Worker で動画を加工しない。** 縦型への変換・字幕焼き込み・ポスター生成はボット（や clipnarr）の責務。Worker は受け付けと配信だけ
- **HLS にしない。** ショートは数十秒〜数分で mp4 の progressive 再生で足りる。`+faststart` の mp4 を推奨と OpenAPI に書いている
- **Crossmovie とは D1 もバケットも分ける。** 権限・ライフサイクル（cron の掃除）・削除の影響範囲を独立させるため
- **おすすめ順は持たない。** 新着順とシャッフルのみ。必要になったら `view_count` や未視聴を使った並びを足す

## 7. 未確認・残課題

- Wasabi の鍵は暫定で Crossmovie と同じものを使っている。`movie-clip` バケットだけに絞ったサブユーザーの鍵に差し替えるのが望ましい
- Android は実機・エミュレータでの再生を未確認（ビルドのみ）。Custom Tabs から `movieclip://` への 302 で戻れるかも実機で確かめる
- iOS の ASWebAuthenticationSession と Access の組み合わせは Crossmovie と同じ方式だが、本番ドメインでは未確認
- `cf-access-token` ヘッダでの Access 通過は本番で未確認。通らなければ Crossmovie と同じく cookie（`CF_Authorization`）で送る
