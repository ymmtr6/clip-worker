import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  AGENT_SCOPES,
  generateAgentToken,
  parseAgentToken,
  parseScopes,
  randomHex,
  safeEqual,
  sha256,
  verifyAccessJwt,
  type Scope,
} from "./auth";
import { openApiSpec } from "./openapi";
import { wasabiStorage, type Storage, type WasabiEnv } from "./storage";

export type Env = WasabiEnv & {
  DB: D1Database;
  /** Cloudflare Access のチームドメイン（例: example.cloudflareaccess.com） */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access アプリケーションの AUD タグ */
  ACCESS_AUD?: string;
  /** ローカル開発用（.dev.vars）。ACCESS_AUD が空のときに限り視聴APIを素通しにする */
  DEV_VIEWER_EMAIL?: string;
  /** "true" ならフィードと再生（閲覧系）だけ認証なしで開く。削除とトークン管理は Access のまま */
  PUBLIC_VIEWER?: string;
};

type Principal = {
  /** clips.created_by に残す名前。agent:<トークン名> または viewer:<email> */
  actor: string;
  scopes: Set<Scope>;
  /** Access の JWT。アプリのログイン（/api/app-auth）でそのまま返す */
  jwt?: string;
};

type AppEnv = { Bindings: Env; Variables: { principal: Principal; storage: Storage } };
type C = Context<AppEnv>;

export const LIMITS = {
  videoBytes: 500 * 1024 * 1024,
  posterBytes: 10 * 1024 * 1024,
  title: 200,
  description: 2000,
  tag: 32,
  tags: 10,
  feedPage: 10,
  feedPageMax: 30,
};
/** ボットに渡すアップロード用 URL の有効期限 */
const UPLOAD_TTL_SECONDS = 3600;
/** 再生用 URL の有効期限。ショートを続けて見ている間に切れにくい長さにする */
const PLAY_TTL_SECONDS = 6 * 3600;
/** 完了されないまま残ったアップロード枠を片付けるまでの時間 */
const PENDING_EXPIRE_SECONDS = 24 * 3600;
/** トークンの最終利用日時を書き直す間隔。読むだけのリクエストで D1 に書かないようにする */
const LAST_USED_RESOLUTION_SECONDS = 3600;

const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const POSTER_TYPES = ["image/jpeg", "image/png", "image/webp"];

class ApiError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503, readonly extra: Record<string, unknown> = {}) {
    super(code);
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const iso = (unix: number | null) => (unix === null ? null : new Date(unix * 1000).toISOString());

/** 時刻順に並ぶ ID。先頭が作成時刻なので、同じ秒の中でもおおむね作成順になる */
function newClipId() {
  return `${Date.now().toString(36)}${randomHex(4)}`;
}

const videoKey = (id: string) => `clips/${id}/video`;
const posterKey = (id: string) => `clips/${id}/poster`;

// ---------------------------------------------------------------------------
// 入力の検証

type Part = { url: string } | { content_type: string };

type ClipInput = {
  title: string;
  description: string | null;
  tags: string[];
  source_url: string | null;
  source_title: string | null;
  source_start_seconds: number | null;
  external_id: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video: Part;
  poster: Part | null;
};

function text(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ApiError("invalid_input", 400, { field, reason: "required" });
    return null;
  }
  if (typeof value !== "string") throw new ApiError("invalid_input", 400, { field, reason: "must be a string" });
  const trimmed = value.trim();
  if (required && !trimmed) throw new ApiError("invalid_input", 400, { field, reason: "required" });
  return trimmed ? trimmed.slice(0, max) : null;
}

function num(value: unknown, field: string, integer = false): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ApiError("invalid_input", 400, { field, reason: "must be a non-negative number" });
  }
  return integer ? Math.round(value) : value;
}

function httpsUrl(value: unknown, field: string): string | null {
  const raw = text(value, field, 2000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.toString();
  } catch {}
  throw new ApiError("invalid_input", 400, { field, reason: "must be an https URL" });
}

export function normalizeTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiError("invalid_input", 400, { field: "tags", reason: "must be an array" });
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/^#+/, "").replace(/\s+/g, " ").slice(0, LIMITS.tag);
    if (tag) seen.add(tag);
    if (seen.size >= LIMITS.tags) break;
  }
  return [...seen];
}

function part(value: unknown, field: string, types: string[], required: boolean): Part | null {
  if (value === undefined || value === null) {
    if (required) throw new ApiError("invalid_input", 400, { field, reason: "required" });
    return null;
  }
  if (typeof value !== "object") throw new ApiError("invalid_input", 400, { field, reason: "must be an object" });
  const body = value as { url?: unknown; content_type?: unknown };
  if (body.url !== undefined) return { url: httpsUrl(body.url, `${field}.url`)! };
  const contentType = typeof body.content_type === "string" ? body.content_type.toLowerCase() : "";
  if (!types.includes(contentType)) {
    throw new ApiError("invalid_input", 400, { field: `${field}.content_type`, reason: `one of ${types.join(", ")}` });
  }
  return { content_type: contentType };
}

function parseClipInput(body: unknown): ClipInput {
  if (!body || typeof body !== "object") throw new ApiError("invalid_json", 400);
  const b = body as Record<string, unknown>;
  return {
    title: text(b.title, "title", LIMITS.title, true)!,
    description: text(b.description, "description", LIMITS.description),
    tags: normalizeTags(b.tags),
    source_url: httpsUrl(b.source_url, "source_url"),
    source_title: text(b.source_title, "source_title", LIMITS.title),
    source_start_seconds: num(b.source_start_seconds, "source_start_seconds", true),
    external_id: text(b.external_id, "external_id", 200),
    duration_seconds: num(b.duration_seconds, "duration_seconds"),
    width: num(b.width, "width", true),
    height: num(b.height, "height", true),
    video: part(b.video, "video", VIDEO_TYPES, true)!,
    poster: part(b.poster, "poster", POSTER_TYPES, false),
  };
}

async function readJson(c: C): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("invalid_json", 400);
  }
}

// ---------------------------------------------------------------------------
// D1

type ClipRow = {
  id: string;
  status: "pending" | "ready";
  title: string;
  description: string | null;
  source_url: string | null;
  source_title: string | null;
  source_start_seconds: number | null;
  external_id: string | null;
  video_key: string;
  poster_key: string | null;
  content_type: string;
  size_bytes: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  view_count: number;
  created_by: string;
  created_at: number;
  published_at: number | null;
};

async function findClip(db: D1Database, id: string): Promise<ClipRow | null> {
  return db.prepare("SELECT * FROM clips WHERE id = ?1").bind(id).first<ClipRow>();
}

async function tagsFor(db: D1Database, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const { results } = await db
    .prepare(`SELECT clip_id, tag FROM clip_tags WHERE clip_id IN (${ids.map(() => "?").join(",")}) ORDER BY tag`)
    .bind(...ids)
    .all<{ clip_id: string; tag: string }>();
  for (const row of results ?? []) {
    const list = map.get(row.clip_id);
    if (list) list.push(row.tag);
    else map.set(row.clip_id, [row.tag]);
  }
  return map;
}

function replaceTagsStatements(db: D1Database, id: string, tags: string[]) {
  return [
    db.prepare("DELETE FROM clip_tags WHERE clip_id = ?1").bind(id),
    ...tags.map((tag) => db.prepare("INSERT INTO clip_tags (clip_id, tag) VALUES (?1, ?2)").bind(id, tag)),
  ];
}

/** 視聴用。再生とポスターの署名付き URL を付けて返す */
async function viewerClip(row: ClipRow, tags: string[], storage: Storage) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags,
    source: row.source_url || row.source_title
      ? { url: row.source_url, title: row.source_title, start_seconds: row.source_start_seconds }
      : null,
    duration_seconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    view_count: row.view_count,
    published_at: iso(row.published_at),
    video_url: await storage.presignGet(row.video_key, PLAY_TTL_SECONDS),
    poster_url: row.poster_key ? await storage.presignGet(row.poster_key, PLAY_TTL_SECONDS) : null,
    url_expires_at: iso(nowSeconds() + PLAY_TTL_SECONDS),
  };
}

/** ボット用。状態と自分が付けた external_id を返す */
function agentClip(row: ClipRow, tags: string[]) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    description: row.description,
    tags,
    source_url: row.source_url,
    source_title: row.source_title,
    source_start_seconds: row.source_start_seconds,
    external_id: row.external_id,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    duration_seconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    has_poster: row.poster_key !== null,
    view_count: row.view_count,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    published_at: iso(row.published_at),
  };
}

type Cursor = { p: number; id: string };

function encodeCursor(cursor: Cursor | ShuffleCursor) {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/"))) as Cursor;
    if (typeof parsed.p === "number" && typeof parsed.id === "string") return parsed;
  } catch {}
  throw new ApiError("invalid_cursor", 400);
}

/** 公開順（新しい順）に ready のクリップを seek 方式で返す */
async function listReady(db: D1Database, options: { cursor?: string; tag?: string; limit: number }) {
  const cursor = decodeCursor(options.cursor);
  const where = ["status = 'ready'"];
  const args: (string | number)[] = [];
  if (options.tag) {
    where.push("EXISTS (SELECT 1 FROM clip_tags t WHERE t.clip_id = clips.id AND t.tag = ?)");
    args.push(options.tag);
  }
  if (cursor) {
    where.push("(published_at < ? OR (published_at = ? AND id < ?))");
    args.push(cursor.p, cursor.p, cursor.id);
  }
  const { results } = await db
    .prepare(`SELECT * FROM clips WHERE ${where.join(" AND ")} ORDER BY published_at DESC, id DESC LIMIT ?`)
    .bind(...args, options.limit + 1)
    .all<ClipRow>();
  const rows = results ?? [];
  const page = rows.slice(0, options.limit);
  const tail = page[page.length - 1];
  return {
    rows: page,
    tags: await tagsFor(db, page.map((row) => row.id)),
    nextCursor: rows.length > options.limit && tail ? encodeCursor({ p: tail.published_at!, id: tail.id }) : null,
  };
}

type ShuffleCursor = { seed: number; at: number; offset: number };

/** 32bit の seed から決まった乱数列を作る（mulberry32） */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * シャッフル順。seed と開始時刻をカーソルに入れて、ページをまたいでも同じ並びを保つ
 * （途中で公開されたものは次のシャッフルから混ざる）。
 * 個人用の規模なので、対象の id を全部読んで Worker で並べ替える。
 */
async function listShuffled(db: D1Database, options: { cursor?: string; tag?: string; limit: number }) {
  let cursor: ShuffleCursor = { seed: crypto.getRandomValues(new Uint32Array(1))[0], at: nowSeconds(), offset: 0 };
  if (options.cursor) {
    try {
      cursor = JSON.parse(atob(options.cursor.replace(/-/g, "+").replace(/_/g, "/"))) as ShuffleCursor;
    } catch {
      throw new ApiError("invalid_cursor", 400);
    }
    if (![cursor.seed, cursor.at, cursor.offset].every(Number.isInteger)) throw new ApiError("invalid_cursor", 400);
  }
  const where = ["status = 'ready'", "published_at <= ?"];
  const args: (string | number)[] = [cursor.at];
  if (options.tag) {
    where.push("EXISTS (SELECT 1 FROM clip_tags t WHERE t.clip_id = clips.id AND t.tag = ?)");
    args.push(options.tag);
  }
  const { results } = await db.prepare(`SELECT id FROM clips WHERE ${where.join(" AND ")} ORDER BY id`).bind(...args).all<{ id: string }>();
  const ids = (results ?? []).map((row) => row.id);
  const random = seededRandom(cursor.seed);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const pageIds = ids.slice(cursor.offset, cursor.offset + options.limit);
  const rows = pageIds.length === 0 ? [] : (await db
    .prepare(`SELECT * FROM clips WHERE id IN (${pageIds.map(() => "?").join(",")})`)
    .bind(...pageIds)
    .all<ClipRow>()).results ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const page = pageIds.map((id) => byId.get(id)).filter((row): row is ClipRow => row !== undefined);
  const next = cursor.offset + options.limit;
  return {
    rows: page,
    tags: await tagsFor(db, page.map((row) => row.id)),
    nextCursor: next < ids.length
      ? encodeCursor({ ...cursor, offset: next })
      : null,
  };
}

function pageLimit(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, LIMITS.feedPageMax) : LIMITS.feedPage;
}

// ---------------------------------------------------------------------------
// 取り込み

function mediaType(header: string | null) {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}

/** 拡張子から推測する。配布元が application/octet-stream で返すことがあるため */
function guessType(url: string, types: string[]): string | null {
  const path = new URL(url).pathname.toLowerCase();
  const byExt: Record<string, string> = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  };
  const found = Object.entries(byExt).find(([ext]) => path.endsWith(ext))?.[1];
  return found && types.includes(found) ? found : null;
}

/**
 * ボットが URL だけを持っている場合に、Worker が取ってきて Wasabi に流し込む。
 * メモリに載せないよう、Content-Length が分かるものだけをストリームのまま転送する。
 */
async function copyFromUrl(storage: Storage, url: string, key: string, field: string, types: string[], maxBytes: number) {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch {
    throw new ApiError("source_fetch_failed", 422, { field });
  }
  if (!response.ok || !response.body) throw new ApiError("source_fetch_failed", 422, { field, status: response.status });

  let contentType = mediaType(response.headers.get("content-type"));
  if (!types.includes(contentType)) contentType = guessType(url, types) ?? "";
  if (!contentType) {
    await response.body.cancel();
    throw new ApiError("unsupported_media_type", 422, { field, accepted: types });
  }

  const length = Number(response.headers.get("content-length"));
  if (!Number.isInteger(length) || length <= 0) {
    await response.body.cancel();
    throw new ApiError("source_length_unknown", 422, { field });
  }
  if (length > maxBytes) {
    await response.body.cancel();
    throw new ApiError("too_large", 413, { field, max_bytes: maxBytes });
  }

  await storage.put(key, response.body, length, contentType);
  return contentType;
}

/** 動画の実体を確かめて公開する。ポスターは無ければ外して公開する（無くても再生には困らない） */
async function completeClip(db: D1Database, storage: Storage, row: ClipRow): Promise<ClipRow> {
  if (row.status === "ready") return row;

  const video = await storage.head(row.video_key);
  if (!video || video.size === 0) throw new ApiError("video_not_uploaded", 409);
  if (video.size > LIMITS.videoBytes) {
    await storage.delete(row.video_key);
    throw new ApiError("too_large", 413, { field: "video", max_bytes: LIMITS.videoBytes });
  }

  let poster = row.poster_key;
  if (poster) {
    const head = await storage.head(poster);
    if (!head || head.size === 0 || head.size > LIMITS.posterBytes) {
      if (head) await storage.delete(poster);
      poster = null;
    }
  }

  const now = nowSeconds();
  await db
    .prepare("UPDATE clips SET status = 'ready', size_bytes = ?2, poster_key = ?3, published_at = ?4 WHERE id = ?1 AND status = 'pending'")
    .bind(row.id, video.size, poster, now)
    .run();
  return (await findClip(db, row.id))!;
}

async function createClip(c: C) {
  const input = parseClipInput(await readJson(c));
  const db = c.env.DB;
  const storage = c.get("storage");
  const actor = c.get("principal").actor;

  // 同じ external_id の再送は二重登録しない。公開済みならそのまま返し、未完了なら続きからやり直す
  const existing = input.external_id
    ? await db.prepare("SELECT * FROM clips WHERE created_by = ?1 AND external_id = ?2").bind(actor, input.external_id).first<ClipRow>()
    : null;
  if (existing?.status === "ready") {
    const tags = await tagsFor(db, [existing.id]);
    return c.json({ clip: agentClip(existing, tags.get(existing.id) ?? []), duplicate: true }, 200);
  }

  const id = existing?.id ?? newClipId();
  const keys = { video: videoKey(id), poster: input.poster ? posterKey(id) : null };

  // URL 指定の部分は先に取り込む。失敗したら行を作らない
  let videoType = "content_type" in input.video ? input.video.content_type : "";
  if ("url" in input.video) {
    videoType = await copyFromUrl(storage, input.video.url, keys.video, "video", VIDEO_TYPES, LIMITS.videoBytes);
  }
  let posterType = input.poster && "content_type" in input.poster ? input.poster.content_type : "";
  if (input.poster && "url" in input.poster) {
    posterType = await copyFromUrl(storage, input.poster.url, keys.poster!, "poster", POSTER_TYPES, LIMITS.posterBytes);
  }

  const values = [
    input.title, input.description, input.source_url, input.source_title, input.source_start_seconds,
    keys.video, keys.poster, videoType, input.duration_seconds, input.width, input.height,
  ];
  const upsert = existing
    ? db.prepare(
      `UPDATE clips SET title = ?2, description = ?3, source_url = ?4, source_title = ?5, source_start_seconds = ?6,
         video_key = ?7, poster_key = ?8, content_type = ?9, duration_seconds = ?10, width = ?11, height = ?12
       WHERE id = ?1`,
    ).bind(id, ...values)
    : db.prepare(
      `INSERT INTO clips (id, status, title, description, source_url, source_title, source_start_seconds,
         video_key, poster_key, content_type, duration_seconds, width, height, external_id, created_by, created_at)
       VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    ).bind(id, ...values, input.external_id, actor, nowSeconds());
  await db.batch([upsert, ...replaceTagsStatements(db, id, input.tags)]);

  const uploads: Record<string, { method: "PUT"; url: string; headers: Record<string, string> }> = {};
  if ("content_type" in input.video) {
    uploads.video = { method: "PUT", url: await storage.presignPut(keys.video, videoType, UPLOAD_TTL_SECONDS), headers: { "Content-Type": videoType } };
  }
  if (input.poster && "content_type" in input.poster) {
    uploads.poster = { method: "PUT", url: await storage.presignPut(keys.poster!, posterType, UPLOAD_TTL_SECONDS), headers: { "Content-Type": posterType } };
  }

  let row = (await findClip(db, id))!;
  // すべて URL 指定なら、この場で公開まで済ませる
  if (Object.keys(uploads).length === 0) row = await completeClip(db, storage, row);

  const body = {
    clip: agentClip(row, input.tags),
    ...(Object.keys(uploads).length > 0
      ? { uploads, uploads_expire_at: iso(nowSeconds() + UPLOAD_TTL_SECONDS), complete: `POST /clips/${id}/complete` }
      : {}),
    ...(existing ? { duplicate: true } : {}),
  };
  return c.json(body, existing ? 200 : 201);
}

async function deleteClip(db: D1Database, storage: Storage, row: ClipRow) {
  // 先に S3 を消す。D1 が失敗しても DELETE は冪等なので同じ操作をやり直せる
  await storage.delete(row.video_key);
  if (row.poster_key) await storage.delete(row.poster_key);
  await db.batch([
    db.prepare("DELETE FROM clip_tags WHERE clip_id = ?1").bind(row.id),
    db.prepare("DELETE FROM clips WHERE id = ?1").bind(row.id),
  ]);
}

/** 完了されないまま放置されたアップロード枠を消す（cron） */
export async function cleanupPending(db: D1Database, storage: Storage, now = nowSeconds()) {
  const { results } = await db
    .prepare("SELECT * FROM clips WHERE status = 'pending' AND created_at < ?1 ORDER BY created_at LIMIT 100")
    .bind(now - PENDING_EXPIRE_SECONDS)
    .all<ClipRow>();
  for (const row of results ?? []) {
    // ポスターは pending の間 poster_key に入っていないこともあるので、決まった場所を両方消す
    await deleteClip(db, storage, { ...row, poster_key: posterKey(row.id) });
  }
  return (results ?? []).length;
}

// ---------------------------------------------------------------------------
// 認証

function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Access の JWT。ブラウザは Access が付けるヘッダか cookie、
 * ネイティブアプリは cf-access-token ヘッダで送ってくる（Access もこのヘッダを受け付ける）。
 */
function accessJwt(c: C): string {
  const header = c.req.header("Cf-Access-Jwt-Assertion") ?? c.req.header("cf-access-token");
  if (header) return header;
  const cookie = c.req.header("Cookie") ?? "";
  return /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1] ?? "";
}

const viewerAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { env } = c;
  let email: string | null;
  // 本番は ACCESS_AUD を設定しないと視聴APIが使えないので、DEV_VIEWER_EMAIL を誤って入れても素通しにはならない
  if (env.DEV_VIEWER_EMAIL && !env.ACCESS_AUD) {
    email = env.DEV_VIEWER_EMAIL;
  } else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return c.json({ error: "access_not_configured" }, 503);
    email = await verifyAccessJwt(accessJwt(c), env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  }
  if (!email) return c.json({ error: "unauthorized" }, 401);
  c.set("principal", { actor: `viewer:${email}`, scopes: new Set(AGENT_SCOPES), jwt: accessJwt(c) });
  await next();
};

/** 閲覧系。PUBLIC_VIEWER なら誰でも通し、そうでなければ viewerAuth と同じ */
const readerAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.PUBLIC_VIEWER !== "true") return viewerAuth(c, next);
  c.set("principal", { actor: "viewer:public", scopes: new Set(), jwt: "" });
  await next();
};

type TokenRow = { id: string; name: string; token_hash: string; scopes: string; last_used_at: number | null; revoked_at: number | null };

const agentAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const parsed = parseAgentToken(bearer(c.req.header("Authorization")));
  if (!parsed) return c.json({ error: "unauthorized" }, 401);

  const row = await c.env.DB.prepare("SELECT * FROM agent_tokens WHERE id = ?1").bind(parsed.id).first<TokenRow>();
  if (!row || row.revoked_at !== null || !safeEqual(row.token_hash, await sha256(parsed.secret))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const now = nowSeconds();
  if (!row.last_used_at || now - row.last_used_at >= LAST_USED_RESOLUTION_SECONDS) {
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE agent_tokens SET last_used_at = ?2 WHERE id = ?1").bind(row.id, now).run());
  }
  c.set("principal", { actor: `agent:${row.name}`, scopes: new Set(parseScopes(row.scopes)) });
  await next();
};

function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("principal").scopes.has(scope)) return c.json({ error: "forbidden", required: scope }, 403);
    await next();
  };
}

async function clipOr404(c: C): Promise<ClipRow> {
  const row = await findClip(c.env.DB, c.req.param("id")!);
  if (!row) throw new ApiError("not_found", 404);
  return row;
}

// ---------------------------------------------------------------------------
// ルーティング

export function createApp(makeStorage: (env: Env) => Storage) {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: error.code, ...error.extra }, error.status);
    console.error(error);
    return c.json({ error: "internal_error" }, 500);
  });

  app.use("/api/*", async (c, next) => {
    c.set("storage", makeStorage(c.env));
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/v1/openapi.json", (c) =>
    c.json(openApiSpec(new URL(c.req.url).origin), 200, { "Cache-Control": "public, max-age=300" }));

  // --- ボット用（/api/v1）。Access は Bypass にして、ここでトークンを確かめる
  const agent = new Hono<AppEnv>();
  agent.use("*", agentAuth);

  agent.get("/me", (c) => {
    const principal = c.get("principal");
    return c.json({ actor: principal.actor, scopes: [...principal.scopes], limits: { video_bytes: LIMITS.videoBytes, poster_bytes: LIMITS.posterBytes } });
  });

  agent.get("/clips", requireScope("read"), async (c) => {
    const result = await listReady(c.env.DB, { cursor: c.req.query("cursor"), tag: c.req.query("tag"), limit: pageLimit(c.req.query("limit")) });
    return c.json({
      clips: result.rows.map((row) => agentClip(row, result.tags.get(row.id) ?? [])),
      next_cursor: result.nextCursor,
    });
  });

  agent.post("/clips", requireScope("clips:write"), createClip);

  agent.get("/clips/:id", requireScope("read"), async (c) => {
    const row = await clipOr404(c);
    const tags = await tagsFor(c.env.DB, [row.id]);
    return c.json({ clip: agentClip(row, tags.get(row.id) ?? []) });
  });

  agent.post("/clips/:id/complete", requireScope("clips:write"), async (c) => {
    const row = await completeClip(c.env.DB, c.get("storage"), await clipOr404(c));
    const tags = await tagsFor(c.env.DB, [row.id]);
    return c.json({ clip: agentClip(row, tags.get(row.id) ?? []) });
  });

  agent.patch("/clips/:id", requireScope("clips:write"), async (c) => {
    const row = await clipOr404(c);
    const body = (await readJson(c)) as Record<string, unknown>;
    const db = c.env.DB;
    const statements: D1PreparedStatement[] = [];
    const fields: [string, unknown][] = [];
    if ("title" in body) fields.push(["title", text(body.title, "title", LIMITS.title, true)]);
    if ("description" in body) fields.push(["description", text(body.description, "description", LIMITS.description)]);
    if ("source_url" in body) fields.push(["source_url", httpsUrl(body.source_url, "source_url")]);
    if ("source_title" in body) fields.push(["source_title", text(body.source_title, "source_title", LIMITS.title)]);
    if ("source_start_seconds" in body) fields.push(["source_start_seconds", num(body.source_start_seconds, "source_start_seconds", true)]);
    if (fields.length > 0) {
      statements.push(db.prepare(`UPDATE clips SET ${fields.map(([name], i) => `${name} = ?${i + 2}`).join(", ")} WHERE id = ?1`)
        .bind(row.id, ...fields.map(([, value]) => value)));
    }
    if ("tags" in body) statements.push(...replaceTagsStatements(db, row.id, normalizeTags(body.tags)));
    if (statements.length > 0) await db.batch(statements);

    const updated = (await findClip(db, row.id))!;
    const tags = await tagsFor(db, [row.id]);
    return c.json({ clip: agentClip(updated, tags.get(row.id) ?? []) });
  });

  agent.delete("/clips/:id", requireScope("clips:delete"), async (c) => {
    const row = await findClip(c.env.DB, c.req.param("id"));
    // 応答を受け取れずに再送された場合も成功として扱う
    if (!row) return c.json({ ok: true, already_deleted: true });
    await deleteClip(c.env.DB, c.get("storage"), row);
    return c.json({ ok: true });
  });

  app.route("/api/v1", agent);

  // --- 視聴者用（Web とアプリ）。閲覧系は readerAuth、それ以外は Access を通った人だけ
  const viewer = new Hono<AppEnv>();
  for (const [method, path] of [["GET", "/feed"], ["GET", "/tags"], ["GET", "/clips/:id"], ["POST", "/clips/:id/view"]] as const) {
    viewer.on(method, path, readerAuth);
  }
  viewer.use("*", async (c, next) => (c.get("principal") ? next() : viewerAuth(c, next)));

  // アプリのログイン用。Google は WebView 内の OAuth を拒否するため、アプリは
  // ASWebAuthenticationSession / Custom Tabs でここを開いて Access を通り、JWT を受け取る
  viewer.get("/app-auth", (c) => {
    const jwt = c.get("principal").jwt || "dev";
    return c.redirect(`movieclip://auth?token=${encodeURIComponent(jwt)}`, 302);
  });

  viewer.get("/me", (c) => c.json({ actor: c.get("principal").actor }));

  // order=shuffle でシャッフル、それ以外は新着順
  viewer.get("/feed", async (c) => {
    const options = { cursor: c.req.query("cursor"), tag: c.req.query("tag"), limit: pageLimit(c.req.query("limit")) };
    const result = c.req.query("order") === "shuffle" ? await listShuffled(c.env.DB, options) : await listReady(c.env.DB, options);
    const storage = c.get("storage");
    const clips = await Promise.all(result.rows.map((row) => viewerClip(row, result.tags.get(row.id) ?? [], storage)));
    return c.json({ clips, next_cursor: result.nextCursor }, 200, { "Cache-Control": "no-store" });
  });

  viewer.get("/tags", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT t.tag AS name, COUNT(*) AS count FROM clip_tags t JOIN clips ON clips.id = t.clip_id
        WHERE clips.status = 'ready' GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 100`,
    ).all<{ name: string; count: number }>();
    return c.json({ tags: results ?? [] });
  });

  // 単体の取り直し。再生 URL が切れたときにアプリが呼ぶ
  viewer.get("/clips/:id", async (c) => {
    const row = await clipOr404(c);
    if (row.status !== "ready") throw new ApiError("not_found", 404);
    const tags = await tagsFor(c.env.DB, [row.id]);
    return c.json({ clip: await viewerClip(row, tags.get(row.id) ?? [], c.get("storage")) }, 200, { "Cache-Control": "no-store" });
  });

  viewer.post("/clips/:id/view", async (c) => {
    const result = await c.env.DB.prepare("UPDATE clips SET view_count = view_count + 1 WHERE id = ?1 AND status = 'ready'")
      .bind(c.req.param("id")).run();
    if ((result.meta?.changes ?? 0) < 1) throw new ApiError("not_found", 404);
    return c.json({ ok: true });
  });

  viewer.delete("/clips/:id", async (c) => {
    const row = await findClip(c.env.DB, c.req.param("id"));
    if (!row) return c.json({ ok: true, already_deleted: true });
    await deleteClip(c.env.DB, c.get("storage"), row);
    return c.json({ ok: true });
  });

  // ボット用トークンの発行・失効。平文は発行時に一度だけ返す
  viewer.get("/admin/tokens", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, name, scopes, created_at, last_used_at, revoked_at FROM agent_tokens ORDER BY created_at DESC",
    ).all<Omit<TokenRow, "token_hash"> & { created_at: number }>();
    return c.json({
      tokens: (results ?? []).map((row) => ({
        ...row,
        scopes: parseScopes(row.scopes),
        created_at: iso(row.created_at),
        last_used_at: iso(row.last_used_at),
        revoked_at: iso(row.revoked_at),
      })),
    });
  });

  viewer.post("/admin/tokens", async (c) => {
    const body = (await readJson(c)) as { name?: unknown; scopes?: unknown };
    const name = text(body.name, "name", 64, true)!;
    const scopes = parseScopes(body.scopes ?? AGENT_SCOPES);
    if (scopes.length === 0) throw new ApiError("invalid_input", 400, { field: "scopes", reason: `subset of ${AGENT_SCOPES.join(", ")}` });
    const { id, secret, token } = generateAgentToken();
    await c.env.DB.prepare("INSERT INTO agent_tokens (id, name, token_hash, scopes, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, name, await sha256(secret), scopes.join(","), nowSeconds()).run();
    return c.json({ id, name, scopes, token }, 201);
  });

  viewer.delete("/admin/tokens/:id", async (c) => {
    const result = await c.env.DB.prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL")
      .bind(c.req.param("id"), nowSeconds()).run();
    if ((result.meta?.changes ?? 0) < 1) throw new ApiError("not_found", 404);
    return c.json({ ok: true });
  });

  app.route("/api", viewer);

  return app;
}

export const app = createApp(wasabiStorage);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupPending(env.DB, wasabiStorage(env)).then((count) => {
      if (count > 0) console.log(JSON.stringify({ event: "pending_cleaned", count }));
    }));
  },
} satisfies ExportedHandler<Env>;
