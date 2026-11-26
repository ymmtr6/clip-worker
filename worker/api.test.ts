import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupPending, createApp, type Env } from "./index";
import { createMemoryStorage, createTestD1, testCtx } from "./testing";

let storage: ReturnType<typeof createMemoryStorage>;
let env: Env;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  storage = createMemoryStorage();
  env = { DB: createTestD1(), DEV_VIEWER_EMAIL: "me@example.com", ACCESS_AUD: "" } as Env;
  app = createApp(() => storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function call(path: string, init: RequestInit & { json?: unknown; token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  return app.request(`http://localhost${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  }, env, testCtx);
}

async function issue(scopes = ["read", "clips:write", "clips:delete"], name = "grok"): Promise<string> {
  const response = await call("/api/admin/tokens", { method: "POST", json: { name, scopes } });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function uploadClip(token: string, extra: Record<string, unknown> = {}) {
  const created = await call("/api/v1/clips", {
    method: "POST",
    token,
    json: { title: "神回の切り抜き", tags: ["#ゲーム", "ゲーム", "雑談"], video: { content_type: "video/mp4" }, ...extra },
  });
  const body = await created.json() as { clip: { id: string; status: string }; uploads?: Record<string, { url: string; headers: Record<string, string> }> };
  return { status: created.status, body };
}

describe("ボットの投稿（アップロード方式）", () => {
  it("枠を作り、PUT 後の complete で公開される", async () => {
    const token = await issue();
    const { status, body } = await uploadClip(token, { poster: { content_type: "image/jpeg" } });
    expect(status).toBe(201);
    expect(body.clip.status).toBe("pending");
    expect(body.uploads?.video.headers["Content-Type"]).toBe("video/mp4");
    expect(body.uploads?.poster.url).toContain(`clips/${body.clip.id}/poster`);

    // 公開前はフィードに出ない
    type Feed = { clips: { video_url: string; poster_url: string | null }[] };
    let feed = await (await call("/api/feed")).json() as Feed;
    expect(feed.clips).toHaveLength(0);

    // 動画がまだ無ければ公開できない
    expect((await call(`/api/v1/clips/${body.clip.id}/complete`, { method: "POST", token })).status).toBe(409);

    storage.putObject(`clips/${body.clip.id}/video`, 1234, "video/mp4");
    const done = await call(`/api/v1/clips/${body.clip.id}/complete`, { method: "POST", token });
    const clip = (await done.json() as { clip: { status: string; size_bytes: number; has_poster: boolean; tags: string[] } }).clip;
    expect(clip.status).toBe("ready");
    expect(clip.size_bytes).toBe(1234);
    // ポスターは PUT されなかったので外して公開する
    expect(clip.has_poster).toBe(false);
    expect(clip.tags).toEqual(["ゲーム", "雑談"]);

    feed = await (await call("/api/feed")).json() as Feed;
    expect(feed.clips).toHaveLength(1);
    expect(feed.clips[0].video_url).toContain("sig=get");
    expect(feed.clips[0].poster_url).toBeNull();
  });

  it("同じ external_id の再送は二重登録しない", async () => {
    const token = await issue();
    const first = await uploadClip(token, { external_id: "yt:abc:120" });
    const again = await uploadClip(token, { external_id: "yt:abc:120", title: "直したタイトル" });
    expect(again.status).toBe(200);
    expect(again.body.clip.id).toBe(first.body.clip.id);

    storage.putObject(`clips/${first.body.clip.id}/video`, 10, "video/mp4");
    await call(`/api/v1/clips/${first.body.clip.id}/complete`, { method: "POST", token });
    const third = await uploadClip(token, { external_id: "yt:abc:120" });
    expect(third.status).toBe(200);
    expect(third.body.clip.status).toBe("ready");
    expect(third.body.uploads).toBeUndefined();

    const list = await (await call("/api/v1/clips", { token })).json() as { clips: { title: string }[] };
    expect(list.clips.map((clip) => clip.title)).toEqual(["直したタイトル"]);
  });

  it("入力の誤りは項目名つきで返す", async () => {
    const token = await issue();
    const response = await call("/api/v1/clips", { method: "POST", token, json: { title: "x", video: { content_type: "video/avi" } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_input", field: "video.content_type" });
  });
});

describe("ボットの投稿（URL 方式）", () => {
  it("URL から取り込んでその場で公開する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(100), {
      headers: { "content-type": "application/octet-stream", "content-length": "100" },
    })));
    const token = await issue();
    const response = await call("/api/v1/clips", {
      method: "POST",
      token,
      json: { title: "URL", video: { url: "https://cdn.example.com/out/clip.mp4?x=1" }, source_url: "https://www.youtube.com/watch?v=abc" },
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { clip: { id: string; status: string; content_type: string }; uploads?: unknown };
    expect(body.clip.status).toBe("ready");
    expect(body.clip.content_type).toBe("video/mp4");
    expect(body.uploads).toBeUndefined();
    expect(storage.objects.get(`clips/${body.clip.id}/video`)?.size).toBe(100);
  });

  it("Content-Length の無い配布元は断る", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("abc", { headers: { "content-type": "video/mp4" } })));
    const token = await issue();
    const response = await call("/api/v1/clips", { method: "POST", token, json: { title: "x", video: { url: "https://cdn.example.com/a" } } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "source_length_unknown" });
  });

  it("http の URL は受け付けない", async () => {
    const token = await issue();
    const response = await call("/api/v1/clips", { method: "POST", token, json: { title: "x", video: { url: "http://example.com/a.mp4" } } });
    expect(response.status).toBe(400);
  });
});

describe("認証とスコープ", () => {
  it("トークンが無い・失効済みなら 401", async () => {
    expect((await call("/api/v1/me")).status).toBe(401);
    const token = await issue();
    const tokens = await (await call("/api/admin/tokens")).json() as { tokens: { id: string }[] };
    await call(`/api/admin/tokens/${tokens.tokens[0].id}`, { method: "DELETE" });
    expect((await call("/api/v1/me", { token })).status).toBe(401);
  });

  it("スコープ外の操作は 403", async () => {
    const token = await issue(["read"]);
    const response = await call("/api/v1/clips", { method: "POST", token, json: { title: "x", video: { content_type: "video/mp4" } } });
    expect(response.status).toBe(403);
  });

  it("OpenAPI はトークン無しで取れる", async () => {
    const response = await call("/api/v1/openapi.json");
    expect(response.status).toBe(200);
    expect((await response.json() as { servers: { url: string }[] }).servers[0].url).toBe("http://localhost/api/v1");
  });

  it("Access 未設定の本番では視聴APIを開かない", async () => {
    env = { DB: env.DB } as Env;
    expect((await call("/api/feed")).status).toBe(503);
  });

  it("PUBLIC_VIEWER なら閲覧だけ開き、削除とトークン管理は閉じたまま", async () => {
    const token = await issue();
    const { body } = await uploadClip(token);
    storage.putObject(`clips/${body.clip.id}/video`, 10, "video/mp4");
    await call(`/api/v1/clips/${body.clip.id}/complete`, { method: "POST", token });

    env = { DB: env.DB, PUBLIC_VIEWER: "true" } as Env;
    const feed = await call("/api/feed");
    expect(feed.status).toBe(200);
    expect(((await feed.json()) as { clips: unknown[] }).clips).toHaveLength(1);
    expect((await call("/api/tags")).status).toBe(200);
    expect((await call(`/api/clips/${body.clip.id}`)).status).toBe(200);
    expect((await call(`/api/clips/${body.clip.id}/view`, { method: "POST" })).status).toBe(200);

    expect((await call(`/api/clips/${body.clip.id}`, { method: "DELETE" })).status).toBe(503);
    expect((await call("/api/admin/tokens")).status).toBe(503);
    expect((await call("/api/admin/tokens", { method: "POST", json: { name: "x" } })).status).toBe(503);
    expect((await call("/api/app-auth")).status).toBe(503);
    expect((await call("/api/me")).status).toBe(503);
    // ボット API は今までどおりトークン必須
    expect((await call("/api/v1/clips")).status).toBe(401);
  });
});

describe("視聴", () => {
  async function publish(token: string, title: string, tags: string[] = []) {
    const { body } = await uploadClip(token, { title, tags });
    storage.putObject(`clips/${body.clip.id}/video`, 10, "video/mp4");
    await call(`/api/v1/clips/${body.clip.id}/complete`, { method: "POST", token });
    return body.clip.id;
  }

  it("新しい順にカーソルでページングし、タグで絞れる", async () => {
    const token = await issue();
    // 公開時刻は秒単位なので、1秒ずつずらして公開順を確定させる
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 5; i += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, 0, 0, i)));
      await publish(token, `clip${i}`, i % 2 === 0 ? ["偶数"] : []);
    }
    vi.useRealTimers();

    const first = await (await call("/api/feed?limit=2")).json() as { clips: { title: string }[]; next_cursor: string };
    expect(first.clips.map((clip) => clip.title)).toEqual(["clip4", "clip3"]);
    const second = await (await call(`/api/feed?limit=2&cursor=${first.next_cursor}`)).json() as { clips: { title: string }[]; next_cursor: string };
    expect(second.clips.map((clip) => clip.title)).toEqual(["clip2", "clip1"]);
    const third = await (await call(`/api/feed?limit=2&cursor=${second.next_cursor}`)).json() as { clips: { title: string }[]; next_cursor: string | null };
    expect(third.clips.map((clip) => clip.title)).toEqual(["clip0"]);
    expect(third.next_cursor).toBeNull();

    const tagged = await (await call(`/api/feed?tag=${encodeURIComponent("偶数")}`)).json() as { clips: unknown[] };
    expect(tagged.clips).toHaveLength(3);
    const tags = await (await call("/api/tags")).json() as { tags: { name: string; count: number }[] };
    expect(tags.tags).toEqual([{ name: "偶数", count: 3 }]);
  });

  it("再生回数を数え、削除で動画ファイルも消える", async () => {
    const token = await issue();
    const id = await publish(token, "a");
    await call(`/api/clips/${id}/view`, { method: "POST" });
    const clip = await (await call(`/api/clips/${id}`)).json() as { clip: { view_count: number } };
    expect(clip.clip.view_count).toBe(1);

    expect((await call(`/api/clips/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(storage.objects.size).toBe(0);
    expect((await call(`/api/clips/${id}`)).status).toBe(404);
  });

  it("アプリのログインは movieclip:// に JWT を返す", async () => {
    const response = await call("/api/app-auth");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^movieclip:\/\/auth\?token=/);
  });
});

describe("cron", () => {
  it("24時間完了されない投稿を片付ける", async () => {
    const token = await issue();
    const { body } = await uploadClip(token);
    storage.putObject(`clips/${body.clip.id}/video`, 10, "video/mp4");

    expect(await cleanupPending(env.DB, storage, Math.floor(Date.now() / 1000) + 3600)).toBe(0);
    expect(await cleanupPending(env.DB, storage, Math.floor(Date.now() / 1000) + 25 * 3600)).toBe(1);
    expect(storage.objects.size).toBe(0);
    expect((await call(`/api/v1/clips/${body.clip.id}`, { token })).status).toBe(404);
  });
});
