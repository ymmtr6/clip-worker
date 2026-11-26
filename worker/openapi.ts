/**
 * ボット（Grok など）にツールとして渡すための定義。
 * description はエージェントがそのまま読むので、運用上の約束事もここに書く。
 */

const clipId = { name: "id", in: "path", required: true, schema: { type: "string" } };

const error = {
  description: "エラー。error に理由コード、field に問題のある項目が入る",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

const ok = (description: string, schema: object) => ({
  description,
  content: { "application/json": { schema } },
});

const clipResponse = { type: "object", properties: { clip: { $ref: "#/components/schemas/Clip" } } };

export function openApiSpec(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Movie Clip Agent API",
      version: "1.0.0",
      description: [
        "切り抜き動画（縦型ショート）を Movie Clip のビューアーに投稿するAPI。投稿した動画は公開と同時にフィードの先頭に並ぶ。",
        "",
        "投稿は2通り。",
        "1. 動画のURLを渡す（推奨。手元にファイルを持たないエージェント向け）: POST /clips の video に {\"url\": \"https://...\"} を渡すと、サーバーが取得して保存し、その場で公開する。配布元は Content-Length を返す必要がある。",
        "2. ファイルを直接アップロードする: POST /clips の video に {\"content_type\": \"video/mp4\"} を渡すと、応答の uploads.video に署名付きURLが入る。そのURLへ headers の Content-Type を付けてファイル本体を PUT し、最後に POST /clips/{id}/complete を呼ぶと公開される。署名付きURLの期限は1時間、complete されないまま24時間経った投稿は消える。",
        "",
        "- external_id に自分側の一意なID（元動画ID＋開始秒など）を入れること。同じ external_id の再送は二重登録されず、公開済みなら duplicate: true でそのまま返る。",
        "- 縦型（9:16）の mp4（H.264/AAC）を推奨。受け付ける形式は video/mp4, video/quicktime, video/webm、上限は500MB。",
        "- poster（サムネイル）は任意。無ければアプリは動画の先頭フレームを表示する。",
        "- source_url / source_title / source_start_seconds に切り抜き元を入れると、ビューアーに元動画へのリンクが出る。",
        "- tags は最大10個、1つ32文字まで。先頭の # は外される。",
        "- 必要なスコープはトークン発行時に決まる。GET /me で確認できる。",
      ].join("\n"),
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "mc_ で始まるエージェントトークン" } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, field: { type: "string" }, reason: { type: "string" } } },
        Part: {
          oneOf: [
            { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri", description: "https のみ" } } },
            { type: "object", required: ["content_type"], properties: { content_type: { type: "string" } } },
          ],
        },
        ClipInput: {
          type: "object",
          required: ["title", "video"],
          properties: {
            title: { type: "string", maxLength: 200 },
            description: { type: "string", maxLength: 2000 },
            tags: { type: "array", items: { type: "string" }, maxItems: 10 },
            source_url: { type: "string", format: "uri", description: "切り抜き元の動画URL" },
            source_title: { type: "string" },
            source_start_seconds: { type: "integer", description: "切り抜き元での開始位置（秒）" },
            external_id: { type: "string", description: "冪等キー。同じボットが同じ値で再送しても二重登録しない" },
            duration_seconds: { type: "number" },
            width: { type: "integer" },
            height: { type: "integer" },
            video: { $ref: "#/components/schemas/Part", description: "video/mp4, video/quicktime, video/webm" },
            poster: { $ref: "#/components/schemas/Part", description: "image/jpeg, image/png, image/webp" },
          },
        },
        Upload: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["PUT"] },
            url: { type: "string" },
            headers: { type: "object", additionalProperties: { type: "string" }, description: "PUT にそのまま付けるヘッダ" },
          },
        },
        Clip: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["pending", "ready"], description: "ready になるとビューアーに出る" },
            title: { type: "string" },
            description: { type: ["string", "null"] },
            tags: { type: "array", items: { type: "string" } },
            source_url: { type: ["string", "null"] },
            source_title: { type: ["string", "null"] },
            source_start_seconds: { type: ["integer", "null"] },
            external_id: { type: ["string", "null"] },
            size_bytes: { type: ["integer", "null"] },
            duration_seconds: { type: ["number", "null"] },
            has_poster: { type: "boolean" },
            view_count: { type: "integer" },
            created_at: { type: "string", format: "date-time" },
            published_at: { type: ["string", "null"], format: "date-time" },
          },
        },
      },
    },
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          summary: "自分のトークン名・スコープ・サイズ上限",
          responses: { 200: ok("自分の情報", { type: "object" }), 401: error },
        },
      },
      "/clips": {
        get: {
          operationId: "listClips",
          summary: "公開済みのクリップを新しい順に返す（read）",
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" }, description: "前の応答の next_cursor" },
            { name: "tag", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", maximum: 30 } },
          ],
          responses: {
            200: ok("クリップ一覧", {
              type: "object",
              properties: { clips: { type: "array", items: { $ref: "#/components/schemas/Clip" } }, next_cursor: { type: ["string", "null"] } },
            }),
            401: error,
          },
        },
        post: {
          operationId: "createClip",
          summary: "クリップを投稿する（clips:write）",
          description: "video が URL なら取り込んでその場で公開（201, status=ready）。content_type ならアップロード用URLを返す（201, status=pending）。external_id が既存なら 200 と duplicate: true。",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ClipInput" } } } },
          responses: {
            200: ok("external_id が既存", { type: "object" }),
            201: ok("作成した", {
              type: "object",
              properties: {
                clip: { $ref: "#/components/schemas/Clip" },
                uploads: {
                  type: "object",
                  properties: { video: { $ref: "#/components/schemas/Upload" }, poster: { $ref: "#/components/schemas/Upload" } },
                },
                uploads_expire_at: { type: "string", format: "date-time" },
                duplicate: { type: "boolean" },
              },
            }),
            400: error, 401: error, 403: error, 413: error,
            422: { ...error, description: "URL から取得できない（source_fetch_failed / source_length_unknown / unsupported_media_type）" },
          },
        },
      },
      "/clips/{id}": {
        get: { operationId: "getClip", summary: "1件取得（read）", parameters: [clipId], responses: { 200: ok("クリップ", clipResponse), 404: error } },
        patch: {
          operationId: "updateClip",
          summary: "タイトル・説明・タグ・切り抜き元を直す（clips:write）。tags は丸ごと置き換え",
          parameters: [clipId],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" }, description: { type: "string" }, tags: { type: "array", items: { type: "string" } },
                    source_url: { type: "string" }, source_title: { type: "string" }, source_start_seconds: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: { 200: ok("更新後", clipResponse), 400: error, 404: error },
        },
        delete: {
          operationId: "deleteClip",
          summary: "削除（clips:delete）。動画ファイルも消える",
          parameters: [clipId],
          responses: { 200: ok("削除した", { type: "object" }), 403: error },
        },
      },
      "/clips/{id}/complete": {
        post: {
          operationId: "completeClip",
          summary: "アップロードを終えたクリップを公開する（clips:write）",
          description: "動画が PUT されていなければ 409 video_not_uploaded。ポスターが無い・壊れている場合はポスター無しで公開する。公開済みなら何もしない。",
          parameters: [clipId],
          responses: { 200: ok("公開した", clipResponse), 404: error, 409: error, 413: error },
        },
      },
    },
  };
}
